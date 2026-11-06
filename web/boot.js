// Démarrage de la PWA MDReader : stockage local, rendu WASM, pont "ipc" pour app.js.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
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
  async function saveDoc(name, text) {
    await store('readwrite', (s) => s.put({ id: name, name, text, ts: Date.now() }));
    const extra = (await listDocs()).slice(15);
    for (const d of extra) await store('readwrite', (s) => s.delete(d.id));
  }
  async function openFile(file) {
    if (!file) return;
    try {
      await saveDoc(file.name, await file.text());
      LS.set('mdr-current', file.name);
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
    launchQueue.setConsumer(async (p) => { if (p.files && p.files[0]) openFile(await p.files[0].getFile()); });
  }

  /* ---- Pont "ipc" : app.js parle comme avec l'application Windows ---- */
  const positions = json('mdr-pos', {});
  const currentId = LS.get('mdr-current');
  const handlers = {
    open: () => input.click(),
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
    return (text) => {
      const src = new TextEncoder().encode(text);
      const ip = w.alloc(src.length);
      new Uint8Array(w.memory.buffer, ip, src.length).set(src);
      const lp = w.alloc(4);
      const op = w.render(ip, src.length, lp);
      // Relire memory.buffer après render() : la mémoire a pu grandir.
      const n = new DataView(w.memory.buffer).getUint32(lp, true);
      const out = new Uint8Array(w.memory.buffer, op, n);
      const dv = new DataView(w.memory.buffer, op, n);
      const tl = dv.getUint32(0, true), cl = dv.getUint32(4, true), bl = dv.getUint32(8, true);
      const part = (a, l) => dec.decode(out.subarray(a, a + l));
      const r = { title: part(12, tl), toc: part(12 + tl, cl), body: part(12 + tl + cl, bl) };
      w.dealloc(op, n); w.dealloc(ip, src.length); w.dealloc(lp, 4);
      return r;
    };
  }

  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = false; s.onload = res; s.onerror = rej;
    document.body.appendChild(s);
  });

  (async () => {
    const docs = await listDocs();
    const doc = docs.find((d) => d.id === currentId);
    const boot = {
      standalone: false, prefs, zoom: 100, pos: null, hasDoc: !!doc, file: '', headings: 0,
      recent: docs.map((d) => ({ path: d.id, name: d.name, dir: new Date(d.ts).toLocaleString() })),
    };
    if (doc) {
      const r = (await loadEngine())(doc.text);
      $('#toc').innerHTML = r.toc;
      $('#content').innerHTML = r.body;
      $('#docTitle').textContent = doc.name.replace(MD, '');
      document.title = (r.title || doc.name) + ' — MDReader';
      document.body.classList.remove('nodoc');
      Object.assign(boot, { pos: positions[doc.id] || null, file: doc.name, headings: (r.toc.match(/<a /g) || []).length });
    }
    window.__BOOT = boot;
    await loadScript('katex/katex.min.js');
    await loadScript('app.js');
  })().catch((e) => { document.body.textContent = 'Erreur de chargement : ' + e; });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
