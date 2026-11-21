/* MDReader — éditeur intégré (application Windows uniquement).
 *
 * Deux surfaces d'édition remplacent le contenu du lecteur :
 *   - « Rendu » (#ed) : WYSIWYG. Chaque bloc de premier niveau garde, tant qu'il n'est pas
 *     modifié, sa source Markdown exacte (attribut data-b) ; seuls les blocs touchés sont
 *     réécrits à l'enregistrement.
 *   - « Source » (#raw) : le texte brut (Markdown, ou fichier .txt).
 * L'hôte (Rust) fait le Markdown -> HTML ; le HTML -> Markdown est fait ici.
 */
(() => {
  'use strict';
  const B = window.__BOOT || {}, app = window.app;
  if (!B.edit || !app || !app._) return;
  const { $, $$, send, toast, closePop, barH, prefs, savePrefs } = app._;

  if (!B.hasDoc) {
    app.onKey = (e, c, lk) => {
      if (c && !e.altKey && lk === 'n') { e.preventDefault(); send({ cmd: 'new' }); return true; }
      return false;
    };
    return;
  }

  const MD = B.edit.kind !== 'txt';
  const content = $('#content'), toc = $('#toc'), body = document.body;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const el = (tag, attrs, html) => {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  };
  const ZW = '\u200b';

  /* ---------------- Requests to the host ---------------- */
  let rid = 0;
  const waiting = new Map();
  const ask = (cmd, extra) => new Promise(res => { const id = ++rid; waiting.set(id, res); send(Object.assign({ cmd, id }, extra)); });
  app._reply = (id, v) => { const f = waiting.get(id); waiting.delete(id); if (f) f(v); };
  // The host keeps the answer (possibly several MB of JSON) for the page to fetch.
  app._replyAt = id => fetch('/__mdr/reply/' + id).then(r => r.json()).then(v => app._reply(id, v), () => app._reply(id, {}));

  /* ---------------- State ---------------- */
  const S = {
    mode: 'read',                                  // 'read' | 'edit'
    view: MD && prefs.edView !== 'raw' ? 'rich' : 'raw',
    text: null,                                    // the document, when no surface is ahead of it
    stale: false,                                  // the shown surface has edits not yet in S.text
    richText: null, rawText: null,                 // text each surface was last in sync with
    readerText: null,                              // text the reader's DOM shows
    dirty: false, busy: false,
  };
  let readerNodes = null, readerToc = '';

  /* =====================================================================
   *  HTML -> Markdown
   * ===================================================================== */
  const BLOCK = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|TABLE|HR|DL|DETAILS|FIGURE|SECTION|ARTICLE)$/;
  const ALERTS = ['note', 'tip', 'important', 'warning', 'caution'];

  function escText(t, ctx) {
    t = t.replace(/\u200b/g, '')
      .replace(/\u00a0/g, (m, i, s) => {
        const a = s[i - 1], b = s[i + 1];
        return (b && /[:;!?»%€]/.test(b)) || a === '«' || (/\d/.test(a || '') && /\d/.test(b || '')) ? m : ' ';
      })
      .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
      .replace(/[*`]/g, '\\$&')
      .replace(/_/g, (m, i, s) => (/[\p{L}\p{N}]/u.test(s[i - 1] || '') && /[\p{L}\p{N}]/u.test(s[i + 1] || '') ? m : '\\_'))
      .replace(/\[(?=\^)|\[(?=[^\]\n]*\][([:])/g, '\\[')
      .replace(/<(?=[a-zA-Z/!?])/g, '\\<')
      .replace(/&(?=#?\w+;)/g, '\\&')
      .replace(/\$/g, '\\$')
      .replace(/~~/g, '\\~~');
    if (ctx.table) t = t.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return t;
  }
  // Characters that would start a block if they began a line of plain text.
  function escLine(l) {
    return l
      .replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')
      .replace(/^(\s*)([-+])(?=\s|$)/, '$1\\$2')
      .replace(/^(\s*)([-=])(?=[-=]*\s*$)/, '$1\\$2')
      .replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2')
      .replace(/^(\s*)>/, '$1\\>')
      .replace(/^(\s*):(?=\s)/, '$1\\:')
      .replace(/^(\s*)\|/, '$1\\|');
  }
  function codeSpan(t) {
    t = t.replace(/\u200b/g, '').replace(/\n/g, ' ');
    let n = 0; for (const m of t.matchAll(/`+/g)) n = Math.max(n, m[0].length);
    const f = '`'.repeat(n + 1), pad = /^`|`$/.test(t) || (/^ .* $/.test(t) && t.trim()) ? ' ' : '';
    return f + pad + t + pad + f;
  }
  function wrapMd(delim, key, node, ctx) {
    if (ctx[key]) return inlineMd(node, ctx);
    const inner = inlineMd(node, Object.assign({}, ctx, { [key]: 1 }));
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    return m[2] ? m[1] + delim + m[2] + delim + m[3] : inner;
  }
  const texOf = n => (n.dataset.tex != null ? n.dataset.tex : n.textContent).trim();
  function linkDest(u) { return /[\s()<>]/.test(u) ? '<' + u.replace(/[<>]/g, encodeURIComponent) + '>' : u; }
  function linkTitle(t) { return t ? ' "' + t.replace(/"/g, '\\"') + '"' : ''; }

  function inlineMd(node, ctx) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += ctx.code ? n.data : escText(n.data, ctx); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'BR') {
        // A <br> that only keeps an empty line open is not a line break.
        let nx = n.nextSibling; while (nx && nx.nodeType === 3 && !nx.data.replace(/[\u200b\s]/g, '')) nx = nx.nextSibling;
        if (nx) out += ctx.table ? '<br>' : '\\\n';
        continue;
      }
      if (tag === 'STRONG' || tag === 'B') out += wrapMd('**', 'b', n, ctx);
      else if (tag === 'EM' || tag === 'I') out += wrapMd('*', 'i', n, ctx);
      else if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') out += wrapMd('~~', 's', n, ctx);
      else if (tag === 'U') { const t = inlineMd(n, ctx); out += t.trim() ? '<u>' + t + '</u>' : t; }
      else if (tag === 'CODE') out += n.textContent.replace(/\u200b/g, '') ? codeSpan(n.textContent) : '';
      else if (tag === 'A') {
        const href = n.getAttribute('href') || '', t = inlineMd(n, ctx);
        if (!t.trim()) continue;
        if (/^[a-z][\w+.-]*:\/\/\S+$/i.test(href) && n.textContent === href && !n.title) out += '<' + href + '>';
        else out += '[' + t + '](' + linkDest(href) + linkTitle(n.getAttribute('title')) + ')';
      }
      else if (tag === 'IMG') out += '![' + escText(n.getAttribute('alt') || '', ctx) + '](' + linkDest(n.getAttribute('src') || '') + linkTitle(n.getAttribute('title')) + ')';
      else if (tag === 'SUP' && n.classList.contains('footnote-reference')) {
        const a = n.querySelector('a');
        out += '[^' + decodeURIComponent(((a && a.getAttribute('href')) || '#' + n.textContent).slice(1)) + ']';
      }
      else if (n.classList.contains('math')) { const d = n.classList.contains('math-display') ? '$$' : '$'; out += d + texOf(n) + d; }
      else if (tag === 'INPUT') continue;
      else if (tag === 'SPAN' || tag === 'FONT' || BLOCK.test(tag)) out += inlineMd(n, ctx);
      else if (/^(SUB|SUP|MARK|KBD|SMALL|ABBR|INS|CITE|Q|VAR|SAMP)$/.test(tag)) { const t = tag.toLowerCase(); out += '<' + t + '>' + inlineMd(n, ctx) + '</' + t + '>'; }
      else out += n.outerHTML;
    }
    return out;
  }
  const paraMd = (node, ctx) => inlineMd(node, ctx).replace(/[ \t]+\n/g, '\n').replace(/\\\n\n+/g, '\\\n').trim().split('\n').map(escLine).join('\n');
  const indent = (s, pad) => s.split('\n').map((l, i) => (i && l ? pad + l : l)).join('\n');

  // Blocks of a container that may mix inline content and block elements (li, blockquote…).
  function childBlocks(node, ctx) {
    const out = [];
    let run = null;
    const flush = () => { if (run) { const t = paraMd(run, ctx); if (t) out.push({ md: t, tag: 'P' }); run = null; } };
    for (const n of node.childNodes) {
      if (n.nodeType === 1 && BLOCK.test(n.tagName)) {
        flush();
        const md = blockMd(n, ctx);
        if (md) out.push({ md, tag: n.tagName });
      } else if (n.nodeType === 1 || n.nodeType === 3) {
        if (n.nodeType === 1 && n.tagName === 'INPUT' && n.type === 'checkbox') continue;
        if (!run) run = document.createDocumentFragment();
        run.appendChild(n.cloneNode(true));
      }
    }
    flush();
    return out;
  }
  const joinBlocks = bl => bl.map(b => b.md).join('\n\n');

  function listMd(list, ctx) {
    const ordered = list.tagName === 'OL';
    let num = parseInt(list.getAttribute('start'), 10); if (!(num >= 0)) num = 1;
    const loose = !!list.querySelector(':scope > li > p');
    const items = [];
    for (const li of list.children) {
      if (/^[UO]L$/.test(li.tagName)) {       // Chromium nests lists directly in lists
        const sub = listMd(li, ctx);
        if (items.length) items[items.length - 1] += '\n' + sub.split('\n').map(l => (l ? '  ' + (ordered ? ' ' : '') + l : l)).join('\n');
        else items.push(sub);
        continue;
      }
      if (li.tagName !== 'LI') continue;
      let marker = ordered ? (num++) + '. ' : '- ';
      const pad = ' '.repeat(marker.length);
      const box = li.querySelector(':scope > input[type=checkbox], :scope > p:first-child > input[type=checkbox]');
      if (box) marker += box.hasAttribute('checked') || box.checked ? '[x] ' : '[ ] ';
      const bl = childBlocks(li, ctx);
      let t = '';
      bl.forEach((b, i) => { t += (i ? (!loose && /^(UL|OL|BLOCKQUOTE|PRE)$/.test(b.tag) ? '\n' : '\n\n') : '') + b.md; });
      items.push(marker + indent(t, pad));
    }
    return items.join(loose ? '\n\n' : '\n');
  }

  function tableMd(table, ctx) {
    const rows = [...table.rows];
    if (!rows.length) return '';
    const c = Object.assign({}, ctx, { table: 1 });
    const cell = td => inlineMd(td, c).replace(/\s*\n\s*/g, ' ').trim() || ' ';
    const cols = Math.max(...rows.map(r => r.cells.length));
    const line = r => '| ' + Array.from({ length: cols }, (_, i) => (r.cells[i] ? cell(r.cells[i]) : ' ')).join(' | ') + ' |';
    const al = Array.from({ length: cols }, (_, i) => {
      const h = rows[0].cells[i], a = h ? (h.style.textAlign || h.getAttribute('align') || '') : '';
      return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
    });
    return [line(rows[0]), '| ' + al.join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n');
  }

  function fenceMd(text, lang) {
    let n = 2; for (const m of text.matchAll(/`+/g)) n = Math.max(n, m[0].length);
    const f = '`'.repeat(n + 1);
    return f + lang + '\n' + text + (text === '' || text.endsWith('\n') ? '' : '\n') + f;
  }

  function blockMd(n, ctx) {
    ctx = ctx || {};
    if (n.nodeType === 3) return paraMd({ childNodes: [n] }, ctx);
    if (n.nodeType !== 1) return '';
    const tag = n.tagName, cl = n.classList;
    if (cl.contains('rawblock')) return n.textContent.replace(/\s+$/, '');
    if (cl.contains('htmlblock')) return n.dataset.md != null ? n.dataset.md : n.innerHTML.trim();
    if (cl.contains('cb')) { const pre = n.querySelector('pre'); return fenceMd(plainText(pre), (n.dataset.lang || '').trim()); }
    if (cl.contains('footnote-definition')) {
      const label = n.id || (n.querySelector('.footnote-definition-label') || {}).textContent || '1';
      const c = n.cloneNode(true); const l = c.querySelector('.footnote-definition-label'); if (l) l.remove();
      return '[^' + label + ']: ' + indent(joinBlocks(childBlocks(c, ctx)), '    ');
    }
    if (tag === 'P' || (tag === 'DIV' && !cl.length)) {
      const only = n.children.length === 1 && n.firstElementChild.classList.contains('math-display') && !n.textContent.replace(n.firstElementChild.textContent, '').trim();
      if (only) return '$$\n' + texOf(n.firstElementChild) + '\n$$';
      if (tag === 'DIV' && n.querySelector('p,div,ul,ol,table,pre,blockquote,h1,h2,h3,h4,h5,h6')) return joinBlocks(childBlocks(n, ctx));
      return paraMd(n, ctx);
    }
    if (/^H[1-6]$/.test(tag)) { const t = inlineMd(n, ctx).replace(/\\?\n/g, ' ').trim(); return t ? '#'.repeat(+tag[1]) + ' ' + t : ''; }
    if (tag === 'UL' || tag === 'OL') return listMd(n, ctx);
    if (tag === 'LI') return '- ' + indent(joinBlocks(childBlocks(n, ctx)), '  ');
    if (tag === 'BLOCKQUOTE') {
      let inner = joinBlocks(childBlocks(n, ctx));
      const kind = ALERTS.find(a => cl.contains('markdown-alert-' + a));
      if (kind) inner = '[!' + kind.toUpperCase() + ']' + (inner ? '\n' + inner : '');
      return inner.split('\n').map(l => (l ? '> ' + l : '>')).join('\n');
    }
    if (tag === 'PRE') { const c = n.querySelector('code'); return fenceMd(n.textContent.replace(/\n$/, ''), ((c && /language-(\S+)/.exec(c.className)) || [])[1] || ''); }
    if (tag === 'TABLE') return tableMd(n, ctx);
    if (tag === 'DIV' && cl.contains('table-wrap')) { const t = n.querySelector('table'); return t ? tableMd(t, ctx) : ''; }
    if (tag === 'HR') return '---';
    if (tag === 'DL') {
      const out = [];
      for (const c of n.children) {
        if (c.tagName === 'DT') out.push((out.length ? '\n' : '') + paraMd(c, ctx));
        else if (c.tagName === 'DD') out.push(': ' + indent(joinBlocks(childBlocks(c, ctx)), '  '));
      }
      return out.join('\n');
    }
    if (tag === 'DIV') return joinBlocks(childBlocks(n, ctx));
    if (!BLOCK.test(tag)) return paraMd({ childNodes: [n] }, ctx);
    return n.outerHTML;
  }

  /* =====================================================================
   *  Plain-text surfaces (#raw and the <pre> of code blocks)
   *  Line breaks typed by the user are <br> elements; a final <br> only keeps the last
   *  empty line open.
   * ===================================================================== */
  const CHUNK = 80;       // lines per chunk of a long source (each chunk is laid out on demand)
  // What a plain-text surface holds, in order: [node, length, isChunkBoundary]. A text node
  // counts its characters, a <br> one line break (none when it only keeps the last line
  // open) and the boundary between two chunks (<div class="rl">) one line break.
  function toks(root) {
    const out = [];
    const walk = nodes => {
      const start = out.length;
      for (const top of nodes) {
        if (top.nodeType === 3) { if (top.data) out.push([top, top.data.length]); continue; }
        if (top.nodeType !== 1) continue;
        if (top.tagName === 'BR') { out.push([top, 1]); continue; }
        const w = document.createTreeWalker(top, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        let n;
        while ((n = w.nextNode())) { if (n.nodeType === 3) { if (n.data) out.push([n, n.data.length]); } else if (n.tagName === 'BR') out.push([n, 1]); }
      }
      const last = out[out.length - 1];
      if (out.length > start && last[0].nodeType === 1) last[1] = 0;
    };
    const kids = [...root.childNodes];
    if (!kids.some(c => c.nodeType === 1 && c.tagName === 'DIV')) { walk(kids); return out; }
    let run = [], first = true;
    const group = nodes => { if (!first) out.push([nodes[0], 1, true]); first = false; walk(nodes); };
    const flushRun = () => { if (run.some(n => n.nodeType === 1 || n.data)) group(run); run = []; };
    for (const c of kids) {
      if (c.nodeType === 1 && c.tagName === 'DIV') { flushRun(); group([c]); } else run.push(c);
    }
    flushRun();
    return out;
  }
  function plainText(root) {
    let s = '';
    for (const [n, l, sep] of toks(root)) s += sep ? '\n' : n.nodeType === 3 ? n.data : l ? '\n' : '';
    return s;
  }
  function setPlain(root, text, chunked) {
    const fill = (node, t) => { node.textContent = t; if (t === '' || t.endsWith('\n')) node.appendChild(document.createElement('br')); };
    if (!chunked || text.length < 30000) return fill(root, text);
    const lines = text.split('\n'), frag = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i += CHUNK) { const d = document.createElement('div'); d.className = 'rl'; fill(d, lines.slice(i, i + CHUNK).join('\n')); frag.appendChild(d); }
    root.replaceChildren(frag);
  }
  // Selection <-> character offsets in a plain-text surface.
  function plainOffset(root, node, off) {
    const r = document.createRange();
    try { r.setStart(node, off); } catch (e) { return 0; }
    let pos = 0;
    for (const [n, l, sep] of toks(root)) {
      if (sep) { if (r.comparePoint(n, 0) > 0) break; pos += 1; continue; }
      if (n === node && n.nodeType === 3) return pos + Math.min(off, l);
      const end = n.nodeType === 3 ? r.comparePoint(n, n.data.length) : r.comparePoint(n.parentNode, [...n.parentNode.childNodes].indexOf(n) + 1);
      if (end > 0) break;
      pos += l;
    }
    return pos;
  }
  function plainPoint(root, off) {
    let pos = 0, lastText = null;
    for (const [n, l, sep] of toks(root)) {
      if (sep) { pos += 1; continue; }
      if (n.nodeType === 3) { if (off <= pos + l) return [n, off - pos]; pos += l; lastText = n; }
      else { if (off <= pos) return [n.parentNode, [...n.parentNode.childNodes].indexOf(n)]; pos += l; }
    }
    if (lastText && lastText.parentNode.lastChild === lastText) return [lastText, lastText.data.length];
    const end = root.lastChild && root.lastChild.nodeType === 1 && root.lastChild.tagName === 'DIV' ? root.lastChild : root;
    return [end, end.childNodes.length];
  }
  function plainSel(root) {
    const s = getSelection();
    if (!s.rangeCount || !root.contains(s.anchorNode)) return null;
    const r = s.getRangeAt(0);
    return [plainOffset(root, r.startContainer, r.startOffset), plainOffset(root, r.endContainer, r.endOffset)];
  }
  function setPlainSel(root, a, b) {
    const r = document.createRange(), p = plainPoint(root, a), q = b == null || b === a ? p : plainPoint(root, b);
    r.setStart(p[0], p[1]); r.setEnd(q[0], q[1]);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }

  /* =====================================================================
   *  Undo history (one per surface): snapshots taken when typing pauses and around
   *  every command. The browser's own undo stack is never used.
   * ===================================================================== */
  function History(take, same, restore) {
    let stack = [], i = -1, t = null, burst = 0;
    const H = {
      reset() { clearTimeout(t); t = null; stack = [take()]; i = 0; },
      commit() {
        clearTimeout(t); t = null;
        const s = take();
        if (i >= 0 && same(stack[i], s)) { stack[i].sel = s.sel; return false; }
        stack.length = i + 1; stack.push(s); i++;
        if (stack.length > 400) { stack.shift(); i--; }
        return true;
      },
      // Typing: group keystrokes, cut a step at pauses and every couple of seconds.
      touch() {
        const now = Date.now();
        if (!t) burst = now;
        clearTimeout(t);
        if (now - burst > 2500) { H.commit(); return; }
        t = setTimeout(H.commit, 450);
      },
      // Called before a change: remember where the caret was in the current state.
      mark() { if (!t && i >= 0) { const s = H.selNow(); if (s) stack[i].sel = s; } },
      selNow: null,
      undo() { H.commit(); if (i <= 0) return false; i--; restore(stack[i]); return true; },
      redo() { H.commit(); if (i >= stack.length - 1) return false; i++; restore(stack[i]); return true; },
    };
    return H;
  }

  /* =====================================================================
   *  Source / plain-text surface
   * ===================================================================== */
  const raw = el('pre', { id: 'raw', contenteditable: 'plaintext-only', spellcheck: MD ? 'false' : 'true' });
  if (!MD) raw.classList.add('txt');
  const HR = History(
    () => ({ text: plainText(raw), sel: plainSel(raw) }),
    (a, b) => a.text === b.text,
    s => { setPlain(raw, s.text, true); if (s.sel) setPlainSel(raw, s.sel[0], s.sel[1]); afterEdit(); },
  );
  HR.selNow = () => plainSel(raw);
  // Replacing a selection, a new line, a paste: each starts a new undo step.
  const stepBefore = e => /^(insertParagraph|insertLineBreak|insertFromPaste|insertFromDrop|deleteByCut|deleteByDrag)$/.test(e.inputType) || !getSelection().isCollapsed;
  raw.addEventListener('beforeinput', e => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); e.inputType === 'historyUndo' ? undo() : redo(); return; }
    if (stepBefore(e)) HR.commit();
    HR.mark();
  });
  raw.addEventListener('input', () => { afterEdit(); HR.touch(); });
  raw.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) { e.preventDefault(); document.execCommand('insertText', false, MD ? '    ' : '\t'); }
  });
  // Replace [a, b) of the source, as one typed edit.
  function rawReplace(a, b, text, selA, selB) {
    raw.focus();
    HR.commit();
    setPlainSel(raw, a, b);
    if (text) document.execCommand('insertText', false, text); else if (b > a) document.execCommand('delete');
    if (selA != null) setPlainSel(raw, selA, selB == null ? selA : selB);
    HR.commit();
  }

  /* =====================================================================
   *  WYSIWYG surface
   * ===================================================================== */
  const ed = el('div', { id: 'ed', contenteditable: 'true', spellcheck: 'true' });
  const SRC = new Map();        // data-b id -> { src, tail } of untouched blocks
  let head = '', nextId = 1;
  const HC = new WeakMap();     // block element -> its outerHTML (history snapshots)

  // The blocks of the document are grouped in <section class="esec"> (laid out on demand,
  // like the reader's): typing stays instant in very long documents.
  const SEC_MAX = 40;
  const isSec = n => n && n.nodeType === 1 && n.parentNode === ed && n.classList.contains('esec');
  const newSec = () => el('section', { class: 'esec' });
  const blocks = () => Array.from(ed.querySelectorAll(':scope > .esec > *'));
  const topBlock = n => { while (n && n !== ed && !isSec(n.parentNode)) n = n.parentNode; return n && n !== ed ? n : null; };
  const isTop = n => !!n && isSec(n.parentNode);
  const lastSec = () => (isSec(ed.lastElementChild) ? ed.lastElementChild : ed.appendChild(newSec()));
  const lastBlock = () => { const s = ed.lastElementChild; return isSec(s) ? s.lastElementChild : null; };
  const prevBlock = b => b.previousElementSibling || (isSec(b.parentNode.previousElementSibling) ? b.parentNode.previousElementSibling.lastElementChild : null);

  // Blocks touched by the user lose their data-b: they will be written from the DOM.
  const mo = new MutationObserver(process);
  function process(records) {
    for (const r of records) {
      const n = topBlock(r.target);
      if (!n || n.nodeType !== 1) continue;
      HC.delete(n);
      if (r.type === 'attributes' && (r.attributeName === 'data-b' || r.attributeName === 'data-r')) continue;
      const t = r.target.nodeType === 1 ? r.target : r.target.parentNode;
      const m = t && t.closest && t.closest('.math');
      if (m && !(r.target === m && r.attributeName === 'data-tex')) continue;   // KaTeX rendering
      if (n.hasAttribute('data-b')) n.removeAttribute('data-b');
    }
  }
  const flush = () => process(mo.takeRecords());
  // Changes we make ourselves that are not edits (widgets, rendering).
  function quiet(fn) { flush(); try { return fn(); } finally { for (const r of mo.takeRecords()) { const n = topBlock(r.target); if (n) HC.delete(n); } } }
  mo.observe(ed, { subtree: true, childList: true, characterData: true, attributes: true });

  const CB_HTML = lang => `<input class="cbl nofind" placeholder="langage" spellcheck="false" value="${esc(lang)}"><pre contenteditable="plaintext-only" spellcheck="false"></pre>`;
  function makeCb(text, lang) {
    const cb = el('div', { class: 'cb', contenteditable: 'false', 'data-lang': lang }, CB_HTML(lang));
    setPlain(cb.lastChild, text);
    return cb;
  }

  // Turn the host's HTML into editable widgets, and repair what the browser leaves behind.
  // `scope`: the section being typed in (everything when omitted).
  function fixup(scope) {
    const root = scope && scope.isConnected ? scope : ed;
    quiet(() => {
      // Everything lives in a block, every block in a section.
      const tidy = box => {
        for (const n of [...box.childNodes]) {
          if (n.nodeType === 3) { if (n.data.trim()) { const p = el('p'); n.replaceWith(p); p.appendChild(n); } else n.remove(); }
          else if (n.nodeType !== 1) n.remove();
          else if (n.tagName === 'BR') n.replaceWith(el('p', null, '<br>'));
          else if (box !== ed && n.tagName === 'SECTION') n.replaceWith(...n.childNodes);
        }
      };
      if ([...ed.childNodes].some(n => !isSec(n))) {
        tidy(ed);
        for (const n of [...ed.children]) {
          if (isSec(n)) continue;
          const prev = n.previousElementSibling, next = n.nextElementSibling;
          if (isSec(prev)) prev.appendChild(n); else if (isSec(next)) next.prepend(n); else { const sec = newSec(); n.before(sec); sec.appendChild(n); }
        }
      }
      for (const sec of (root === ed ? [...ed.children] : [root])) {
        if (sec.childNodes.length !== sec.children.length || sec.querySelector(':scope > br, :scope > section')) tidy(sec);
        if (!sec.children.length) { sec.remove(); continue; }
        let big = sec;
        while (big.children.length > SEC_MAX * 3) {       // grown by pasting or typing: cut it
          const rest = newSec();
          big.after(rest); rest.append(...[...big.children].slice(SEC_MAX));
          big = rest;
        }
      }
      for (const pre of $$('pre', root)) {
        if (pre.closest('.cb')) continue;
        const code = pre.querySelector('code');
        const cb = makeCb(pre.textContent.replace(/\n$/, ''), ((code && /language-(\S+)/.exec(code.className)) || [])[1] || '');
        if (pre.hasAttribute('data-b')) cb.setAttribute('data-b', pre.getAttribute('data-b'));
        pre.replaceWith(cb);
      }
      for (const m of $$('.math:not([data-tex])', root)) { m.setAttribute('data-tex', m.textContent.trim()); m.setAttribute('contenteditable', 'false'); }
      for (const c of $$('input[type=checkbox][disabled]', root)) c.removeAttribute('disabled');
      for (const s of $$('.footnote-reference:not([contenteditable]), .footnote-definition-label:not([contenteditable]), .rawblock:not([contenteditable]), .htmlblock:not([contenteditable])', root)) s.setAttribute('contenteditable', 'false');
      for (const w of $$('.table-wrap', root)) { const t = w.querySelector('table'); if (t) { if (w.hasAttribute('data-b')) t.setAttribute('data-b', w.getAttribute('data-b')); w.replaceWith(t); } }
      const last = lastBlock();
      if (!last || !/^(P|H[1-6]|UL|OL|BLOCKQUOTE)$/.test(last.tagName) || last.classList.contains('mathp')) lastSec().appendChild(el('p', null, '<br>'));
    });
  }
  let fixT = 0;
  const fixSoon = () => {
    if (fixT) return;
    fixT = requestAnimationFrame(() => {
      fixT = 0;
      if (S.mode !== 'edit' || S.view !== 'rich') return;
      const r = range(), tb = r && r.collapsed && topBlock(r.startContainer);
      fixup(tb ? tb.parentNode : null);
    });
  };

  function buildRich(r) {
    SRC.clear(); nextId = 1;
    const list = [];
    const add = (src, tail, html) => {
      // Trailing blank lines belong to the gap; link reference definitions get a block of their own.
      const m = /\n*$/.exec(src); tail = src.slice(m.index) + tail; src = src.slice(0, m.index);
      const d = /^(\s*)(\S[\s\S]*?)(\s*)$/.exec(tail);
      list.push({ src, tail: d ? d[1] : tail, html });
      if (d) list.push({ src: d[2], tail: d[3], html: '<div class="rawblock">' + esc(d[2]) + '</div>' });
    };
    head = r.head;
    const hd = /^(\s*)(\S[\s\S]*?)(\s*)$/.exec(head);
    if (hd) { head = hd[1]; list.push({ src: hd[2], tail: hd[3], html: '<div class="rawblock">' + esc(hd[2]) + '</div>' }); }
    for (const b of r.blocks) add(b.src, b.tail, b.html);
    const frag = document.createDocumentFragment(), tpl = document.createElement('template');
    let sec = frag.appendChild(newSec());
    for (const b of list) {
      tpl.innerHTML = b.html.trim();
      let node = tpl.content.childElementCount === 1 && tpl.content.childNodes.length === 1 ? tpl.content.firstElementChild : null;
      if (!node) { node = el('div', { class: 'htmlblock' }); node.appendChild(tpl.content); }
      const id = String(nextId++);
      node.setAttribute('data-b', id);
      SRC.set(id, { src: b.src, tail: b.tail });
      // Same cuts as the reader: before a main heading, and every SEC_MAX blocks.
      if (sec.children.length >= SEC_MAX || (sec.children.length && /^H[1-3]$/.test(node.tagName))) sec = frag.appendChild(newSec());
      sec.appendChild(node);
    }
    quiet(() => { ed.replaceChildren(frag); });
    fixup();
  }

  function serialize() {
    flush();
    const parts = [];
    for (const n of blocks()) {
      const id = n.getAttribute('data-b'), m = id && SRC.get(id);
      if (m) parts.push({ md: m.src, tail: m.tail, clean: true });
      else { const md = blockMd(n); if (md) parts.push({ md }); }
    }
    let out = head;
    parts.forEach((p, i) => {
      const next = parts[i + 1];
      let sep = p.clean ? p.tail : (next ? '\n\n' : '\n');
      if (p.clean && next && !next.clean && !/\n[ \t]*\n/.test(sep)) sep = '\n\n';
      if (p.clean && !next && !sep) sep = '';
      out += p.md + sep;
    });
    return out;
  }

  // ---- selection helpers ----
  const sel = () => getSelection();
  const inEd = n => n && ed.contains(n);
  function range() { const s = sel(); return s.rangeCount && inEd(s.anchorNode) ? s.getRangeAt(0) : null; }
  function setCaret(node, off, endNode, endOff) {
    const r = document.createRange();
    r.setStart(node, off); if (endNode) r.setEnd(endNode, endOff); else r.collapse(true);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
  }
  function caretIn(node, atEnd) {
    const host = node.closest && node.closest('[contenteditable="plaintext-only"]');
    (host || ed).focus({ preventScroll: true });
    const r = document.createRange(); r.selectNodeContents(node); r.collapse(!atEnd);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
  }
  const elOf = n => (n && n.nodeType === 1 ? n : n && n.parentElement);
  // The innermost paragraph-like block around a node.
  const leafBlock = n => { const e = elOf(n); const b = e && e.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,dt,dd,blockquote'); return b && ed.contains(b) && b !== ed ? b : null; };
  function textBefore(block, r) { const x = document.createRange(); x.selectNodeContents(block); x.setEnd(r.startContainer, r.startOffset); return x.toString(); }
  function atStart(block, r) { return r.collapsed && !textBefore(block, r).replace(/\u200b/g, '') && !hasAtomBefore(block, r); }
  function hasAtomBefore(block, r) {
    const x = document.createRange(); x.selectNodeContents(block); x.setEnd(r.startContainer, r.startOffset);
    return !!x.cloneContents().querySelector('img,.math,input,br,.footnote-reference');
  }
  const isEmpty = b => !b.textContent.replace(/[\u200b\s]/g, '') && !b.querySelector('img,.math,input,hr,table,.cb');
  // Run fn, then put the selection back on the same nodes.
  function keepSel(fn, fallback) {
    const s = sel(), a = s.anchorNode, ao = s.anchorOffset, f = s.focusNode, fo = s.focusOffset;
    const res = fn();
    try {
      if (a && a.isConnected && inEd(a) && f && f.isConnected) s.setBaseAndExtent(a, Math.min(ao, len(a)), f, Math.min(fo, len(f)));
      else if (fallback && fallback.isConnected) caretIn(fallback, false);
    } catch (e) { if (fallback && fallback.isConnected) caretIn(fallback, false); }
    return res;
  }
  const len = n => (n.nodeType === 3 ? n.data.length : n.childNodes.length);
  // A position in the text: [index of its block, child indexes down to the node].
  const pathOf = (n, list) => {
    const tb = topBlock(n); if (!tb) return null;
    const p = []; while (n !== tb) { const par = n.parentNode; p.unshift([...par.childNodes].indexOf(n)); n = par; }
    p.unshift(list.indexOf(tb));
    return p;
  };
  const nodeAt = (p, list) => { let n = list[p[0]]; for (let i = 1; n && i < p.length; i++) n = n.childNodes[p[i]]; return n || null; };
  function richSel() {
    const s = sel(); if (!s.rangeCount || !inEd(s.anchorNode) || !inEd(s.focusNode)) return null;
    const list = blocks(), a = pathOf(s.anchorNode, list), f = s.focusNode === s.anchorNode ? a : pathOf(s.focusNode, list);
    return a && f ? { a, ao: s.anchorOffset, f, fo: s.focusOffset } : null;
  }
  function setRichSel(v) {
    if (!v) return;
    const list = blocks(), a = nodeAt(v.a, list), f = nodeAt(v.f, list);
    if (!a || !f) return;
    const host = elOf(a).closest('[contenteditable="plaintext-only"]');
    (host || ed).focus({ preventScroll: true });
    try { sel().setBaseAndExtent(a, Math.min(v.ao, len(a)), f, Math.min(v.fo, len(f))); } catch (e) { }
  }

  const htmlOf = n => { let h = HC.get(n); if (h == null) { h = n.outerHTML; HC.set(n, h); } return h; };
  const HE = History(
    () => { flush(); return { blocks: blocks().map(htmlOf), sel: richSel() }; },
    (a, b) => a.blocks.length === b.blocks.length && a.blocks.every((h, i) => h === b.blocks[i]),
    s => {
      flush();
      const cur = blocks(), ch = cur.map(htmlOf), tg = s.blocks;
      let a = 0; while (a < cur.length && a < tg.length && ch[a] === tg[a]) a++;
      let b = 0; while (b < cur.length - a && b < tg.length - a && ch[cur.length - 1 - b] === tg[tg.length - 1 - b]) b++;
      quiet(() => {
        for (let i = a; i < cur.length - b; i++) cur[i].remove();
        const tpl = document.createElement('template');
        tpl.innerHTML = tg.slice(a, tg.length - b).join('');
        [...tpl.content.children].forEach((n, k) => HC.set(n, tg[a + k]));
        const ref = cur[cur.length - b];
        if (ref) ref.before(tpl.content); else if (a > 0) cur[a - 1].after(tpl.content); else lastSec().appendChild(tpl.content);
      });
      // Typed values live in properties: put them back from the attributes.
      for (const c of $$('.cbl', ed)) c.value = c.getAttribute('value') || '';
      for (const c of $$('input[type=checkbox]', ed)) c.checked = c.hasAttribute('checked');
      fixup();
      setRichSel(s.sel);
      afterEdit();
    },
  );
  HE.selNow = richSel;
  const H = () => (S.view === 'rich' ? HE : HR);
  function undo() { if (!H().undo()) toast('Rien à annuler', 1000); }
  function redo() { if (!H().redo()) toast('Rien à rétablir', 1000); }

  // A command on the WYSIWYG surface: one undo step.
  function cmd(fn) {
    HE.commit();
    const r = fn();
    flush(); fixup();
    HE.commit();
    afterEdit();
    return r;
  }

  /* ---------------- After any edit ---------------- */
  let tocT = 0;
  function afterEdit() {
    S.stale = true;
    if (!S.dirty) setDirty(true);
    clearTimeout(tocT); tocT = setTimeout(() => { updateToc(); stats(); }, 400);
    app._.findReset();
    toolsSoon();
  }
  const stats = () => { if (app.setStats && S.text !== null) { const t = currentText(); app.setStats({ chars: t.length, words: (t.match(/\S+/g) || []).length }); } };
  function setDirty(v) {
    S.dirty = v;
    body.classList.toggle('dirty', v);
    send({ cmd: 'dirty', value: v });
  }
  function currentText() {
    if (S.stale) {
      if (S.view === 'rich') S.text = S.richText = serialize();
      else S.text = S.rawText = plainText(raw);
      S.stale = false;
    }
    return S.text;
  }

  /* ---------------- Table of contents while editing ---------------- */
  function updateToc() {
    if (S.mode !== 'edit') return;
    let items = [], heads = [];
    if (S.view === 'rich') {
      for (const h of $$('h1,h2,h3,h4,h5,h6', ed)) {
        const t = h.textContent.replace(/\u200b/g, '').trim();
        if (t) { items.push([+h.tagName[1], t]); heads.push(h); }
      }
    } else if (MD) {
      const text = plainText(raw);
      let pos = 0, fence = null, prev = '', prevAt = 0;
      const rectAt = at => ({ getBoundingClientRect() { const p = plainPoint(raw, at); const r = document.createRange(); r.setStart(p[0], p[1]); r.setEnd(p[0], Math.min(len(p[0]), p[1] + 1)); return r.getBoundingClientRect(); } });
      for (const line of text.split('\n')) {
        const f = /^ {0,3}(```+|~~~+)/.exec(line);
        if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; }
        else if (!fence) {
          const m = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
          const u = !m && /^ {0,3}(=+|--+)[ \t]*$/.exec(line);
          if (m) { items.push([m[1].length, m[2].replace(/[*_`]/g, '')]); heads.push(rectAt(pos)); }
          else if (u && prev.trim() && !/^\s*([-*+>|#]|\d+[.)])/.test(prev)) { items.push([u[1][0] === '=' ? 1 : 2, prev.trim().replace(/[*_`]/g, '')]); heads.push(rectAt(prevAt)); }
        }
        prev = fence ? '' : line; prevAt = pos;
        pos += line.length + 1;
      }
    }
    toc.innerHTML = items.map(([l, t], i) => `<a href="#" class="t${l}" data-i="${i}">${esc(t)}</a>`).join('');
    app._.initDoc(heads);
  }

  /* =====================================================================
   *  Editing commands (WYSIWYG)
   * ===================================================================== */
  function retag(node, tag, attrs) {
    const n = el(tag, attrs);
    while (node.firstChild) n.appendChild(node.firstChild);
    node.replaceWith(n);
    return n;
  }
  // The paragraph-like siblings covered by the selection.
  function selBlocks() {
    const r = range(); if (!r) return [];
    const a = leafBlock(r.startContainer), b = leafBlock(r.endContainer);
    if (!a) { const t = topBlock(r.startContainer); return t && /^(P|H[1-6])$/.test(t.tagName) ? [t] : []; }
    if (!b || a === b || a.parentNode !== b.parentNode) return [a];
    const out = []; let n = a;
    while (n) { out.push(n); if (n === b) break; n = n.nextElementSibling; }
    return out;
  }
  function setBlock(tag) {
    const bl = selBlocks().filter(b => /^(P|H[1-6])$/.test(b.tagName) && !b.classList.contains('mathp'));
    if (!bl.length) return;
    cmd(() => keepSel(() => { let first; bl.forEach(b => { const n = b.tagName === tag.toUpperCase() ? b : retag(b, tag); first = first || n; }); return first; }, bl[0]));
  }
  const newCheck = on => { const c = el('input', { type: 'checkbox' }); if (on) { c.setAttribute('checked', ''); c.checked = true; } return c; };
  const liCheck = li => li.querySelector(':scope > input[type=checkbox], :scope > p:first-child > input[type=checkbox]');
  function mergeLists(list) {
    const p = list.previousElementSibling, n = list.nextElementSibling;
    if (n && n.tagName === list.tagName && !n.hasAttribute('data-b')) { while (n.firstChild) list.appendChild(n.firstChild); n.remove(); }
    if (p && p.tagName === list.tagName && !p.hasAttribute('data-b')) { while (list.firstChild) p.appendChild(list.firstChild); list.remove(); return p; }
    return list;
  }
  function toggleList(tag, task) {
    const bl = selBlocks(); if (!bl.length) return;
    const lis = bl.map(b => (b.tagName === 'LI' ? b : b.closest('li'))).filter(Boolean);
    cmd(() => keepSel(() => {
      if (lis.length) {
        const list = lis[0].parentNode;
        if (task) {
          const all = lis.every(liCheck);
          lis.forEach(li => { const c = liCheck(li); if (all) { if (c.nextSibling && c.nextSibling.nodeType === 3) c.nextSibling.data = c.nextSibling.data.replace(/^[ \u00a0]/, ''); c.remove(); } else if (!c) (li.firstElementChild && li.firstElementChild.tagName === 'P' ? li.firstElementChild : li).prepend(newCheck(false)); });
          if (list.tagName !== 'UL') retag(list, 'ul');
        } else if (list.tagName === tag.toUpperCase() && !lis.some(liCheck)) {
          // Back to paragraphs: split the list around the selected items.
          const after = el(list.tagName.toLowerCase()); let n = lis[lis.length - 1].nextElementSibling;
          while (n) { const x = n.nextElementSibling; after.appendChild(n); n = x; }
          let ref = list;
          lis.forEach(li => {
            const p = el('p'); const subs = [];
            for (const c of [...li.childNodes]) { if (c.nodeType === 1 && /^(UL|OL)$/.test(c.tagName)) subs.push(c); else if (c.nodeType === 1 && c.tagName === 'P') { while (c.firstChild) p.appendChild(c.firstChild); } else p.appendChild(c); }
            if (!p.firstChild) p.appendChild(el('br'));
            ref.after(p); ref = p; subs.forEach(s => { ref.after(s); ref = s; }); li.remove();
          });
          if (after.children.length) ref.after(after);
          if (!list.children.length) list.remove();
        } else {
          lis.forEach(li => { const c = liCheck(li); if (c) c.remove(); });
          if (list.tagName !== tag.toUpperCase()) retag(list, tag);
        }
        return;
      }
      const list = el(tag);
      bl[0].before(list);
      bl.forEach(b => { const li = el('li'); while (b.firstChild) li.appendChild(b.firstChild); if (task) li.prepend(newCheck(false)); list.appendChild(li); b.remove(); });
      mergeLists(list);
    }, bl[0]));
  }
  function indentLi(li) {
    const prev = li.previousElementSibling; if (!prev || prev.tagName !== 'LI') return;
    let sub = prev.lastElementChild;
    if (!sub || !/^[UO]L$/.test(sub.tagName)) { sub = el(li.parentNode.tagName.toLowerCase()); prev.appendChild(sub); }
    sub.appendChild(li);
  }
  function outdentLi(li) {
    const list = li.parentNode, up = list.parentNode;
    if (up === ed || !/^(LI|UL|OL)$/.test(up.tagName)) return;
    const rest = []; let n = li.nextElementSibling; while (n) { rest.push(n); n = n.nextElementSibling; }
    if (rest.length) { const sub = el(list.tagName.toLowerCase()); rest.forEach(r => sub.appendChild(r)); li.appendChild(sub); }
    (up.tagName === 'LI' ? up : list).after(li);
    if (!list.children.length) list.remove();
  }
  function toggleQuote(kind) {
    const r = range(); if (!r) return;
    const cls = kind ? 'markdown-alert-' + kind : '';
    const cur = elOf(r.startContainer).closest('blockquote');
    cmd(() => keepSel(() => {
      if (cur && ed.contains(cur)) {
        if (cur.className === cls) { while (cur.firstChild) cur.before(cur.firstChild); cur.remove(); }
        else if (cls) cur.className = cls; else cur.removeAttribute('class');
        return;
      }
      const a = topBlock(r.startContainer), b = topBlock(r.endContainer) || a;
      if (!a) return;
      const q = el('blockquote', cls ? { class: cls } : null);
      a.before(q);
      let n = a; while (n) { const x = n.nextSibling; q.appendChild(n); if (n === b) break; n = x; }
    }));
  }
  // Insert a block where the caret is: instead of an empty paragraph, else after the block.
  function insertBlock(node) {
    const r = range();
    const cur = (r && topBlock(r.startContainer)) || lastBlock();
    if (cur && cur.tagName === 'P' && isEmpty(cur) && !cur.classList.contains('mathp')) cur.replaceWith(node);
    else if (cur) cur.after(node); else lastSec().appendChild(node);
    if (!node.nextElementSibling) node.after(el('p', null, '<br>'));
    return node;
  }
  function insertCode(text, lang) {
    const r = range();
    if (text == null && r && !r.collapsed) text = sel().toString();
    return cmd(() => {
      if (r && !r.collapsed) document.execCommand('delete');
      const cb = insertBlock(makeCb(text || '', lang || ''));
      caretIn(cb.lastChild, true);
      return cb;
    });
  }
  function insertHr() { cmd(() => exitAfter(insertBlock(el('hr')))); }
  function mathEl(tex, display) {
    const m = el('span', { class: 'math ' + (display ? 'math-display' : 'math-inline'), contenteditable: 'false', 'data-tex': tex });
    m.textContent = tex;
    return m;
  }
  function insertMath(display, tex) {
    const r = range(); if (!r) return;
    const cur = leafBlock(r.startContainer);
    if (display == null) display = !cur || (cur.tagName === 'P' && isEmpty(cur) && isTop(cur));
    if (tex == null) tex = r.collapsed ? '' : sel().toString().trim();
    const m = cmd(() => {
      const m = mathEl(tex, display);
      if (display) { const p = el('p', { class: 'mathp' }); p.appendChild(m); insertBlock(p); }
      else { r.deleteContents(); r.insertNode(m); m.after(document.createTextNode(ZW)); setCaret(m.nextSibling, 1); }
      quiet(() => app._.renderMath(m));
      return m;
    });
    openMath(m, true);
  }
  function tableEl(rows, cols, headers) {
    const t = el('table');
    const th = Array.from({ length: cols }, (_, i) => '<th>' + (headers && headers[i] ? esc(headers[i]) : '<br>') + '</th>').join('');
    const tr = '<tr>' + '<td><br></td>'.repeat(cols) + '</tr>';
    t.innerHTML = '<thead><tr>' + th + '</tr></thead><tbody>' + tr.repeat(Math.max(1, rows - 1)) + '</tbody>';
    return t;
  }
  function insertTable(rows, cols) {
    cmd(() => { const t = insertBlock(tableEl(rows, cols)); caretIn(t.rows[0].cells[0], false); });
  }
  function insertFootnote() {
    const r = range(); if (!r) return;
    let n = 1;
    for (const x of $$('.footnote-definition', ed)) { const v = parseInt(x.id, 10); if (v >= n) n = v + 1; }
    for (const [, m] of SRC) { const k = /^\[\^(\d+)\]:/.exec(m.src); if (k && +k[1] >= n) n = +k[1] + 1; }
    cmd(() => {
      r.collapse(false);
      const ref = el('sup', { class: 'footnote-reference', contenteditable: 'false' }, `<a href="#${n}">${n}</a>`);
      r.insertNode(ref); ref.after(document.createTextNode(ZW));
      const def = el('div', { class: 'footnote-definition', id: String(n) }, `<sup class="footnote-definition-label" contenteditable="false">${n}</sup><p><br></p>`);
      const last = lastBlock();
      if (last && last.tagName === 'P' && isEmpty(last)) last.before(def); else lastSec().appendChild(def);
      caretIn(def.lastElementChild, false);
      def.scrollIntoView({ block: 'nearest' });
    });
  }
  function fmt(name) {
    const r = range(); if (!r) return;
    if (elOf(r.startContainer).closest('.cb')) return;
    HE.commit();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(name);
    flush(); HE.commit(); afterEdit();
  }
  function toggleCode() {
    const r = range(); if (!r) return;
    const code = elOf(r.startContainer).closest('code');
    cmd(() => {
      if (code && ed.contains(code)) { const t = document.createTextNode(code.textContent); code.replaceWith(t); setCaret(t, 0, t, t.data.length); return; }
      if (r.collapsed) return;
      const c = el('code'); c.textContent = r.toString();
      r.deleteContents(); r.insertNode(c);
      const z = document.createTextNode(ZW); c.after(z);
      setCaret(c.firstChild, 0, c.firstChild, c.firstChild.data.length);
    });
  }

  /* ---------------- Typing rules: Markdown syntax becomes formatting ---------------- */
  const INLINE = [
    [/(?<!`)`([^`]+)`$/, m => { const c = el('code'); c.textContent = m[1]; return c; }],
    [/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, m => { const b = el('strong'); b.textContent = m[1]; return b; }],
    [/(?<![\w_])__([^_\s](?:[^_]*[^_\s])?)__$/, m => { const b = el('strong'); b.textContent = m[1]; return b; }],
    [/(?<![*\\\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/, m => { const b = el('em'); b.textContent = m[1]; return b; }],
    [/(?<![\w_\\])_([^_\s](?:[^_]*[^_\s])?)_$/, m => { const b = el('em'); b.textContent = m[1]; return b; }],
    [/~~([^~\s](?:[^~]*[^~\s])?)~~$/, m => { const b = el('del'); b.textContent = m[1]; return b; }],
    [/(?<![\\$\w])\$([^$\s](?:[^$]*[^$\s])?)\$$/, m => mathEl(m[1], false)],
    [/!\[([^\]]*)\]\(([^)\s]+)\)$/, m => el('img', { src: m[2], alt: m[1] })],
    [/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)$/, m => { const a = el('a', { href: m[2] }); a.textContent = m[1]; return a; }],
  ];
  function typingRules(e) {
    const r = range(); if (!r || !r.collapsed) return;
    const node = r.startContainer, d = e.data || '';
    if (node.nodeType !== 3 || elOf(node).closest('code,pre,.cb,a,.math')) return;
    const block = leafBlock(node); if (!block) return;
    const before = node.data.slice(0, r.startOffset);

    if (d === ' ' && /^(P|LI)$/.test(block.tagName)) {
      const lead = textBefore(block, r).replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
      let act = null, m;
      const plainP = block.tagName === 'P';
      if (plainP && (m = /^(#{1,6}) $/.exec(lead))) act = () => retag(block, 'h' + m[1].length);
      else if (plainP && !block.closest('li') && /^[-*+] $/.test(lead)) act = () => { const l = el('ul'), li = el('li'); block.before(l); while (block.firstChild) li.appendChild(block.firstChild); l.appendChild(li); block.remove(); mergeLists(l); return li; };
      else if (plainP && !block.closest('li') && (m = /^(\d{1,9})[.)] $/.exec(lead))) act = () => { const l = el('ol', +m[1] !== 1 ? { start: m[1] } : null), li = el('li'); block.before(l); while (block.firstChild) li.appendChild(block.firstChild); l.appendChild(li); block.remove(); mergeLists(l); return li; };
      else if (plainP && /^> $/.test(lead)) act = () => { const q = el('blockquote'); block.before(q); q.appendChild(block); return block; };
      else if ((m = /^\[([ xX]?)\] $/.exec(lead)) && (block.tagName === 'LI' || block.closest('li')) && !liCheck(block.closest('li'))) act = () => { block.prepend(newCheck(/x/i.test(m[1]))); return block; };
      if (act) {
        HE.commit();
        const x = document.createRange(); x.selectNodeContents(block); x.setEnd(r.startContainer, r.startOffset); x.deleteContents();
        const target = act();
        if (!target.textContent.replace(/\u200b/g, '') && !target.querySelector('br')) target.appendChild(el('br'));
        caretIn(target, target.querySelector('input') != null);
        flush(); fixup(); HE.commit();
        return;
      }
    }
    if (!/[*_~`$)]/.test(d)) return;
    for (const [re, make] of INLINE) {
      const m = re.exec(before); if (!m) continue;
      HE.commit();
      const x = document.createRange(); x.setStart(node, m.index); x.setEnd(node, r.startOffset); x.deleteContents();
      const n = make(m); x.insertNode(n);
      const z = document.createTextNode(ZW); n.after(z); setCaret(z, 1);
      if (n.classList.contains('math')) quiet(() => app._.renderMath(n));
      flush(); HE.commit();
      return;
    }
  }

  /* ---------------- Keys ---------------- */
  function cellMove(cell, d) {
    const cells = [...cell.closest('table').querySelectorAll('th,td')], i = cells.indexOf(cell) + d;
    if (i < 0) return true;
    if (i >= cells.length) { cmd(() => { const tr = addRow(cell.closest('table'), cell.parentNode); caretIn(tr.cells[0], false); }); return true; }
    caretIn(cells[i], true); const s = sel(); if (cells[i].textContent) s.selectAllChildren(cells[i]);
    return true;
  }
  function exitAfter(node) {
    let p = node.nextElementSibling;
    if (!p || p.tagName !== 'P') { p = el('p', null, '<br>'); node.after(p); }
    caretIn(p, false);
  }
  function onKeyRich(e) {
    const r = range(); if (!r) return;
    const k = e.key, host = elOf(r.startContainer);
    const pre = host.closest('.cb pre');
    if (pre) {
      if (k === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '    '); }
      else if (k === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cmd(() => exitAfter(pre.parentNode)); }
      else if (k === 'Backspace' && r.collapsed && plainText(pre) === '') { e.preventDefault(); cmd(() => { const cb = pre.parentNode, p = el('p', null, '<br>'); cb.replaceWith(p); caretIn(p, false); }); }
      else if (k === 'ArrowDown' && !pre.parentNode.nextElementSibling && plainOffset(pre, r.endContainer, r.endOffset) >= plainText(pre).length) { e.preventDefault(); cmd(() => exitAfter(pre.parentNode)); }
      return;
    }
    if (host.closest('.cbl')) return;
    const block = leafBlock(r.startContainer);
    const cell = host.closest('td,th');
    if (k === 'Tab') {
      e.preventDefault();
      if (cell && ed.contains(cell)) return void cellMove(cell, e.shiftKey ? -1 : 1);
      const li = host.closest('li');
      if (li && ed.contains(li)) cmd(() => keepSel(() => (e.shiftKey ? outdentLi(li) : indentLi(li)), li));
      return;
    }
    if (k === 'Enter' && !e.shiftKey && !e.ctrlKey) {
      if (cell && ed.contains(cell)) {
        e.preventDefault();
        const tr = cell.parentNode, t = cell.closest('table'), rows = [...t.rows], ri = rows.indexOf(tr);
        if (ri < rows.length - 1) caretIn(rows[ri + 1].cells[Math.min(cell.cellIndex, rows[ri + 1].cells.length - 1)], true);
        else cmd(() => exitAfter(t));
        return;
      }
      if (!block || !r.collapsed) return;
      const text = block.textContent.replace(/[\u200b\u00a0]/g, ' ').trim();
      if (block.tagName === 'P' && isTop(block)) {
        let m;
        if ((m = /^(?:```|~~~)\s*([\w+#.-]*)$/.exec(text))) { e.preventDefault(); cmd(() => { const cb = makeCb('', m[1]); block.replaceWith(cb); if (!cb.nextElementSibling) cb.after(el('p', null, '<br>')); caretIn(cb.lastChild, false); }); return; }
        if (text === '$$') { e.preventDefault(); const mm = cmd(() => { const p = el('p', { class: 'mathp' }), x = mathEl('', true); p.appendChild(x); block.replaceWith(p); if (!p.nextElementSibling) p.after(el('p', null, '<br>')); return x; }); openMath(mm, true); return; }
        if (/^(-{3,}|_{3,}|\*{3,})$/.test(text)) { e.preventDefault(); cmd(() => { const hr = el('hr'); block.replaceWith(hr); exitAfter(hr); }); return; }
        if ((m = /^\|(.+)\|$/.exec(text)) && !/^\|[\s:|-]+\|$/.test(text)) {
          e.preventDefault();
          const hs = m[1].split('|').map(s => s.trim());
          cmd(() => { const t = tableEl(2, hs.length, hs); block.replaceWith(t); if (!t.nextElementSibling) t.after(el('p', null, '<br>')); caretIn(t.rows[1].cells[0], false); });
          return;
        }
      }
      const li = block.tagName === 'LI' ? block : block.closest('li');
      if (li && ed.contains(li)) {
        const box = liCheck(li);
        if (box && !li.textContent.replace(/[\u200b\s]/g, '')) {     // empty task: leave the list
          e.preventDefault();
          cmd(() => { box.remove(); li.textContent = ''; li.appendChild(el('br')); caretIn(li, false); document.execCommand('insertParagraph'); });
          return;
        }
        // The new item of a task list is a task too.
        if (box) setTimeout(() => {
          const r2 = range(); const nl = r2 && elOf(r2.startContainer).closest('li');
          if (!nl) return;
          const prev = nl.previousElementSibling;
          if (prev && prev.tagName === 'LI' && !liCheck(prev)) keepSel(() => prev.prepend(newCheck(false)), prev);
          if (!liCheck(nl)) { const empty = !nl.textContent.replace(/[​\s]/g, ''); keepSel(() => nl.prepend(newCheck(false)), nl); if (empty) setCaret(nl, 1); }
          flush(); HE.commit();
        }, 0);
        return;
      }
      const q = block.closest('blockquote');
      if (q && ed.contains(q) && block.tagName === 'P' && isEmpty(block)) {     // empty line: leave the quote
        e.preventDefault();
        cmd(() => { if (block.nextElementSibling) { const rest = q.cloneNode(false); let n = block.nextSibling; while (n) { const x = n.nextSibling; rest.appendChild(n); n = x; } q.after(rest); } q.after(block); if (!q.children.length) q.remove(); caretIn(block, false); });
        return;
      }
      return;
    }
    if (k === 'Backspace' && r.collapsed && block && atStart(block, r)) {
      if (/^H[1-6]$/.test(block.tagName)) { e.preventDefault(); cmd(() => { const p = retag(block, 'p'); caretIn(p, false); }); return; }
      const li = block.tagName === 'LI' ? block : null;
      const q = block.parentNode.tagName === 'BLOCKQUOTE' ? block.parentNode : null;
      if (q && block === q.firstElementChild) { e.preventDefault(); cmd(() => { q.before(block); if (!q.children.length) q.remove(); caretIn(block, false); }); return; }
      if (li && liCheck(li)) return;
      const tb = topBlock(block);
      const prev = tb === block ? prevBlock(tb) : null;
      if (prev && (prev.classList.contains('cb') || /^(HR|TABLE)$/.test(prev.tagName) || prev.classList.contains('mathp') || prev.classList.contains('rawblock') || prev.classList.contains('htmlblock'))) {
        e.preventDefault();
        if (prev.classList.contains('cb')) { if (isEmpty(block) && block.nextElementSibling) cmd(() => block.remove()); caretIn(prev.lastChild, true); }
        else if (prev.tagName === 'TABLE') { const cells = prev.querySelectorAll('td,th'); caretIn(cells[cells.length - 1], true); }
        else cmd(() => prev.remove());
      }
      return;
    }
    if (k === 'Backspace' && r.collapsed) {
      const li = host.closest('li'), box = li && liCheck(li);
      // Caret right after the checkbox: remove it (the item becomes a plain bullet).
      if (box && !textBefore(li, r).replace(/[\u200b\s]/g, '')) { e.preventDefault(); cmd(() => { if (box.nextSibling && box.nextSibling.nodeType === 3) box.nextSibling.data = box.nextSibling.data.replace(/^[ \u00a0]/, ''); box.remove(); if (!li.firstChild) li.appendChild(el('br')); caretIn(li, false); }); }
      return;
    }
    if (k === 'ArrowRight' && r.collapsed && !e.shiftKey) {
      const code = host.closest('code,a,strong,em,del,b,i');
      if (code && ed.contains(code) && r.startContainer.nodeType === 3 && r.startOffset === r.startContainer.data.length && !code.nextSibling) {
        e.preventDefault();
        quiet(() => { const z = document.createTextNode(ZW); code.after(z); setCaret(z, 1); });
      }
    }
  }
  ed.addEventListener('keydown', onKeyRich);

  ed.addEventListener('beforeinput', e => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); e.inputType === 'historyUndo' ? undo() : redo(); return; }
    if (stepBefore(e)) HE.commit();
    HE.mark();
  });
  ed.addEventListener('input', e => {
    const t = e.target;
    if (t.classList && t.classList.contains('cbl')) { t.setAttribute('value', t.value); t.parentNode.setAttribute('data-lang', t.value.trim()); }
    flush();
    if (!e.isComposing && e.inputType === 'insertText' && t === ed) typingRules(e);
    fixSoon();
    afterEdit();
    HE.touch();
  });
  ed.addEventListener('change', e => {
    const c = e.target;
    if (c.type !== 'checkbox') return;
    HE.commit();
    if (c.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked');
    flush(); HE.commit(); afterEdit();
  });
  ed.addEventListener('click', e => {
    const m = e.target.closest && e.target.closest('.math');
    if (m && ed.contains(m)) { e.preventDefault(); openMath(m); return; }
    if (e.target.tagName === 'HR' || e.target.tagName === 'IMG') { const r = document.createRange(); r.selectNode(e.target); const s = sel(); s.removeAllRanges(); s.addRange(r); }
  });
  ed.addEventListener('dblclick', e => { const a = e.target.closest && e.target.closest('a[href]'); if (a && ed.contains(a) && !a.closest('.footnote-reference')) openLink(); });

  // Copy as Markdown; paste Markdown as formatted content.
  function selectionMd() {
    const r = range(); if (!r || r.collapsed) return null;
    const box = el('div'); box.appendChild(r.cloneContents());
    const anc = elOf(r.commonAncestorContainer);
    if (box.querySelector(':scope > li')) { const l = el(anc.closest('ol') && !anc.closest('ul') ? 'ol' : 'ul'); while (box.firstChild) l.appendChild(box.firstChild); box.appendChild(l); }
    const inCode = anc.closest('.cb pre');
    return { md: inCode ? sel().toString() : joinBlocks(childBlocks(box, {})), html: box.innerHTML };
  }
  const onCopy = e => {
    const d = selectionMd(); if (!d) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', d.md);
    if (e.type === 'cut') { HE.commit(); document.execCommand('delete'); flush(); fixup(); HE.commit(); afterEdit(); }
  };
  ed.addEventListener('copy', onCopy);
  ed.addEventListener('cut', onCopy);
  ed.addEventListener('paste', async e => {
    const r = range(); if (!r) return;
    if (elOf(r.startContainer).closest('.cb pre, .cbl')) return;      // plain text, natively
    e.preventDefault();
    const text = (e.clipboardData.getData('text/plain') || '').replace(/\r\n?/g, '\n');
    if (!text) return;
    HE.commit();
    const simple = !/\n/.test(text.trim()) && !/[*_`~$[\]#>|\\<]|^\s*([-+]|\d+[.)])\s/.test(text);
    if (simple || elOf(r.startContainer).closest('code')) { document.execCommand('insertText', false, text); flush(); HE.commit(); afterEdit(); return; }
    const res = await ask('blocks', { text });
    const tpl = document.createElement('template');
    tpl.innerHTML = res.blocks.map(b => b.html).join('');
    const nodes = [...tpl.content.children];
    if (!nodes.length) return;
    cmd(() => {
      const r2 = range() || r;
      r2.deleteContents();
      const cur = leafBlock(r2.startContainer);
      if (nodes.length === 1 && nodes[0].tagName === 'P' && cur) {
        const frag = document.createDocumentFragment(); while (nodes[0].firstChild) frag.appendChild(nodes[0].firstChild);
        const lastN = frag.lastChild; r2.insertNode(frag);
        if (lastN) { const x = document.createRange(); x.setStartAfter(lastN); x.collapse(true); const s = sel(); s.removeAllRanges(); s.addRange(x); }
        return;
      }
      let at = topBlock(r2.startContainer);
      const inCell = cur && /^(TD|TH)$/.test(cur.tagName);
      if (inCell) { cur.appendChild(document.createTextNode(text.replace(/\n+/g, ' '))); return; }
      if (at && at.tagName === 'P' && isEmpty(at)) { at.replaceWith(...nodes); }
      else if (at) at.after(...nodes); else lastSec().append(...nodes);
      const lastB = nodes[nodes.length - 1];
      fixup();
      if (lastB.isConnected && /^(P|H[1-6]|UL|OL|BLOCKQUOTE)$/.test(lastB.tagName)) caretIn(lastB, true); else if (lastB.isConnected) exitAfter(lastB);
    });
  });
  ed.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) e.preventDefault(); });

  /* ---------------- Tables ---------------- */
  function addRow(t, after) {
    const cols = t.rows[0].cells.length, tr = el('tr', null, '<td><br></td>'.repeat(cols));
    [...tr.cells].forEach((c, i) => { const a = t.rows[0].cells[i].style.textAlign; if (a) c.style.textAlign = a; });
    const bodyEl = t.tBodies[0] || t.appendChild(el('tbody'));
    if (after && after.parentNode === bodyEl) after.after(tr); else bodyEl.prepend(tr);
    return tr;
  }
  function tableAct(act) {
    const r = range(); const cell = r && elOf(r.startContainer).closest('td,th'); if (!cell) return;
    const t = cell.closest('table'), tr = cell.parentNode, ci = cell.cellIndex, ri = [...t.rows].indexOf(tr);
    cmd(() => {
      if (act === 'row') caretIn(addRow(t, ri === 0 ? null : tr).cells[ci], false);
      else if (act === 'col') { [...t.rows].forEach((row, i) => { const c = el(i === 0 ? 'th' : 'td', null, '<br>'); (row.cells[ci] || row.lastElementChild).after(c); }); caretIn(tr.cells[ci + 1], false); }
      else if (act === 'delrow') {
        if (ri === 0 || t.rows.length <= 2) return toast('Un tableau garde son en-tête et une ligne', 1800);
        const to = t.rows[ri + 1] || t.rows[ri - 1]; tr.remove(); caretIn(to.cells[Math.min(ci, to.cells.length - 1)], false);
      }
      else if (act === 'delcol') {
        if (t.rows[0].cells.length <= 1) return;
        [...t.rows].forEach(row => { if (row.cells[ci]) row.cells[ci].remove(); }); caretIn(tr.cells[Math.max(0, ci - 1)], false);
      }
      else if (act === 'del') { const p = el('p', null, '<br>'); t.replaceWith(p); caretIn(p, false); }
      else { [...t.rows].forEach(row => { const c = row.cells[ci]; if (c) { if (act === 'left') c.style.removeProperty('text-align'); else c.style.textAlign = act; if (!c.getAttribute('style')) c.removeAttribute('style'); } }); }
    });
    placeTblBar();
  }

  /* =====================================================================
   *  Commands on the Markdown source (same toolbar)
   * ===================================================================== */
  function rawCmd(kind, arg) {
    const s = plainSel(raw); if (!s) { raw.focus(); return; }
    const text = plainText(raw), [a, b] = s, picked = text.slice(a, b);
    const wrap = (l, r2, ph) => { const inner = picked || ph; rawReplace(a, b, l + inner + r2, a + l.length, a + l.length + inner.length); };
    const ls = text.lastIndexOf('\n', a - 1) + 1; let le = text.indexOf('\n', Math.max(b - (b > a && text[b - 1] === '\n' ? 1 : 0), a)); if (le < 0) le = text.length;
    const lines = text.slice(ls, le).split('\n');
    const prefix = fn => { const out = lines.map(fn).join('\n'); rawReplace(ls, le, out, ls + out.length); };
    const strip = l => l.replace(/^(\s*)(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/, '$1');
    const block = (t, selOff, selLen) => {
      const pre = a > 0 && text[a - 1] !== '\n' ? '\n\n' : a > 1 && text[a - 2] !== '\n' ? '\n' : '';
      const post = text[b] === '\n' ? (text[b + 1] === '\n' || b + 1 >= text.length ? '' : '\n') : '\n\n';
      rawReplace(a, b, pre + t + post, a + pre.length + selOff, a + pre.length + selOff + (selLen || 0));
    };
    switch (kind) {
      case 'bold': return wrap('**', '**', 'gras');
      case 'italic': return wrap('*', '*', 'italique');
      case 'underline': return wrap('<u>', '</u>', 'souligné');
      case 'strike': return wrap('~~', '~~', 'barré');
      case 'code': return wrap('`', '`', 'code');
      case 'block': return prefix(l => (arg === 'p' ? strip(l) : '#'.repeat(+arg[1]) + ' ' + strip(l)));
      case 'ul': return prefix(l => (/^\s*[-*+]\s+(?!\[[ xX]\])/.test(l) ? strip(l) : l.replace(/^(\s*)/, '$1- ' ) && (/^(\s*)/.exec(l)[1] + '- ' + strip(l).trimStart())));
      case 'ol': { let n = 1; return prefix(l => (/^\s*\d+[.)]\s/.test(l) ? strip(l) : /^(\s*)/.exec(l)[1] + (n++) + '. ' + strip(l).trimStart())); }
      case 'task': return prefix(l => (/^\s*[-*+]\s+\[[ xX]\]/.test(l) ? strip(l) : /^(\s*)/.exec(l)[1] + '- [ ] ' + strip(l).trimStart()));
      case 'quote': {
        const on = lines.every(l => /^\s*>/.test(l));
        const out = (arg && !on ? ['> [!' + arg.toUpperCase() + ']'] : []).concat(lines.map(l => (on ? l.replace(/^\s*>\s?/, '') : '> ' + l))).join('\n');
        return rawReplace(ls, le, out, ls + out.length);
      }
      case 'codeblock': return block('```\n' + picked + (picked && !picked.endsWith('\n') ? '\n' : '') + '```', picked ? 4 : 3);
      case 'math': return picked || (a > ls && text.slice(ls, a).trim()) ? wrap('$', '$', 'x') : block('$$\n\n$$', 3);
      case 'table': { const [rw, cl] = arg || [3, 3]; const row = '|' + '   |'.repeat(cl); return block('|' + ' Titre |'.repeat(cl) + '\n|' + ' --- |'.repeat(cl) + ('\n' + row).repeat(Math.max(1, rw - 1)), 2, 5); }
      case 'hr': return block('---', 3);
      case 'footnote': {
        let n = 1; for (const m of text.matchAll(/\[\^(\d+)\]/g)) n = Math.max(n, +m[1] + 1);
        const ref = '[^' + n + ']', def = (text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n') + '[^' + n + ']: ';
        rawReplace(b, b, ref); const end = plainText(raw).length; return rawReplace(end, end, def, end + def.length);
      }
      case 'link': return rawReplace(a, b, '[' + (arg.text || picked || arg.url) + '](' + linkDest(arg.url) + ')');
      case 'image': return rawReplace(a, b, '![' + arg.alt + '](' + linkDest(arg.src) + ')');
    }
  }

  /* =====================================================================
   *  Interface: switches, toolbar, panels
   * ===================================================================== */
  const I = {
    save: '<path d="M5.5 3.5h10l4 4V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V4.5a1 1 0 0 1 1-1z"/><path d="M8 3.5V8h6.5V3.5M7.5 20.5V14h9v6.5"/>',
    undo: '<path d="M8.5 13.5 4 9l4.5-4.5"/><path d="M4 9h10a5.5 5.5 0 0 1 0 11h-3"/>',
    redo: '<path d="M15.5 13.5 20 9l-4.5-4.5"/><path d="M20 9H10a5.5 5.5 0 0 0 0 11h3"/>',
    code: '<path d="m8 7.5-4.5 4.5L8 16.5M16 7.5l4.5 4.5-4.5 4.5"/>',
    link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.6.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5"/><path d="M14 10.5a4.5 4.5 0 0 0-6.6-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5"/>',
    image: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="9.7" r="1.6"/><path d="m21 15.5-4.8-4.8L7 19.5"/>',
    ul: '<path d="M9.5 6h10.5M9.5 12h10.5M9.5 18h10.5"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="2.6"/>',
    ol: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 4.6 5.3 4v4.2M3.9 14.3c.3-.8 2.2-.9 2.2.3 0 .9-1.6 1.6-2.2 2.9h2.4" stroke-width="1.4"/>',
    task: '<rect x="3.5" y="4" width="6.5" height="6.5" rx="1.5"/><path d="m3.8 16.8 2 2 3.6-4M13.5 7.2h7M13.5 16.8h7"/>',
    quote: '<path d="M5 5v14" stroke-width="2.4"/><path d="M10 7.5h10M10 12h10M10 16.5h6"/>',
    note: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.2M12 7.8h.01"/>',
    codeblock: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m9.8 9.3-2.7 2.7 2.7 2.7M14.2 9.3l2.7 2.7-2.7 2.7"/>',
    math: '<path d="M17.5 6.5v-2H6.5l6 7.5-6 7.5h11v-2"/>',
    table: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9.8h18M3 14.6h18M9.4 4.5v15M15.2 4.5v15"/>',
    hr: '<path d="M3.5 12h17" stroke-width="2.2"/><path d="M7 6.5h10M7 17.5h10" opacity=".45"/>',
    chev: '<path d="m7 10 5 5 5-5"/>',
    rowAdd: '<rect x="3.5" y="4" width="17" height="9" rx="2"/><path d="M12 15.5v5M9.5 18h5"/>',
    colAdd: '<rect x="4" y="3.5" width="9" height="17" rx="2"/><path d="M15.5 12h5M18 9.5v5"/>',
    rowDel: '<rect x="3.5" y="4" width="17" height="9" rx="2"/><path d="M9.5 18h5"/>',
    colDel: '<rect x="4" y="3.5" width="9" height="17" rx="2"/><path d="M15.5 12h5"/>',
    alL: '<path d="M4 6h16M4 12h10M4 18h13"/>', alC: '<path d="M4 6h16M7 12h10M5.5 18h13"/>', alR: '<path d="M4 6h16M10 12h10M7 18h13"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7"/>',
  };
  const svg = k => `<svg viewBox="0 0 24 24">${I[k]}</svg>`;

  const bar = $('#bar'), anchorBtn = $('#bZoom');
  const bSave = el('button', { class: 'ib edui', id: 'bSave', title: 'Enregistrer (Ctrl+S)' }, svg('save'));
  const mkSwitch = (id, title, a, b) => el('div', { class: 'sw2', id, title, role: 'switch', tabindex: '0' }, `<i></i><button tabindex="-1" data-v="${a[0]}">${a[1]}</button><button tabindex="-1" data-v="${b[0]}">${b[1]}</button>`);
  const swView = mkSwitch('swView', 'Rendu mis en forme ou source Markdown (Ctrl+Maj+E)', ['rich', 'Rendu'], ['raw', 'Source']);
  swView.classList.add('edui');
  const swMode = mkSwitch('swMode', 'Édition ou lecture (Ctrl+E)', ['edit', 'Édition'], ['read', 'Lecture']);
  swMode.classList.add('b');
  const bSaveAs = el('button', { class: 'ib edui', id: 'bSaveAs', title: 'Enregistrer sous… : écrire les modifications dans un autre fichier (Ctrl+Maj+S)', 'data-t': 'savemenu' }, svg('chev'));
  bar.insertBefore(bSave, anchorBtn);
  bar.insertBefore(bSaveAs, anchorBtn);
  if (MD) bar.insertBefore(swView, anchorBtn);
  bar.insertBefore(swMode, anchorBtn);
  bSave.addEventListener('click', () => save(false));
  bSaveAs.addEventListener('click', () => { if (panel === pSave) return closePanel(); openPanel(pSave, bSave); bSaveAs.classList.add('on'); });
  swMode.addEventListener('click', () => setMode(S.mode === 'edit' ? 'read' : 'edit'));
  swView.addEventListener('click', () => setView(S.view === 'rich' ? 'raw' : 'rich'));
  for (const s of [swMode, swView]) s.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); s.click(); } });

  const TOOLS = [
    ['undo', svg('undo'), 'Annuler (Ctrl+Z)'], ['redo', svg('redo'), 'Rétablir (Ctrl+Y)'], 0,
    ['style'], 0,
    ['bold', '<span class="g">G</span>', 'Gras (Ctrl+B)'], ['italic', '<span class="g i">I</span>', 'Italique (Ctrl+I)'],
    ['underline', '<span class="g u">S</span>', 'Souligné (Ctrl+U)'], ['strike', '<span class="g s">ab</span>', 'Barré (Ctrl+Maj+X)'],
    ['code', svg('code'), 'Code en ligne (`code`)'], 0,
    ['link', svg('link'), 'Lien (Ctrl+K)'], ['image', svg('image'), 'Image'], 0,
    ['ul', svg('ul'), 'Liste à puces (- )'], ['ol', svg('ol'), 'Liste numérotée (1. )'], ['task', svg('task'), 'Cases à cocher ([ ] )'], 0,
    ['quote', svg('quote'), 'Citation (> )'], ['note', svg('note'), 'Encadré : note, astuce, attention…'], 0,
    ['codeblock', svg('codeblock'), 'Bloc de code (```)'], ['math', svg('math'), 'Formule ($…$ ou $$)'], ['table', svg('table'), 'Tableau'],
    ['hr', svg('hr'), 'Séparateur (---)'], ['footnote', '<span class="g">a<sup>1</sup></span>', 'Note de bas de page'],
  ];
  const tools = el('div', { id: 'tools' });
  tools.innerHTML = TOOLS.map(t => !t ? '<span class="tsep"></span>'
    : t[0] === 'style' ? `<button class="tb" id="tStyle" data-t="style" title="Style du paragraphe"><span>Paragraphe</span>${svg('chev')}</button>`
      : `<button class="tb" data-t="${t[0]}" title="${t[2]}">${t[1]}</button>`).join('');
  body.appendChild(tools);
  const STYLES = [['p', 'Paragraphe'], ['h1', 'Titre 1'], ['h2', 'Titre 2'], ['h3', 'Titre 3'], ['h4', 'Titre 4']];
  const CALLS = [['note', 'Note', '#4f8ff7'], ['tip', 'Astuce', '#3fb26f'], ['important', 'Important', '#a371f7'], ['warning', 'Attention', '#d29922'], ['caution', 'Prudence', '#e5534b']];
  const pStyle = el('div', { class: 'pop menu epop', id: 'pStyle' }, STYLES.map(([v, n], i) => `<button data-v="${v}"><span class="${v}">${n}</span><kbd>${i ? '#'.repeat(i) + ' ␣' : ''}</kbd></button>`).join(''));
  const pCall = el('div', { class: 'pop menu epop', id: 'pCall' }, CALLS.map(([v, n, c]) => `<button data-v="${v}"><i style="background:${c}"></i><span>${n}</span></button>`).join(''));
  const pGrid = el('div', { class: 'pop epop', id: 'pGrid' }, '<div class="grid">' + '<i></i>'.repeat(48) + '</div><div class="lbl">Tableau</div>');
  const pLink = el('div', { class: 'pop epop', id: 'pLink' }, '<div class="efield"><input id="lText" placeholder="Texte du lien" spellcheck="false"><input id="lUrl" placeholder="https://… ou fichier.md" spellcheck="false"><div class="row"><button class="ebtn" id="lDel">Retirer le lien</button><button class="ebtn pri" id="lOk">Appliquer</button></div></div>');
  const pMath = el('div', { class: 'pop epop', id: 'pMath' }, '<div class="efield"><div id="mPrev"></div><textarea id="mTex" rows="2" placeholder="LaTeX (facultatif) — la formule se modifie directement au-dessus" spellcheck="false"></textarea><div id="mTabs"></div><div id="mGrid"></div><div class="row"><span class="hint">Clique dans la formule pour la modifier · Tab : champ suivant · Entrée : valider</span><button class="ebtn pri" id="mOk">OK</button></div></div>');
  const tblBar = el('div', { id: 'tblBar' }, [['row', 'rowAdd', 'Ajouter une ligne dessous'], ['col', 'colAdd', 'Ajouter une colonne à droite'], ['delrow', 'rowDel', 'Supprimer la ligne'], ['delcol', 'colDel', 'Supprimer la colonne'], 0, ['left', 'alL', 'Aligner à gauche'], ['center', 'alC', 'Centrer'], ['right', 'alR', 'Aligner à droite'], 0, ['del', 'trash', 'Supprimer le tableau']]
    .map(t => (t ? `<button class="tb" data-a="${t[0]}" title="${t[2]}">${svg(t[1])}</button>` : '<span class="tsep"></span>')).join(''));
  const pSave = el('div', { class: 'pop menu epop', id: 'pSave' }, '<button data-v="save"><span>Enregistrer</span><kbd>Ctrl+S</kbd></button><button data-v="as"><span>Enregistrer sous…<small>le fichier d’origine reste intact</small></span><kbd>Ctrl+Maj+S</kbd></button>');
  body.append(pStyle, pCall, pGrid, pLink, pMath, pSave, tblBar);
  if (B.edit.newInMenu) pSave.insertAdjacentHTML('beforeend', '<button data-v="new"><span>Nouveau document</span></button>');
  pSave.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; closePanel(); if (b.dataset.v === 'new') send({ cmd: 'new' }); else save(b.dataset.v === 'as'); });

  // ---- panels ----
  // `anchor`: anything with getBoundingClientRect (a button, an element of the text, a Range).
  let panel = null, panelClose = null, panelAnchor = null, savedSel = null;
  function placePanel() {
    if (!panel) return;
    const rect = panelAnchor.getBoundingClientRect(), w = panel.offsetWidth, h = panel.offsetHeight;
    panel.style.left = Math.max(8, Math.min(rect.left, innerWidth - w - 8)) + 'px';
    let top = rect.bottom + 6; if (top + h > innerHeight - 8 && rect.top - h - 6 > barH()) top = rect.top - h - 6;
    panel.style.top = Math.max(barH() + 4, Math.min(top, innerHeight - h - 8)) + 'px';
  }
  function openPanel(p, anchor, onClose) {
    closePanel(); closePop();
    panel = p; panelClose = onClose || null; panelAnchor = anchor;
    p.classList.add('show');
    placePanel();
  }
  function closePanel(cancel) {
    if (!panel) return;
    bSaveAs.classList.remove('on');
    const p = panel, f = panelClose; panel = panelClose = null;
    p.classList.remove('show');
    if (f) f(!!cancel);
  }
  const inMathUi = e => e.composedPath().some(n => n.nodeType === 1 && (n.tagName === 'MATH-FIELD' || /(^|\s)(ui-menu|ML__)/.test(n.className && n.className.baseVal == null ? n.className : '')));
  document.addEventListener('mousedown', e => { if (panel && !panel.contains(e.target) && !e.target.closest('[data-t]') && !inMathUi(e)) closePanel(); }, true);
  const keepRange = () => { savedSel = S.view === 'rich' ? richSel() : plainSel(raw); };
  const backToText = () => { if (S.view === 'rich') { if (savedSel) setRichSel(savedSel); else ed.focus(); } else { raw.focus(); if (savedSel) setPlainSel(raw, savedSel[0], savedSel[1]); } };

  // ---- toolbar ----
  for (const host of [tools, tblBar, pStyle, pCall, pGrid]) host.addEventListener('mousedown', e => e.preventDefault());   // keep the text selection
  const rich = () => S.view === 'rich';
  function ensureFocus() { if (rich()) { if (!range()) caretIn(lastBlock() || ed, true); } else if (!plainSel(raw)) { raw.focus(); const n = plainText(raw).length; setPlainSel(raw, n); } }
  function runTool(t, btn) {
    if (S.mode !== 'edit') return;
    if (t === 'undo') return undo();
    if (t === 'redo') return redo();
    ensureFocus();
    const r = btn;
    switch (t) {
      case 'style': if (panel === pStyle) return closePanel(); markStyle(); return openPanel(pStyle, r);
      case 'note': if (panel === pCall) return closePanel(); return openPanel(pCall, r);
      case 'table': if (panel === pGrid) return closePanel(); return openPanel(pGrid, r);
      case 'bold': return rich() ? fmt('bold') : rawCmd('bold');
      case 'italic': return rich() ? fmt('italic') : rawCmd('italic');
      case 'underline': return rich() ? fmt('underline') : rawCmd('underline');
      case 'strike': return rich() ? fmt('strikeThrough') : rawCmd('strike');
      case 'code': return rich() ? toggleCode() : rawCmd('code');
      case 'link': return openLink(r);
      case 'image': return pickImage();
      case 'ul': return rich() ? toggleList('ul') : rawCmd('ul');
      case 'ol': return rich() ? toggleList('ol') : rawCmd('ol');
      case 'task': return rich() ? toggleList('ul', true) : rawCmd('task');
      case 'quote': return rich() ? toggleQuote('') : rawCmd('quote');
      case 'codeblock': return rich() ? insertCode() : rawCmd('codeblock');
      case 'math': return rich() ? insertMath() : rawCmd('math');
      case 'hr': return rich() ? insertHr() : rawCmd('hr');
      case 'footnote': return rich() ? insertFootnote() : rawCmd('footnote');
    }
  }
  tools.addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) runTool(b.dataset.t, b); });
  tools.addEventListener('wheel', e => { if (!e.ctrlKey && tools.scrollWidth > tools.clientWidth) { e.preventDefault(); tools.scrollLeft += e.deltaY || e.deltaX; } }, { passive: false });
  pStyle.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; closePanel(); rich() ? setBlock(b.dataset.v) : rawCmd('block', b.dataset.v); });
  pCall.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; closePanel(); rich() ? toggleQuote(b.dataset.v) : rawCmd('quote', b.dataset.v); });
  const gridCells = $$('.grid i', pGrid);
  const gridAt = t => { const i = gridCells.indexOf(t); return i < 0 ? null : [Math.floor(i / 8) + 1, (i % 8) + 1]; };
  pGrid.addEventListener('mousemove', e => {
    const g = gridAt(e.target); if (!g) return;
    gridCells.forEach((c, i) => c.classList.toggle('on', Math.floor(i / 8) < g[0] && i % 8 < g[1]));
    $('.lbl', pGrid).textContent = g[1] + ' colonnes × ' + g[0] + ' lignes';
  });
  pGrid.addEventListener('click', e => { const g = gridAt(e.target); if (!g) return; closePanel(); rich() ? insertTable(Math.max(2, g[0]), g[1]) : rawCmd('table', [Math.max(2, g[0]), g[1]]); });
  tblBar.addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (b) tableAct(b.dataset.a); });

  function curBlockTag() {
    if (!rich()) return null;
    const r = range(); const b = r && leafBlock(r.startContainer);
    const h = b && (b.closest('h1,h2,h3,h4,h5,h6') || b);
    return h ? h.tagName.toLowerCase() : null;
  }
  function markStyle() { const t = curBlockTag(); $$('button', pStyle).forEach(b => b.classList.toggle('on', b.dataset.v === (STYLES.some(s => s[0] === t) ? t : 'p'))); }
  let toolsT = 0;
  const toolsSoon = () => { if (!toolsT) toolsT = requestAnimationFrame(() => { toolsT = 0; updateTools(); }); };
  function updateTools() {
    if (S.mode !== 'edit' || !MD) return;
    const on = {};
    let label = 'Paragraphe';
    if (rich()) {
      const r = range();
      if (r) {
        const e = elOf(r.startContainer);
        const st = c => { try { return document.queryCommandState(c); } catch (x) { return false; } };
        on.bold = st('bold'); on.italic = st('italic'); on.underline = st('underline'); on.strike = st('strikeThrough');
        on.code = !!e.closest('code'); on.link = !!e.closest('a[href]');
        const li = e.closest('li');
        if (li) { const task = !!liCheck(li); on.task = task; on.ul = !task && li.parentNode.tagName === 'UL'; on.ol = li.parentNode.tagName === 'OL'; }
        const q = e.closest('blockquote');
        if (q) { if (/markdown-alert/.test(q.className)) on.note = true; else on.quote = true; }
        on.codeblock = !!e.closest('.cb'); on.table = !!e.closest('table');
        const t = curBlockTag(), s = STYLES.find(x => x[0] === t);
        label = s ? s[1] : /^h[56]$/.test(t || '') ? 'Titre ' + t[1] : on.codeblock ? 'Code' : 'Paragraphe';
      }
    } else label = 'Style';
    $$('[data-t]', tools).forEach(b => b.classList.toggle('on', !!on[b.dataset.t]));
    $('#tStyle span').textContent = label;
    placeTblBar();
  }
  function placeTblBar() {
    const r = S.mode === 'edit' && rich() && !mathFor ? range() : null;
    const t = r && elOf(r.startContainer).closest('table');
    if (!t || !ed.contains(t)) { tblBar.classList.remove('show'); return; }
    tblBar.classList.add('show');
    const b = t.getBoundingClientRect(), h = tblBar.offsetHeight, w = tblBar.offsetWidth;
    const top = b.top - h - 6;
    if (b.bottom < barH() + 20 || b.top > innerHeight) { tblBar.classList.remove('show'); return; }
    tblBar.style.top = Math.max(barH() + 6, top) + 'px';
    tblBar.style.left = Math.max(8, Math.min(b.right - w, innerWidth - w - 8)) + 'px';
  }
  document.addEventListener('selectionchange', toolsSoon);
  addEventListener('scroll', () => { if (tblBar.classList.contains('show')) placeTblBar(); placePanel(); }, { passive: true });
  addEventListener('resize', () => { placeTblBar(); placePanel(); });

  // ---- link ----
  let linkEl = null;
  function openLink(rect) {
    ensureFocus(); keepRange();
    linkEl = null; let text = '', hasSel = false;
    if (rich()) {
      const r = range(); linkEl = elOf(r.startContainer).closest('a[href]');
      if (linkEl && linkEl.closest('.footnote-reference')) linkEl = null;
      hasSel = !r.collapsed; text = linkEl ? linkEl.textContent : r.toString();
      rect = rect || linkEl || r.cloneRange();
    } else { const s = plainSel(raw); text = plainText(raw).slice(s[0], s[1]); hasSel = s[1] > s[0]; rect = rect || sel().getRangeAt(0).cloneRange(); }
    $('#lText').value = text; $('#lText').hidden = !!linkEl || hasSel;
    $('#lUrl').value = linkEl ? linkEl.getAttribute('href') : (/^(https?:\/\/|www\.)\S+$/.test(text.trim()) ? text.trim() : '');
    $('#lDel').hidden = !linkEl;
    openPanel(pLink, rect);
    $('#lUrl').focus(); $('#lUrl').select();
  }
  function applyLink(remove) {
    const url = $('#lUrl').value.trim(), text = $('#lText').value;
    const target = linkEl;
    closePanel(); backToText();
    if (!rich()) { if (url && !remove) rawCmd('link', { url, text }); return; }
    cmd(() => {
      if (target) {
        if (remove || !url) { const f = document.createDocumentFragment(); while (target.firstChild) f.appendChild(target.firstChild); target.replaceWith(f); }
        else target.setAttribute('href', url);
        return;
      }
      if (!url) return;
      const r = range(); if (!r) return;
      const a = el('a', { href: url });
      if (r.collapsed) a.textContent = text || url; else a.appendChild(r.extractContents());
      for (const inner of $$('a', a)) inner.replaceWith(...inner.childNodes);
      r.insertNode(a);
      const z = document.createTextNode(ZW); a.after(z); setCaret(z, 1);
    });
  }
  $('#lOk').addEventListener('click', () => applyLink(false));
  $('#lDel').addEventListener('click', () => applyLink(true));
  pLink.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyLink(false); } });

  async function pickImage() {
    keepRange();
    const res = await ask('pickImage');
    if (res.error) return toast(res.error, 3500);
    if (!res.src) return;
    backToText();
    if (!rich()) return rawCmd('image', res);
    cmd(() => { const r = range(); if (!r) return; r.collapse(false); const img = el('img', { src: res.src, alt: res.alt || '' }); r.insertNode(img); const z = document.createTextNode(ZW); img.after(z); setCaret(z, 1); });
  }

  // ---- math ----
  let mathFor = null, mathNew = false;
  function openMath(m, isNew) {
    closePanel();
    mathFor = m; mathNew = !!isNew;
    m.classList.add('sel');
    const ta = $('#mTex');
    ta.value = texOf(m); ta.rows = m.classList.contains('math-display') ? 3 : 2;
    previewMath();
    showPal(mGrid.dataset.p && mGrid.dataset.p !== 'recent' ? mGrid.dataset.p : prefs.mathTab || 'struct');
    if (mf) setField(ta.value);
    openPanel(pMath, m, cancel => {
      const node = mathFor; mathFor = null;
      if (!node || !node.isConnected) return;
      node.classList.remove('sel');
      if (mf && fieldDirty && !cancel) ta.value = fromField();
      const tex = ta.value.trim(), old = texOf(node);
      const holder = node.parentNode.classList.contains('mathp') ? node.parentNode : node;
      if ((cancel && mathNew && !old) || !tex) { cmd(() => { const nx = holder.nextSibling; holder.remove(); if (nx && nx.isConnected) { if (nx.nodeType === 3) setCaret(nx, Math.min(1, nx.data.length)); else caretIn(nx, false); } }); return; }
      if (!cancel && tex !== old) cmd(() => { node.setAttribute('data-tex', tex); node.textContent = tex; node.removeAttribute('data-r'); node.classList.remove('math-err'); app._.renderMath(node); });
      const after = holder.nextSibling;
      if (after && after.nodeType === 3) { ed.focus({ preventScroll: true }); setCaret(after, Math.min(1, after.data.length)); }
      else if (holder !== node && holder.nextElementSibling) caretIn(holder.nextElementSibling, false);
      else ed.focus({ preventScroll: true });
    });
    if (mf) focusField(); else { ta.focus(); ta.select(); loadMathLive().then(ok => { if (ok && mathFor === m) { setField(ta.value); placePanel(); focusField(); } }); }
  }

  // ---- MathLive: the formula itself is edited in place (click a matrix cell and type) ----
  let mf = null, mlLoad = null;
  // Programmatic changes of the field must not be taken for typing.
  // MathLive reports typing a little late: fieldDirty says the field is ahead of the LaTeX box.
  let fieldBusy = false, fieldDirty = false;
  const setField = tex => { fieldBusy = true; try { mf.setValue(tex); } finally { fieldBusy = false; fieldDirty = false; } };
  // Leave the text first: otherwise keys typed right away would still land in the document.
  const focusField = () => {
    if (document.activeElement && document.activeElement !== mf) document.activeElement.blur();
    getSelection().removeAllRanges();
    const go = () => { if (!mathFor) return; mf.focus(); try { mf.executeCommand('moveToMathfieldEnd'); } catch (e) { } };
    go(); requestAnimationFrame(() => { if (!mf.hasFocus || !mf.hasFocus()) go(); });
  };
  // What MathLive writes, as LaTeX that KaTeX (the reader) understands.
  const fromField = () => {
    let t = ''; try { t = mf.getValue('latex-expanded'); } catch (e) { t = mf.value; }
    return t.replace(/\\placeholder(\[[^\]]*\])?\{[^}]*\}/g, '').replace(/\\mleft/g, '\\left').replace(/\\mright/g, '\\right').trim();
  };
  function loadMathLive() {
    if (mlLoad) return mlLoad;
    mlLoad = new Promise(res => {
      const sc = document.createElement('script');
      // The host says where its files are (application: /__mdr/…; web and VS Code: their own URLs).
      sc.src = B.edit.mathlive || '/__mdr/mathlive/mathlive.min.js';
      if (B.edit.nonce) sc.nonce = B.edit.nonce;
      sc.onerror = () => res(false);
      sc.onload = () => {
        try {
          const ME = window.MathfieldElement;
          ME.fontsDirectory = new URL(B.edit.fonts || '/__mdr/katex/fonts', document.baseURI).href;
          ME.soundsDirectory = null;
          try { ME.locale = 'fr'; } catch (e) { }
          const f = new ME();
          f.id = 'mField';
          f.mathVirtualKeyboardPolicy = 'manual';
          f.smartMode = false;
          f.letterShapeStyle = 'tex';
          f.addEventListener('beforeinput', () => { if (!fieldBusy) fieldDirty = true; });
          f.addEventListener('input', () => { if (fieldBusy) return; fieldDirty = true; mTa.value = fromField(); placePanel(); });
          f.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); closePanel(); } }, true);
          $('#mPrev').replaceWith(f);
          pMath.classList.add('ml');
          mf = f;
          res(true);
        } catch (err) { res(false); }
      };
      document.head.appendChild(sc);
    });
    return mlLoad;
  }
  // A palette snippet in MathLive's insert syntax: #@ = what precedes the caret (x → x²),
  // #0 = the selection, #? = an empty field.
  const toField = sn => (sn.startsWith('{@}') ? '#@' + sn.slice(3) : sn.replace('@', '#0')).replace(/\{\}/g, '{#?}').replace(/\[\]/g, '[#?]').replace(/ {2}/g, ' #? ');
  function previewMath() {
    if (mf) return;
    const pv = $('#mPrev'), tex = $('#mTex').value.trim();
    pv.classList.remove('err');
    if (!tex) { pv.textContent = ''; return; }
    try { window.katex.render(tex, pv, { displayMode: true, throwOnError: true, strict: 'ignore', output: 'html' }); }
    catch (err) { pv.classList.add('err'); pv.textContent = String(err && err.message || err).replace(/^KaTeX parse error: /, ''); }
  }
  $('#mTex').addEventListener('input', () => { if (mf) setField(mTa.value); else previewMath(); });
  // ---- equation editor: palettes of symbols and structures ----
  // An entry is a LaTeX snippet, or [snippet, what the button shows]. In a snippet, @ is
  // where the caret goes (or the selected text); empty {} are the next fields (Tab).
  const M2 = env => ['\\begin{' + env + '} @ &  \\\\  &  \\end{' + env + '}', '\\begin{' + env + '}\\square&\\square\\\\\\square&\\square\\end{' + env + '}'];
  const PALS = [
    ['struct', 'x² √', 'Exposants, fractions, racines', ['{@}^{}', '{@}_{}', '{@}_{}^{}', '\\frac{@}{}', '\\dfrac{@}{}', '\\sqrt{@}', '\\sqrt[]{@}', '\\binom{@}{}',
      ['\\left| @ \\right|', '\\left|\\square\\right|'], ['\\left\\| @ \\right\\|', '\\left\\|\\square\\right\\|'], '\\overline{@}', '\\underline{@}', '\\overbrace{@}^{}', '\\underbrace{@}_{}',
      '\\boxed{@}', '\\cancel{@}', ['\\text{@}', '\\text{abc}'], ['\\mathbf{@}', '\\mathbf{A}'], ['\\mathrm{@}', '\\mathrm{A}'], ['\\mathcal{@}', '\\mathcal{A}'], ['\\mathbb{@}', '\\mathbb{A}'], ['\\color{red}{@}', '\\color{red}{\\square}'], ['\\quad', '\\text{␣␣}'], ['\\\\', '\\hookleftarrow']]],
    ['big', '∑ ∫', 'Sommes, intégrales, limites, dérivées', ['\\sum_{@}^{}', ['\\sum_{i=1}^{n} @', '\\sum_{i=1}^{n}'], '\\prod_{@}^{}', '\\int @', '\\int_{@}^{}', ['\\int_{a}^{b} @ \\,\\mathrm{d}x', '\\int_a^b\\!\\square\\,\\mathrm{d}x'], '\\iint_{@}', '\\iiint_{@}', '\\oint_{@}',
      ['\\lim_{@ \\to }', '\\lim_{\\square\\to\\square}'], ['\\lim_{n \\to \\infty} @', '\\lim_{n\\to\\infty}'], ['\\lim_{x \\to 0} @', '\\lim_{x\\to 0}'], '\\max_{@}', '\\min_{@}', '\\sup_{@}', '\\inf_{@}', '\\bigcup_{@}^{}', '\\bigcap_{@}^{}',
      ['\\frac{\\mathrm{d} @}{\\mathrm{d}x}', '\\frac{\\mathrm{d}}{\\mathrm{d}x}'], ['\\frac{\\mathrm{d}^2 @}{\\mathrm{d}x^2}', '\\frac{\\mathrm{d}^2}{\\mathrm{d}x^2}'], ['\\frac{\\partial @}{\\partial x}', '\\frac{\\partial}{\\partial x}'], ['\\frac{\\partial^2 @}{\\partial x^2}', '\\frac{\\partial^2}{\\partial x^2}'], ['\\left. @ \\right|_{}', '\\left.\\square\\right|_{\\square}'], ['\\,\\mathrm{d}x', '\\mathrm{d}x']]],
    ['greek', 'αβγ', 'Lettres grecques', 'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega'.split(' ').map(x => '\\' + x)],
    ['ops', '± ≤ ∈', 'Opérateurs, relations, ensembles', 'pm mp times div cdot ast circ bullet oplus otimes leq geq neq approx equiv sim simeq cong propto ll gg infty partial nabla forall exists nexists in notin ni subset subseteq supset supseteq cup cap emptyset setminus land lor neg angle perp parallel mid nmid ldots cdots vdots ddots hbar ell Re Im aleph prime dagger'.split(' ').map(x => '\\' + x)
      .concat([['^\\circ', '{}^\\circ'], '\\mathbb{R}', '\\mathbb{N}', '\\mathbb{Z}', '\\mathbb{Q}', '\\mathbb{C}'])],
    ['arrows', '→ ⇒', 'Flèches', 'to leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow mapsto longrightarrow Longrightarrow longmapsto implies iff uparrow downarrow updownarrow Uparrow Downarrow nearrow searrow swarrow nwarrow hookrightarrow rightharpoonup rightleftharpoons leadsto'.split(' ').map(x => '\\' + x)
      .concat(['\\xrightarrow{@}', '\\xleftarrow{@}', '\\overrightarrow{@}', '\\overleftarrow{@}'])],
    ['delim', '( ) [ ]', 'Parenthèses, matrices, systèmes', [['\\left( @ \\right)', '\\left(\\square\\right)'], ['\\left[ @ \\right]', '\\left[\\square\\right]'], ['\\left\\{ @ \\right\\}', '\\left\\{\\square\\right\\}'], ['\\langle @ \\rangle', '\\langle\\square\\rangle'], ['\\lfloor @ \\rfloor', '\\lfloor\\square\\rfloor'], ['\\lceil @ \\rceil', '\\lceil\\square\\rceil'],
      M2('pmatrix'), M2('bmatrix'), M2('vmatrix'), M2('matrix'),
      ['\\begin{pmatrix} @ &  &  \\\\  &  &  \\\\  &  &  \\end{pmatrix}', '\\begin{pmatrix}\\square&\\square&\\square\\\\\\square&\\square&\\square\\\\\\square&\\square&\\square\\end{pmatrix}'],
      ['\\begin{pmatrix} @ \\\\  \\end{pmatrix}', '\\begin{pmatrix}\\square\\\\\\square\\end{pmatrix}'],
      ['\\begin{cases} @ & \\text{si }  \\\\  & \\text{sinon} \\end{cases}', '\\begin{cases}\\square&\\square\\\\\\square&\\square\\end{cases}'],
      ['\\begin{aligned} @ &=  \\\\ &=  \\end{aligned}', '\\begin{aligned}\\square&=\\square\\\\&=\\square\\end{aligned}'],
      ['\\begin{array}{c|c} @ &  \\\\ \\hline  &  \\end{array}', '\\begin{array}{c|c}\\square&\\square\\\\\\hline\\square&\\square\\end{array}']]],
    ['accents', 'â ā', 'Accents et vecteurs', ['hat', 'bar', 'vec', 'dot', 'ddot', 'tilde', 'check', 'breve', 'acute', 'grave', 'widehat', 'widetilde', 'overrightarrow', 'mathring'].map(x => ['\\' + x + '{@}', '\\' + x + '{a}'])],
    ['funcs', 'sin', 'Fonctions', 'sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh ln log exp det dim ker gcd deg arg'.split(' ').map(x => '\\' + x).concat(['\\log_{@}', ['\\operatorname{@}', '\\operatorname{f}'], 'e^{@}', ['e^{i\\pi}', 'e^{i\\pi}'], '10^{@}'])],
  ];
  const mTabs = $('#mTabs'), mGrid = $('#mGrid'), mTa = $('#mTex');
  const shown = it => (Array.isArray(it) ? it[1] : it.replace('@', '').replace(/\{\}/g, '{\\square}').replace(/\[\]/g, '[\\square]'));
  const snip = it => (Array.isArray(it) ? it[0] : it);
  const cellHtml = new Map();
  function cell(it, big) {
    const sn = snip(it);
    if (!cellHtml.has(sn)) {
      let h; try { h = window.katex.renderToString((big ? '\\displaystyle ' : '') + shown(it), { throwOnError: false, strict: 'ignore', output: 'html' }); } catch (e) { h = esc(sn); }
      cellHtml.set(sn, `<button class="mc" data-s="${esc(sn)}" title="${esc(sn.replace('@', '').replace(/\s+/g, ' '))}">${h}</button>`);
    }
    return cellHtml.get(sn);
  }
  const byShown = new Map(); PALS.forEach(p => p[3].forEach(it => byShown.set(snip(it), it)));
  function showPal(id) {
    const rec = (prefs.mathRecent || []).filter(x => typeof x === 'string').slice(0, 24);
    if (id === 'recent' && !rec.length) id = 'struct';
    if (!PALS.some(p => p[0] === id) && id !== 'recent') id = 'struct';
    mTabs.innerHTML = (rec.length ? '<button data-p="recent" title="Récemment utilisés">Récents</button>' : '') + PALS.map(p => `<button data-p="${p[0]}" title="${p[2]}">${p[1]}</button>`).join('');
    for (const b of mTabs.children) b.classList.toggle('on', b.dataset.p === id);
    const items = id === 'recent' ? rec.map(x => byShown.get(x) || x) : PALS.find(p => p[0] === id)[3];
    mGrid.className = id === 'delim' || id === 'big' ? 'wide' : '';
    mGrid.innerHTML = items.map(it => cell(it, id === 'big')).join('');
    mGrid.dataset.p = id;
  }
  function insertSnippet(sn) {
    prefs.mathRecent = [sn].concat((prefs.mathRecent || []).filter(x => x !== sn)).slice(0, 24);
    savePrefs();
    if (mf) { mf.focus(); mf.executeCommand(['insert', toField(sn), { focus: true, selectionMode: 'placeholder' }]); fieldDirty = true; mTa.value = fromField(); placePanel(); return; }
    const a = mTa.selectionStart, picked = mTa.value.slice(a, mTa.selectionEnd), at = sn.indexOf('@');
    let text = at >= 0 ? sn.replace('@', picked) : sn;
    if (at < 0 && /\\[a-zA-Z]+$/.test(sn)) text += ' ';
    mTa.focus();
    document.execCommand('insertText', false, text);
    let pos = a + text.length;
    if (at >= 0 && !picked) pos = a + at;
    else if (at >= 0) { const k = text.indexOf('{}', at + picked.length); if (k >= 0) pos = a + k + 1; }
    mTa.setSelectionRange(pos, pos);
    previewMath();
  }
  for (const box of [mTabs, mGrid]) box.addEventListener('mousedown', e => e.preventDefault());      // the caret stays in the formula
  mTabs.addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (!b) return; prefs.mathTab = b.dataset.p; savePrefs(); showPal(b.dataset.p); placePanel(); });
  mGrid.addEventListener('click', e => { const b = e.target.closest('.mc'); if (b) insertSnippet(b.dataset.s); });
  mTa.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closePanel(); return; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {         // next (or previous) empty field
      e.preventDefault();
      const v = mTa.value, c = mTa.selectionStart;
      const fields = []; for (const m of v.matchAll(/\{\}|\[\]|& {2}(?=\\\\|&|\\end)|\\\\ {2}(?=&)/g)) fields.push(m.index + (m[0][0] === '{' || m[0][0] === '[' ? 1 : m[0][0] === '&' ? 2 : 3));
      const next = e.shiftKey ? fields.filter(f => f < c).pop() : fields.find(f => f > c);
      if (next != null) mTa.setSelectionRange(next, next);
      else if (!e.shiftKey) { const k = v.slice(c).search(/[}\]]/); const to = k >= 0 ? c + k + 1 : v.length; mTa.setSelectionRange(to, to); }
    }
  });
  $('#mOk').addEventListener('click', () => closePanel());

  /* =====================================================================
   *  Reader <-> editor, rendered <-> source
   * ===================================================================== */
  // Where we are in the document, as "between heading h and the next one": the headings
  // are the same in the reader, the rendered editor and the source.
  function headTop(i) {
    const H = app._.heads(), box = content.getBoundingClientRect();
    if (i < 0) return box.top;
    if (i >= H.length) return box.bottom;
    return H[i] ? H[i].getBoundingClientRect().top : NaN;
  }
  function getAnchor() {
    const max = document.documentElement.scrollHeight - innerHeight, y = barH() + 10, n = app._.heads().length;
    let lo = -1, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (!(headTop(mid) > y)) lo = mid; else hi = mid - 1; }
    const a = headTop(lo), b = headTop(lo + 1);
    return { h: lo, n, frac: b > a ? Math.min(1, Math.max(0, (y - a) / (b - a))) : 0, ratio: max > 0 ? scrollY / max : 0, top: scrollY < 4 };
  }
  function applyAnchor(a) {
    const go = () => {
      if (a.top) return scrollTo(0, 0);
      if (a.n && app._.heads().length === a.n) { const s = headTop(a.h), e = headTop(a.h + 1); if (s === s && e === e) return scrollBy(0, s + a.frac * (e - s) - barH() - 10); }
      scrollTo(0, a.ratio * (document.documentElement.scrollHeight - innerHeight));
    };
    // Sections are laid out as they come near the screen: settle over a few frames.
    go(); requestAnimationFrame(() => { go(); requestAnimationFrame(() => { go(); setTimeout(go, 60); }); });
  }
  function topIndex(list) {
    const y = barH() + 10;
    let lo = 0, hi = list.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].getBoundingClientRect().bottom > y) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
    return ans;
  }

  async function showSurface(focus) {
    const text = S.text;
    if (S.view === 'rich') {
      if (S.richText !== text) { buildRich(await ask('blocks', { text })); S.richText = text; HE.reset(); }
      content.replaceChildren(ed);
      if (ed.children.length < 12) for (const m of $$('.math:not([data-r])', ed)) quiet(() => app._.renderMath(m));
    } else {
      if (S.rawText !== text) { setPlain(raw, text, true); S.rawText = text; HR.reset(); }
      content.replaceChildren(raw);
    }
    S.stale = false;
    body.classList.toggle('ed-raw', S.view === 'raw');
    swView.classList.toggle('b', S.view === 'raw');
    updateToc(); updateTools();
    if (focus) { if (S.view === 'rich') { if (!range()) caretIn(blocks()[0] || ed, false); else ed.focus({ preventScroll: true }); } else { raw.focus({ preventScroll: true }); if (!plainSel(raw)) setPlainSel(raw, 0); } }
  }

  async function setMode(mode) {
    if (mode === S.mode || S.busy) return;
    S.busy = true;
    try {
      closePanel(); closePop();
      const anchor = getAnchor();
      if (mode === 'edit') {
        if (S.text === null) { S.text = (await ask('source')).text; S.readerText = S.text; }
        readerNodes = [...content.childNodes]; readerToc = toc.innerHTML;
        S.mode = 'edit'; app.editing = true;
        body.classList.add('editing'); body.classList.toggle('tools', MD);
        app.barExtra = MD ? 40 : 0;
        await showSurface(false);
        if (MD) setTimeout(loadMathLive, 600);       // ready before the first formula is opened
      } else {
        const text = currentText();
        H().commit();
        S.mode = 'read'; app.editing = false;
        body.classList.remove('editing', 'tools', 'ed-raw'); app.barExtra = 0;
        tblBar.classList.remove('show');
        if (text !== S.readerText) {
          const r = await ask('render', { text });
          content.innerHTML = r.body; toc.innerHTML = r.toc; S.readerText = text; readerNodes = null;
        } else { content.replaceChildren(...readerNodes); toc.innerHTML = readerToc; }
        app._.initDoc();
        getSelection().removeAllRanges();
      }
      swMode.classList.toggle('b', S.mode !== 'edit');
      swMode.setAttribute('aria-checked', S.mode === 'edit');
      send({ cmd: 'mode', value: S.mode });
      applyAnchor(anchor);
      if (S.mode === 'edit') { if (S.view === 'rich') { caretIn(firstVisibleBlock() || ed, false); } else { raw.focus({ preventScroll: true }); } }
      dispatchEvent(new Event('scroll'));
    } finally { S.busy = false; }
  }
  function firstVisibleBlock() {
    const kids = blocks(), i = topIndex(kids);
    for (let k = Math.max(0, i); k < kids.length; k++) if (/^(P|H[1-6]|UL|OL|BLOCKQUOTE)$/.test(kids[k].tagName) && !kids[k].classList.contains('mathp')) return kids[k];
    return kids[0];
  }
  async function setView(view) {
    if (!MD || view === S.view || S.busy) return;
    prefs.edView = view; savePrefs();
    if (S.mode !== 'edit') { S.view = view; swView.classList.toggle('b', view === 'raw'); return; }
    S.busy = true;
    try {
      closePanel();
      const anchor = getAnchor();
      currentText(); H().commit();
      S.view = view;
      await showSurface(true);
      applyAnchor(anchor);
    } finally { S.busy = false; }
  }
  app.beforeExport = async () => { if (S.mode === 'edit') await setMode('read'); };

  /* ---------------- Saving ---------------- */
  function save(as) {
    if (B.edit.hostSave) { closePanel(); return send({ cmd: as ? 'saveAs' : 'save' }); }
    if (S.text === null && !as) return toast('Aucune modification à enregistrer', 1500);
    if (S.text === null) return;
    if (!S.dirty && !as && !B.edit.untitled) return toast('Aucune modification à enregistrer', 1500);
    closePanel();
    let text = currentText();
    if (MD && text && !text.endsWith('\n')) text += '\n';
    send({ cmd: 'save', text, as: !!as });
  }
  // Hosts that drive saving themselves (VS Code) ask for the text.
  app.getText = () => { if (S.text === null) return null; let t = currentText(); if (MD && t && !t.endsWith('\n')) t += '\n'; return t; };
  app.saveNow = () => { if (S.text === null) { S.text = ''; } const t = currentText(); send({ cmd: 'save', text: t, as: false }); };
  app.onSaved = d => {
    setDirty(false);
    B.edit.untitled = false; B.file = d.name;
    $('#docTitle').textContent = d.name.replace(/\.md$/i, '');
    toast(d.msg || 'Enregistré', 1400);
  };
  app.saveFailed = msg => { if (msg) toast(msg, 4500); };
  app.changedOnDisk = () => toast('Le fichier a été modifié par un autre programme', 9000, 'Recharger', () => send({ cmd: 'reload' }));

  /* ---------------- Keyboard (called first by app.js) ---------------- */
  app.onKey = (e, c, lk) => {
    const hit = fn => { e.preventDefault(); e.stopPropagation(); fn(); return true; };
    // Escape first closes MathLive's own menu, if it is open.
    if (e.key === 'Escape' && panel === pMath && mf && mf.shadowRoot && [...mf.shadowRoot.querySelectorAll('[role=menu], .ui-menu-container')].some(m => m.getClientRects().length)) return false;
    if (e.key === 'Escape' && panel) return hit(() => { const m = panel === pMath; closePanel(true); if (!m) backToText(); });
    if (!c || e.altKey) return false;
    if (lk === 'n') return hit(() => send({ cmd: 'new' }));
    if (lk === 'e') return hit(() => (e.shiftKey ? setView(S.view === 'rich' ? 'raw' : 'rich') : setMode(S.mode === 'edit' ? 'read' : 'edit')));
    if (lk === 's') {
      if (B.edit.hostSave) return hit(() => send({ cmd: e.shiftKey ? 'saveAs' : 'save' }));      // VS Code saves and asks for the text
      if (e.shiftKey) return hit(() => { if (S.text === null) ask('source').then(r => { S.text = S.readerText = r.text; save(true); }); else save(true); });
      if (S.mode === 'edit' || S.dirty || B.edit.untitled) return hit(() => save(false));
      return false;                                   // reader, nothing to save: HTML export as before
    }
    if (lk === 'z' || lk === 'y') {
      if (S.mode !== 'edit') return hit(() => { });
      if (e.target.closest && e.target.closest('.epop')) return false;
      return hit(lk === 'y' || e.shiftKey ? redo : undo);
    }
    if (S.mode !== 'edit' || !MD) return false;
    if (e.target.closest && e.target.closest('.epop, #find, #side')) return false;
    if (lk === 'b' && !e.shiftKey) return hit(() => runTool('bold', tools));
    if (lk === 'i' && !e.shiftKey) return hit(() => runTool('italic', tools));
    if (lk === 'u' && !e.shiftKey) return hit(() => runTool('underline', tools));
    if (lk === 'x' && e.shiftKey) return hit(() => runTool('strike', tools));
    if (lk === 'k') return hit(() => openLink());
    return false;
  };

  /* ---------------- Help ---------------- */
  const keys = $('#pHelp .keys');
  if (keys) {
    keys.insertAdjacentHTML('beforeend', [
      ['Ctrl+E', 'Lecture / Édition'], ['Ctrl+Maj+E', 'Rendu / Source (Markdown)'], ['Ctrl+S · Ctrl+Maj+S', 'Enregistrer · Enregistrer sous'],
      ['Ctrl+N', 'Nouveau document'], ['Clic sur une formule', 'Éditeur d’équations (symboles, fractions, matrices…)'], ['Ctrl+Z · Ctrl+Y', 'Annuler · Rétablir'], ['Ctrl+B / I / U · Ctrl+K', 'Gras, italique, souligné · Lien'],
      ['# · - · 1. · > · ``` · $$', 'Titre, listes, citation, code, formule (en tapant)'], ['Ctrl+Maj+H', 'Exporter en HTML'],
    ].map(([k, d]) => `<tr><td>${k}</td><td>${d}</td></tr>`).join(''));
    for (const td of $$('td:first-child', keys)) if (td.textContent === 'Ctrl+S') td.parentNode.remove();
    for (const td of $$('td:first-child', keys)) if (td.textContent === 'Ctrl+B') td.nextElementSibling.textContent = 'Afficher / masquer le sommaire (lecture)';
  }
  const hk = $('#pExport [data-act="html"] kbd'); if (hk) hk.textContent = 'Ctrl+Maj+H';
  if (B.edit.newInMenu) {       // browsers keep Ctrl+N for themselves
    $('#pExport').insertAdjacentHTML('afterbegin', '<button data-act="newdoc"><span>Nouveau document</span></button>');
    $('#pExport').addEventListener('click', e => { if (e.target.closest('[data-act="newdoc"]')) { e.stopPropagation(); closePop(); send({ cmd: 'new' }); } }, true);
  }
  $('#pExport').insertAdjacentHTML('afterbegin', '<button data-act="saveas"><span>Enregistrer sous…</span><kbd>Ctrl+Maj+S</kbd></button>');
  $('#pExport').addEventListener('click', e => { if (e.target.closest('[data-act="saveas"]')) { e.stopPropagation(); closePop(); if (S.text === null) ask('source').then(r => { S.text = S.readerText = r.text; save(true); }); else save(true); } }, true);

  document.execCommand('defaultParagraphSeparator', false, 'p');
  if (B.edit.start) setMode('edit');

  app._ed = { serialize, currentText, ed, raw, plainText };      // for automated tests
})();
