// Démarrage de la PWA MDReader : stockage local, rendu WASM, pont "ipc" pour app.js.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
  };
  const SS = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* indisponible */ } },
  };
  const json = (k, d) => { try { return JSON.parse(LS.get(k)) ?? d; } catch { return d; } };
  const narrow = matchMedia('(max-width: 820px)').matches;
  const MD = /\.(md|markdown|mdown|mkd|mdx|txt)$/i;

  /* ---- Préférences (sommaire fermé par défaut sur téléphone) ---- */
  const prefs = json('mdr-prefs', {});
  if (narrow && !('side' in prefs)) prefs.side = false;
  const theme = prefs.night ? prefs.nightTheme : prefs.dayTheme;
  if (theme) document.documentElement.dataset.theme = theme;

  /* ---- Documents (IndexedDB) ---- */
  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open('mdr', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const store = async (mode, fn) => {
    const d = await idb();
    return new Promise((res, rej) => {
      const t = d.transaction('docs', mode);
      const rq = fn(t.objectStore('docs'));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = () => rej(t.error);
    });
  };
  const listDocs = async () => {
    try { return ((await store('readonly', (s) => s.getAll())) || []).sort((a, b) => b.ts - a.ts); }
    catch { return []; }
  };
  // `handle` : le fichier d'origine (API File System Access), quand le navigateur le fournit.
  async function saveDoc(name, text, handle) {
    const rec = { id: name, name, text, ts: Date.now() };
    if (handle) {
      // Certains navigateurs ne savent pas stocker le lien vers le fichier : on s'en passe.
      try { await store('readwrite', (s) => s.put(Object.assign({ handle }, rec))); } catch { await store('readwrite', (s) => s.put(rec)); }
    } else await store('readwrite', (s) => s.put(rec));
    const extra = (await listDocs()).slice(15);
    for (const d of extra) await store('readwrite', (s) => s.delete(d.id));
  }
  async function openFile(file, handle) {
    if (!file) return;
    try {
      await saveDoc(file.name, await file.text(), handle);
      LS.set('mdr-current', file.name);
      SS.set('mdr-edit', '');
      location.reload();
    } catch (e) {
      alert('Impossible d’ouvrir ce fichier (stockage du navigateur indisponible ?)');
    }
  }

  /* ---- Sélecteur de fichier, glisser-déposer, ouverture système ---- */
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.md,.markdown,.mdown,.mkd,.mdx,.txt,text/markdown,text/plain';
  input.hidden = true;
  input.addEventListener('change', () => openFile(input.files[0]));
  document.body.appendChild(input);
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); openFile(e.dataTransfer.files[0]); });
  if ('launchQueue' in window) {
    launchQueue.setConsumer(async (p) => { if (p.files && p.files[0]) openFile(await p.files[0].getFile(), p.files[0]); });
  }

  /* ---- Pont "ipc" : app.js parle comme avec l'application Windows ---- */
  const positions = json('mdr-pos', {});
  const currentId = LS.get('mdr-current');
  let doc = null, eng = null, dirty = false;
  const reply = (id, v) => setTimeout(() => window.app && window.app._reply(id, v), 0);
  const TYPES = [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }, { description: 'Texte', accept: { 'text/plain': ['.txt'] } }];
  // Avec l'API File System Access (Chrome, Edge sur ordinateur), on ouvre et on enregistre
  // directement dans le fichier ; ailleurs, « Enregistrer » télécharge le fichier modifié.
  async function pickFile() {
    if (!window.showOpenFilePicker) return input.click();
    try {
      const [h] = await showOpenFilePicker({ types: [{ description: 'Markdown et texte', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mdx'], 'text/plain': ['.txt'] } }] });
      openFile(await h.getFile(), h);
    } catch { /* annulé */ }
  }
  async function writeDoc(m) {
    if (!doc) return;
    let name = doc.name, handle = doc.handle, msg = '';
    try {
      if (window.showSaveFilePicker) {
        if (m.as || !handle) handle = await showSaveFilePicker({ suggestedName: name, types: /\.txt$/i.test(name) ? TYPES.slice().reverse() : TYPES });
        const w = await handle.createWritable();
        await w.write(m.text);
        await w.close();
        name = handle.name;
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([m.text], { type: 'text/plain;charset=utf-8' }));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        msg = 'Fichier téléchargé';
      }
    } catch (e) {
      window.app.saveFailed(e && e.name === 'AbortError' ? '' : 'Échec de l’enregistrement : ' + (e && e.message || e));
      return;
    }
    const moved = name !== doc.name;
    try { await saveDoc(name, m.text, handle); } catch { /* stockage indisponible : le fichier, lui, est écrit */ }
    dirty = false;
    if (moved) { LS.set('mdr-current', name); SS.set('mdr-edit', name); location.reload(); return; }
    doc.text = m.text; doc.handle = handle;
    window.app.onSaved({ name, path: name, msg });
  }
  async function newDoc() {
    const names = new Set((await listDocs()).map((d) => d.id));
    let name = 'Sans titre.md';
    for (let i = 2; names.has(name); i++) name = `Sans titre ${i}.md`;
    await saveDoc(name, '');
    LS.set('mdr-current', name); SS.set('mdr-edit', name);
    location.reload();
  }
  addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  const handlers = {
    open: pickFile,
    // Éditeur (assets/editor.js)
    source: (m) => reply(m.id, { text: doc ? doc.text : '' }),
    blocks: (m) => reply(m.id, eng.blocks(m.text)),
    render: (m) => reply(m.id, eng.render(m.text)),
    save: writeDoc,
    dirty: (m) => { dirty = !!m.value; },
    mode: (m) => SS.set('mdr-edit', m.value === 'edit' && doc ? doc.id : ''),
    new: newDoc,
    pickImage: (m) => reply(m.id, { error: 'Version web : pas d’images locales. Insère une image par son adresse https://… avec ![texte](adresse)' }),
    openPath: (m) => { LS.set('mdr-current', m.path); location.reload(); },
    forget: async (m) => { try { await store('readwrite', (s) => s.delete(m.path)); } catch { /* ignoré */ } },
    reload: () => location.reload(),
    prefs: (m) => LS.set('mdr-prefs', JSON.stringify(m.prefs)),
    pos: (m) => {
      if (!currentId) return;
      positions[currentId] = m.pos;
      const keys = Object.keys(positions);
      if (keys.length > 100) delete positions[keys[0]];
      LS.set('mdr-pos', JSON.stringify(positions));
    },
    link: (m) => {
      if (/^(https?:|mailto:)/i.test(m.href) && !m.href.startsWith(location.origin)) open(m.href, '_blank', 'noopener');
    },
    pdf: () => print(),
  };
  window.ipc = { postMessage: (s) => { const m = JSON.parse(s); if (handlers[m.cmd]) handlers[m.cmd](m); } };

  // Sur téléphone : toucher le texte ou un titre du sommaire referme le sommaire.
  const closeSide = () => { if (narrow && !document.body.classList.contains('noside')) $('#bSide').click(); };
  $('#main').addEventListener('click', closeSide);
  $('#toc').addEventListener('click', (e) => { if (e.target.closest('a')) closeSide(); });

  /* ---- Moteur WASM ---- */
  async function loadEngine() {
    const { instance } = await WebAssembly.instantiateStreaming(fetch('mdr.wasm'), {});
    const w = instance.exports, dec = new TextDecoder();
    // Appelle une fonction exportée (ptr, len, out_len) -> ptr et donne le tampon résultat à `read`.
    const call = (fn, text, read) => {
      const src = new TextEncoder().encode(text);
      const ip = w.alloc(src.length);
      new Uint8Array(w.memory.buffer, ip, src.length).set(src);
      const lp = w.alloc(4);
      const op = fn(ip, src.length, lp);
      // Relire memory.buffer après l'appel : la mémoire a pu grandir.
      const n = new DataView(w.memory.buffer).getUint32(lp, true);
      const r = read(new Uint8Array(w.memory.buffer, op, n), new DataView(w.memory.buffer, op, n));
      w.dealloc(op, n); w.dealloc(ip, src.length); w.dealloc(lp, 4);
      return r;
    };
    return {
      render: (text) => call(w.render, text, (out, dv) => {
        const tl = dv.getUint32(0, true), cl = dv.getUint32(4, true), bl = dv.getUint32(8, true);
        const part = (a, l) => dec.decode(out.subarray(a, a + l));
        return { title: part(12, tl), toc: part(12 + tl, cl), body: part(12 + tl + cl, bl) };
      }),
      // Blocs de premier niveau avec leur source exacte (pour l'éditeur).
      blocks: (text) => call(w.blocks, text, (out) => JSON.parse(dec.decode(out))),
    };
  }

  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = false; s.onload = res; s.onerror = rej;
    document.body.appendChild(s);
  });

  (async () => {
    const docs = await listDocs();
    doc = docs.find((d) => d.id === currentId) || null;
    eng = await loadEngine();
    const boot = {
      standalone: false, prefs, zoom: 100, pos: null, hasDoc: !!doc, file: '', headings: 0,
      recent: docs.map((d) => ({ path: d.id, name: d.name, dir: new Date(d.ts).toLocaleString() })),
    };
    if (doc) {
      const r = eng.render(doc.text);
      $('#toc').innerHTML = r.toc;
      $('#content').innerHTML = r.body;
      $('#docTitle').textContent = doc.name.replace(MD, '');
      document.title = (r.title || doc.name) + ' — MDReader';
      document.body.classList.remove('nodoc');
      Object.assign(boot, { pos: positions[doc.id] || null, file: doc.name, headings: (r.toc.match(/<a /g) || []).length, stats: { chars: doc.text.length, words: (doc.text.match(/\S+/g) || []).length } });
    }
    boot.edit = {
      kind: doc && /\.txt$/i.test(doc.name) ? 'txt' : 'md', start: !!doc && SS.get('mdr-edit') === doc.id,
      untitled: false, readonly: false, newInMenu: true, mathlive: 'mathlive/mathlive.min.js', fonts: 'katex/fonts',
    };
    window.__BOOT = boot;
    await loadScript('katex/katex.min.js');
    await loadScript('app.js');
    await loadScript('editor.js');
  })().catch((e) => { document.body.textContent = 'Erreur de chargement : ' + e; });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
