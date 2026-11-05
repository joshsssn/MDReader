(() => {
  'use strict';
  const B = window.__BOOT || {};
  const SA = !!B.standalone; // exported HTML file (no Rust host)
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const html = document.documentElement, body = document.body;
  const content = $('#content'), toc = $('#toc');
  const send = (o) => { if (!SA && window.ipc) window.ipc.postMessage(JSON.stringify(o)); };
  const app = (window.app = {});
  if (SA) body.classList.add('sa');

  const THEMES = [
    { id: 'papier', name: 'Papier', dark: false, bg: '#f7f2e8', fg: '#2b2620', ac: '#b5562c' },
    { id: 'brume', name: 'Brume', dark: false, bg: '#f2f4f8', fg: '#1c2530', ac: '#3561c4' },
    { id: 'sauge', name: 'Sauge', dark: false, bg: '#f0f3ec', fg: '#212a1f', ac: '#4a7a37' },
    { id: 'nuit', name: 'Nuit', dark: true, bg: '#262624', fg: '#e8e3d9', ac: '#d97757' },
    { id: 'abysse', name: 'Abysse', dark: true, bg: '#101724', fg: '#d6dfec', ac: '#7aa2f7' },
    { id: 'aubergine', name: 'Aubergine', dark: true, bg: '#1f1b27', fg: '#e7e1f1', ac: '#c39bff' },
    { id: 'foret', name: 'Forêt', dark: true, bg: '#18201c', fg: '#dde7de', ac: '#8cc084' },
  ];

  /* ---------------- Preferences ---------------- */
  const DEF = { dayTheme: 'papier', nightTheme: 'nuit', night: false, font: 'serif', width: 'normal', lh: 'normal', fs: 13.5, side: true, sideW: 300, tocDepth: 6 };
  const prefs = Object.assign({}, DEF, (B.prefs && typeof B.prefs === 'object') ? B.prefs : {});
  if (SA) { try { Object.assign(prefs, JSON.parse(localStorage.getItem('mdr-prefs') || '{}')); } catch (e) { } }
  function savePrefs() {
    if (SA) { try { localStorage.setItem('mdr-prefs', JSON.stringify(prefs)); } catch (e) { } }
    else send({ cmd: 'prefs', prefs });
  }
  function themeId() { return prefs.night ? prefs.nightTheme : prefs.dayTheme; }
  function applyPrefs() {
    const t = THEMES.find(t => t.id === themeId()) || THEMES[0];
    html.dataset.theme = t.id;
    html.dataset.dark = t.dark ? '1' : '0';
    html.dataset.font = prefs.font;
    html.dataset.width = prefs.width;
    html.dataset.lh = prefs.lh;
    prefs.fs = clampFs(prefs.fs);
    html.style.setProperty('--fs', prefs.fs + 'pt');
    $('#fsVal').textContent = String(prefs.fs).replace('.', ',') + ' pt';
    $('#fsDef').classList.toggle('on', prefs.fs === DEF.fs);
    html.style.setProperty('--side-w', prefs.sideW + 'px');
    body.classList.toggle('noside', !prefs.side);
    toc.dataset.depth = prefs.tocDepth;
    $('#bSide').classList.toggle('on', !!prefs.side);
    $$('.sw').forEach(b => b.classList.toggle('on', b.dataset.id === t.id));
    $$('.seg[data-pref]').forEach(s => $$('button', s).forEach(b => b.classList.toggle('on', b.dataset.v === String(prefs[s.dataset.pref]))));
    $$('#tocDepth button').forEach(b => b.classList.toggle('on', b.dataset.v === String(prefs.tocDepth)));
  }
  function clampFs(v) { v = Math.round((+v || DEF.fs) * 2) / 2; return Math.max(9, Math.min(28, v)); }
  function setPref(k, v, save = true) {
    keepAnchor(); prefs[k] = v; applyPrefs();
    restoreAnchor(); requestAnimationFrame(restoreAnchor);
    if (save) savePrefs();
    if (active >= 0) markActive(active, true);
  }
  function fontStep(d) { setPref('fs', clampFs(prefs.fs + d)); toast('Texte : ' + $('#fsVal').textContent, 1200); }
  $('#fsDef').addEventListener('click', () => setPref('fs', DEF.fs));
  $$('[data-fs]').forEach(b => b.addEventListener('click', () => setPref('fs', clampFs(prefs.fs + +b.dataset.fs))));
  function toggleNight() { setPref('night', !prefs.night); }

  $$('.themes').forEach(box => {
    const dark = box.dataset.kind === 'night';
    box.innerHTML = THEMES.filter(t => t.dark === dark).map(t =>
      `<button class="sw" data-id="${t.id}" style="--sbg:${t.bg};--sfg:${t.fg};--sac:${t.ac}"><span class="pv">Aa<i></i></span>${t.name}</button>`).join('');
  });
  document.addEventListener('click', e => {
    const sw = e.target.closest('.sw');
    if (sw) {
      const t = THEMES.find(t => t.id === sw.dataset.id);
      keepAnchor();
      if (t.dark) { prefs.nightTheme = t.id; prefs.night = true; } else { prefs.dayTheme = t.id; prefs.night = false; }
      applyPrefs(); savePrefs(); return;
    }
    const sb = e.target.closest('.seg[data-pref] button');
    if (sb) { setPref(sb.parentElement.dataset.pref, sb.dataset.v); return; }
    const db = e.target.closest('#tocDepth button');
    if (db) { setPref('tocDepth', +db.dataset.v); return; }
  });

  /* ---------------- Toast ---------------- */
  let toastT;
  function toast(msg, ms = 2200, btn, onBtn) {
    $('#toastMsg').textContent = msg;
    const b = $('#toastBtn');
    if (btn) { b.hidden = false; b.textContent = btn; b.onclick = () => { hideToast(); onBtn(); }; } else b.hidden = true;
    $('#toast').classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(hideToast, ms);
  }
  function hideToast() { $('#toast').classList.remove('show'); }
  app.toast = toast;
  app.saved = (msg, path) => toast(msg, 6000, 'Ouvrir', () => send({ cmd: 'reveal', path }));
  app.pdfCancelled = hideToast;

  /* ---------------- Popovers ---------------- */
  let openPop = null;
  function showPop(p, anchor) {
    closePop();
    p.classList.add('show');
    p.style.right = '';
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      p.style.right = Math.max(8, innerWidth - r.right - 4) + 'px';
    }
    openPop = p;
  }
  function closePop() { if (openPop) { openPop.classList.remove('show'); openPop = null; } }
  $$('[data-pop]').forEach(b => b.addEventListener('click', () => {
    const p = $('#' + b.dataset.pop);
    if (openPop === p) closePop(); else showPop(p, b);
  }));
  document.addEventListener('mousedown', e => {
    if (openPop && !openPop.contains(e.target) && !e.target.closest('[data-pop]')) closePop();
  });
  $('#pExport').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    closePop();
    ({ pdf: doPdf, html: doHtml, print: doPrint })[b.dataset.act]();
  });

  /* ---------------- Geometry helpers ---------------- */
  let fs = false;
  const barH = () => (fs ? 0 : $('#bar').offsetHeight);
  // The deepest content element at the top of the viewport.
  function topElement() {
    const r = content.getBoundingClientRect();
    const x = r.left + Math.min(80, r.width / 2), y = barH() + 6;
    let el = document.elementsFromPoint(x, y).find(e => content.contains(e) && e !== content);
    if (!el) return null;
    const m = el.closest('.math'); if (m) el = m;
    return el;
  }

  /* ---------------- Zoom (Chrome-like) ---------------- */
  const STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
  let zoom = Math.round(B.zoom || 100), zoomT;
  function zoomTo(z) {
    z = Math.max(25, Math.min(500, Math.round(z)));
    if (z !== zoom) { keepAnchor(); zoom = z; send({ cmd: 'zoom', value: z }); }
    showZoom(true);
  }
  function zoomStep(d) {
    const next = d > 0 ? STEPS.find(s => s > zoom) : STEPS.slice().reverse().find(s => s < zoom);
    if (next) zoomTo(next); else showZoom(true);
  }
  function showZoom(bubble) {
    $('#zVal').textContent = zoom + ' %';
    const ind = $('#bZoom');
    ind.textContent = zoom + ' %';
    ind.hidden = SA || zoom === 100;
    if (!bubble) return;
    const p = $('#pZoom');
    if (openPop !== p) showPop(p, null);
    clearTimeout(zoomT);
    zoomT = setTimeout(() => { if (openPop === p && !p.matches(':hover')) closePop(); }, 1800);
  }
  $('#pZoom').addEventListener('click', e => {
    const b = e.target.closest('[data-z]'); if (!b) return;
    const d = +b.dataset.z; d === 0 ? zoomTo(100) : zoomStep(d);
  });
  $('#pZoom').addEventListener('mouseleave', () => { clearTimeout(zoomT); zoomT = setTimeout(() => { if (openPop === $('#pZoom')) closePop(); }, 1200); });
  // Ctrl + mouse wheel = page zoom (handled here). A touchpad pinch also arrives as
  // ctrl+wheel, but as a stream of tiny deltas (~0.5–3) while a mouse notch is ≥ 50:
  // let pinches through so the webview does its native pinch zoom on the area under
  // the fingers, like Chrome.
  let wheelAcc = 0, wheelT, pinchUntil = 0;
  addEventListener('wheel', e => {
    if (!e.ctrlKey || SA) return;
    const now = performance.now();
    const tiny = e.deltaMode === 0 && Math.abs(e.deltaY) < 40;
    if (tiny || now < pinchUntil) { pinchUntil = now + 250; return; }
    e.preventDefault();
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    clearTimeout(wheelT); wheelT = setTimeout(() => (wheelAcc = 0), 250);
    if (Math.abs(wheelAcc) >= 50) { zoomStep(wheelAcc < 0 ? 1 : -1); wheelAcc = 0; }
  }, { passive: false });

  // Keep the reading position when the layout changes (zoom, theme, width, resize).
  let anchor = null, anchorT;
  function keepAnchor() {
    const el = topElement(); if (!el) return;
    anchor = { el, top: el.getBoundingClientRect().top / innerHeight };
    clearTimeout(anchorT); anchorT = setTimeout(() => (anchor = null), 600);
  }
  function restoreAnchor() {
    if (!anchor || !anchor.el.isConnected) return;
    const r = anchor.el.getBoundingClientRect();
    scrollBy(0, r.top - anchor.top * innerHeight);
  }
  let lastW = innerWidth, lastH = innerHeight;
  addEventListener('resize', () => {
    if (!anchor && (innerWidth !== lastW)) { /* window resize: anchor on the last known element */ if (lastTop) anchor = { el: lastTop.el, top: lastTop.top }; }
    lastW = innerWidth; lastH = innerHeight;
    restoreAnchor();
    requestAnimationFrame(restoreAnchor);
    clearTimeout(anchorT); anchorT = setTimeout(() => (anchor = null), 400);
  });

  /* ---------------- Fullscreen ---------------- */
  function toggleFs() {
    keepAnchor();
    if (SA) { document.fullscreenElement ? document.exitFullscreen() : html.requestFullscreen(); }
    else send({ cmd: 'fullscreen' });
  }
  app.onFullscreen = v => {
    fs = !!v;
    body.classList.toggle('fs', fs);
    body.classList.remove('reveal');
    $('#bFull').classList.toggle('on', fs);
    if (fs) toast('Plein écran — Échap ou F11 pour quitter');
  };
  document.addEventListener('fullscreenchange', () => { if (SA) app.onFullscreen(!!document.fullscreenElement); });
  addEventListener('mousemove', e => {
    if (!fs) return;
    if (e.clientY < 8) body.classList.add('reveal');
    else if (e.clientY > $('#bar').offsetHeight + 30 && !openPop) body.classList.remove('reveal');
  });
  $('#bFull').addEventListener('click', toggleFs);
  $('#bNight').addEventListener('click', toggleNight);
  $('#bSide').addEventListener('click', () => setPref('side', !prefs.side));
  $('#bOpen').addEventListener('click', () => send({ cmd: 'open' }));
  $('#bFind').addEventListener('click', () => (findOpen ? closeFind() : openFind()));

  /* ---------------- Welcome screen ---------------- */
  if (!B.hasDoc) {
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rec = (B.recent || []).map(r =>
      `<div class="r" data-path="${esc(r.path)}"><b>${esc(r.name)}</b><small>${esc(r.dir)}</small><button class="x" title="Retirer de la liste">×</button></div>`).join('');
    content.innerHTML = `<div class="welcome">
      <div class="logo"><svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h10M5 17h12"/></svg></div>
      <h1>MDReader</h1>
      <p class="lead">Lecteur Markdown rapide — sommaire, maths, tableaux, recherche, export PDF/HTML.</p>
      <button class="open">Ouvrir un fichier…<kbd>Ctrl+O</kbd></button>
      ${rec ? `<h3>Récents</h3><div class="recent">${rec}</div>` : ''}
      <div class="drop">ou glisse un fichier .md n'importe où dans la fenêtre</div>
    </div>`;
    $('.welcome .open').addEventListener('click', () => send({ cmd: 'open' }));
    content.addEventListener('click', e => {
      const r = e.target.closest('.r'); if (!r) return;
      if (e.target.closest('.x')) { send({ cmd: 'forget', path: r.dataset.path }); r.remove(); return; }
      send({ cmd: 'openPath', path: r.dataset.path });
    });
  }

  /* ---------------- TOC & scroll spy ---------------- */
  const links = $$('a', toc);
  const levels = links.map(a => +a.className.slice(1, 2) || 1);
  const sections = $$('.sec', content);
  const secIndex = new Map(sections.map((s, i) => [s, i]));
  const heads = links.map(a => document.getElementById(a.getAttribute('href').slice(1)));
  const secHeads = sections.map(() => []);
  heads.forEach((h, i) => {
    if (!h) return;
    const si = secIndex.get(h.closest('.sec'));
    if (si !== undefined) secHeads[si].push(i);
  });

  let active = -1, shown = -1;
  function markActive(i, force) {
    // Highlight the closest visible ancestor when the active heading is hidden by the depth filter.
    let j = i;
    while (j > 0 && levels[j] > prefs.tocDepth) j--;
    if (j === shown && !force) return;
    if (shown >= 0 && links[shown]) links[shown].classList.remove('on');
    shown = j;
    if (j < 0 || !links[j]) return;
    const a = links[j];
    a.classList.add('on');
    if (prefs.side) {
      const tr = toc.getBoundingClientRect(), ar = a.getBoundingClientRect();
      if (ar.top < tr.top + 30 || ar.bottom > tr.bottom - 30) toc.scrollTop += ar.top - tr.top - tr.height / 3;
    }
  }
  function setActive(i) {
    if (i === active) return;
    active = i;
    $('#secTitle').textContent = i >= 0 ? links[i].textContent : '';
    markActive(i);
  }
  function currentSection() {
    if (!sections.length) return -1;
    const r = content.getBoundingClientRect();
    const y = barH() + 24;
    if (r.top > y) return 0;
    // Probe a few points: the gaps between sections (collapsed margins) belong to no section.
    for (let yy = y; yy < innerHeight; yy += 24) {
      const el = document.elementsFromPoint(r.left + r.width / 2, yy).find(e => e !== content && content.contains(e));
      const s = el && el.closest('.sec');
      if (s) return secIndex.get(s);
    }
    return r.bottom < y ? sections.length - 1 : 0;
  }
  function spy() {
    const si = currentSection();
    if (si < 0) return;
    const y = barH() + 24;
    for (let s = si; s >= 0; s--) {
      const hs = secHeads[s];
      for (let k = hs.length - 1; k >= 0; k--) {
        if (s < si || heads[hs[k]].getBoundingClientRect().top <= y) return setActive(hs[k]);
      }
    }
    setActive(-1);
  }
  function scrollToEl(el, offset = 14) {
    const go = () => { const r = el.getBoundingClientRect(); scrollTo(0, scrollY + r.top - barH() - offset); };
    go(); requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
  }
  toc.addEventListener('click', e => {
    const a = e.target.closest('a'); if (!a) return;
    e.preventDefault();
    const i = +a.dataset.i;
    if (heads[i]) { scrollToEl(heads[i]); setTimeout(() => setActive(i), 60); }
  });

  const fold = (() => {
    const M = Object.assign(Object.create(null), { ' ': ' ', ' ': ' ', '‘': "'", '’': "'", '“': '"', '”': '"' });
    const RE = /[  ‘’“”À-ɏḀ-ỿ]/g;
    const f = c => M[c] || (M[c] = c.normalize('NFD')[0]);
    return s => { let l = s.toLowerCase(); if (l.length !== s.length) l = s; return l.replace(RE, f); };
  })();

  let tocFT;
  $('#tocFilter').addEventListener('input', () => {
    clearTimeout(tocFT);
    tocFT = setTimeout(() => {
      const q = fold($('#tocFilter').value.trim());
      toc.classList.toggle('filtering', !!q);
      if (q) for (const a of links) a.classList.toggle('hit', fold(a.textContent).includes(q));
      else markActive(active, true);
    }, 60);
  });

  // Sidebar width
  const rz = $('#resizer');
  rz.addEventListener('pointerdown', e => {
    e.preventDefault();
    rz.setPointerCapture(e.pointerId);
    keepAnchor();
    const move = ev => {
      prefs.sideW = Math.round(Math.max(180, Math.min(innerWidth * 0.6, ev.clientX)));
      html.style.setProperty('--side-w', prefs.sideW + 'px');
    };
    const up = () => { rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); savePrefs(); };
    rz.addEventListener('pointermove', move);
    rz.addEventListener('pointerup', up);
  });

  /* ---------------- Links inside the document ---------------- */
  content.addEventListener('click', e => {
    const a = e.target.closest('a[href]'); if (!a || !B.hasDoc) return;
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      e.preventDefault();
      const id = decodeURIComponent(href.slice(1));
      const t = document.getElementById(id) || document.getElementsByName(id)[0];
      if (t) scrollToEl(t);
      return;
    }
    if (SA) { a.target = '_blank'; return; }
    e.preventDefault();
    send({ cmd: 'link', href: a.href });
  });

  /* ---------------- Math (rendered lazily, near the viewport) ---------------- */
  const mathEls = $$('.math', content);
  const macros = {};
  function renderMath(el) {
    if (el.dataset.r || !window.katex) return;
    el.dataset.r = '1';
    try {
      katex.render(el.textContent, el, {
        displayMode: el.classList.contains('math-display'), throwOnError: false, strict: 'ignore',
        output: 'html', macros, globalGroup: true,
      });
    } catch (err) { el.classList.add('math-err'); el.title = String(err && err.message || err); }
  }
  const mio = new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) { mio.unobserve(e.target); renderMath(e.target); }
  }, { rootMargin: '1500px 0px' });
  mathEls.forEach(el => mio.observe(el));
  async function prepareForPrint() {
    mathEls.forEach(renderMath);
    try { await Promise.all([...document.fonts].filter(f => /KaTeX/.test(f.family)).map(f => f.load().catch(() => { }))); } catch (e) { }
    await document.fonts.ready;
  }

  /* ---------------- Find (Ctrl+F) ---------------- */
  // Text index of the document (math excluded), built when idle so Ctrl+F is instant.
  let IDX = null;
  function buildIndex() {
    if (IDX) return IDX;
    const nodes = [], starts = [], parts = [];
    let pos = 0, n;
    const w = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.nodeType === 1
        ? (n.classList.contains('math') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP)
        : NodeFilter.FILTER_ACCEPT,
    });
    while ((n = w.nextNode())) {
      const d = n.data; if (!d.length) continue;
      nodes.push(n); starts.push(pos); parts.push(fold(d)); pos += d.length;
    }
    return (IDX = { nodes, starts, text: parts.join('') });
  }
  function locate(off) {
    const s = IDX.starts; let lo = 0, hi = s.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function mkRange(off, len) {
    const a = locate(off), b = locate(off + len - 1);
    const r = new Range();
    r.setStart(IDX.nodes[a], off - IDX.starts[a]);
    r.setEnd(IDX.nodes[b], off + len - IDX.starts[b]);
    return r;
  }
  const MAX = 30000;
  let findOpen = false, matches = [], cur = -1, lastQ = null, findT;
  const hasHL = typeof Highlight !== 'undefined' && CSS.highlights;
  function runFind(q) {
    lastQ = q; matches = []; cur = -1;
    if (hasHL) { CSS.highlights.delete('find'); CSS.highlights.delete('findcur'); }
    if (!q) return updCount();
    buildIndex();
    const fq = fold(q), text = IDX.text;
    const hl = hasHL ? new Highlight() : null;
    for (let i = text.indexOf(fq); i !== -1 && matches.length < MAX; i = text.indexOf(fq, i + fq.length)) {
      const r = mkRange(i, fq.length); matches.push(r); if (hl) hl.add(r);
    }
    if (hl) CSS.highlights.set('find', hl);
    if (matches.length) showMatch(firstFromViewport());
    else updCount();
  }
  function firstFromViewport() {
    const el = topElement(); if (!el) return 0;
    let lo = 0, hi = matches.length; // first match not before el
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      let c; try { c = matches[mid].comparePoint(el, 0); } catch (e) { c = 1; }
      if (c <= 0) hi = mid; else lo = mid + 1;
    }
    return lo % matches.length;
  }
  function showMatch(i) {
    if (!matches.length) return updCount();
    cur = (i + matches.length) % matches.length;
    const r = matches[cur];
    if (hasHL) { const h = new Highlight(r); h.priority = 1; CSS.highlights.set('findcur', h); }
    const top = barH() + 60, bottom = innerHeight - 60;
    const inView = () => { const b = r.getBoundingClientRect(); return (b.width || b.height) && b.top >= top && b.bottom <= bottom; };
    if (!inView()) {
      const el = r.startContainer.parentElement;
      el.scrollIntoView({ block: 'center' });
      const center = () => { const b = r.getBoundingClientRect(); if (b.width || b.height) scrollBy(0, b.top - innerHeight / 2); };
      center(); requestAnimationFrame(center);
    }
    updCount();
  }
  function updCount() {
    const q = $('#fq').value;
    $('#fcount').textContent = !q ? '' : matches.length ? `${cur + 1} / ${matches.length}${matches.length >= MAX ? '+' : ''}` : 'Aucun résultat';
    $('#fq').classList.toggle('none', !!q && !matches.length);
  }
  function findStep(d) {
    const q = $('#fq').value;
    if (q !== lastQ) { clearTimeout(findT); runFind(q); return; }
    if (matches.length) showMatch(cur + d);
  }
  function openFind() {
    if (!B.hasDoc) return;
    const sel = String(getSelection()).trim();
    const f = $('#find'), q = $('#fq');
    f.hidden = false; findOpen = true;
    if (sel && sel.length < 200 && !sel.includes('\n')) { q.value = sel; }
    q.focus(); q.select();
    if (q.value && q.value !== lastQ) runFind(q.value);
  }
  function closeFind() {
    $('#find').hidden = true; findOpen = false;
    if (hasHL) { CSS.highlights.delete('find'); CSS.highlights.delete('findcur'); }
    if (matches[cur]) { const s = getSelection(); s.removeAllRanges(); s.addRange(matches[cur]); }
    lastQ = null; matches = []; cur = -1;
    $('#fq').blur();
  }
  $('#fq').addEventListener('input', () => {
    clearTimeout(findT);
    const q = $('#fq').value;
    findT = setTimeout(() => runFind(q), q.length < 3 ? 180 : 90);
  });
  $('#fq').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
  });
  $('#fPrev').addEventListener('click', () => findStep(-1));
  $('#fNext').addEventListener('click', () => findStep(1));
  $('#fClose').addEventListener('click', closeFind);

  /* ---------------- Export ---------------- */
  function doPdf() {
    if (!B.hasDoc) return;
    if (SA) return doPrint();
    toast('Préparation du PDF…', 60000);
    setTimeout(async () => { await prepareForPrint(); send({ cmd: 'pdf' }); }, 20);
  }
  function doPrint() {
    if (!B.hasDoc) return;
    toast('Préparation de l’impression…');
    setTimeout(async () => { await prepareForPrint(); hideToast(); window.print(); }, 20);
  }
  function doHtml() { if (B.hasDoc && !SA) send({ cmd: 'exportHtml' }); }

  /* ---------------- Keyboard ---------------- */
  addEventListener('keydown', e => {
    const k = e.key, c = e.ctrlKey || e.metaKey, lk = k.length === 1 ? k.toLowerCase() : k;
    if (c && !e.altKey) {
      const hit = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
      if (lk === 'f') return hit(openFind);
      if (e.shiftKey && ['Equal', 'NumpadAdd', 'BracketRight'].includes(e.code)) return hit(() => fontStep(0.5));
      if (e.shiftKey && ['Minus', 'Digit6', 'NumpadSubtract'].includes(e.code)) return hit(() => fontStep(-0.5));
      if (!SA && (k === '=' || k === '+' || e.code === 'NumpadAdd' || e.code === 'Equal')) return hit(() => zoomStep(1));
      if (!SA && (k === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus')) return hit(() => zoomStep(-1));
      if (!SA && (k === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) return hit(() => zoomTo(100));
      if (lk === 'o') return hit(() => send({ cmd: 'open' }));
      if (lk === 'b') return hit(() => setPref('side', !prefs.side));
      if (lk === 'd') return hit(toggleNight);
      if (lk === 'p') return hit(e.shiftKey ? doPrint : doPdf);
      if (lk === 's') return hit(doHtml);
      if (lk === 'r') return hit(() => send({ cmd: 'reload' }));
      if (lk === 'g') return hit(() => (findOpen ? findStep(e.shiftKey ? -1 : 1) : openFind()));
    }
    if (k === 'F11') { e.preventDefault(); return toggleFs(); }
    if (k === 'F5') { e.preventDefault(); return send({ cmd: 'reload' }); }
    if (k === 'F1') { e.preventDefault(); const p = $('#pHelp'); return openPop === p ? closePop() : showPop(p, $('#bHelp')); }
    if (k === 'F3') { e.preventDefault(); return findOpen ? findStep(e.shiftKey ? -1 : 1) : openFind(); }
    if (k === 'Escape') {
      if (openPop) return closePop();
      if (findOpen) return closeFind();
      if (fs) { if (SA) document.exitFullscreen(); else send({ cmd: 'exitFullscreen' }); }
    }
  }, true);

  /* ---------------- Scroll: progress, spy, position memory ---------------- */
  const prog = $('#progress i');
  let ticking = false, posT, lastTop = null;
  function curPos() {
    const si = currentSection(); const s = sections[si]; if (!s) return null;
    const r = s.getBoundingClientRect();
    return { s: si, r: r.height ? Math.max(0, (barH() - r.top) / r.height) : 0 };
  }
  function onScroll() {
    ticking = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    prog.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
    spy();
    if (!anchor) { const el = topElement(); if (el) lastTop = { el, top: el.getBoundingClientRect().top / innerHeight }; }
    if (!SA) { clearTimeout(posT); posT = setTimeout(() => { const p = curPos(); if (p) send({ cmd: 'pos', pos: p }); }, 400); }
  }
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  addEventListener('beforeunload', () => { if (!SA && B.hasDoc) { const p = curPos(); if (p) send({ cmd: 'pos', pos: p }); } });

  /* ---------------- Start ---------------- */
  applyPrefs();
  showZoom(false);
  const pos = B.pos;
  if (pos && sections[pos.s] && (pos.s > 0 || pos.r > 0.002)) {
    const s = sections[pos.s];
    const go = () => { const r = s.getBoundingClientRect(); scrollTo(0, scrollY + r.top - barH() + pos.r * r.height); };
    go(); requestAnimationFrame(() => { go(); requestAnimationFrame(() => { go(); onScroll(); }); });
  } else requestAnimationFrame(onScroll);
  if (B.hasDoc) (window.requestIdleCallback || setTimeout)(() => buildIndex(), { timeout: 3000 });
  app.autoPdf = () => prepareForPrint().then(() => send({ cmd: 'pdfReady' }));
  send({ cmd: 'ready' });
  window.focus();
})();
