// Assemble la PWA dans web/dist : ressources de ../assets + WASM + shell adapté + service worker.
// Prérequis : cargo build --release --target wasm32-unknown-unknown --manifest-path vscode/wasm/Cargo.toml
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..'), assets = path.join(root, 'assets'), out = path.join(__dirname, 'dist');
const wasm = path.join(root, 'vscode/wasm/target/wasm32-unknown-unknown/release/mdr_wasm.wasm');
if (!fs.existsSync(wasm)) throw new Error("WASM introuvable : compile d'abord vscode/wasm");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'katex/fonts'), { recursive: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
const cp = (from, to) => fs.copyFileSync(from, path.join(out, to));
for (const f of ['app.css', 'app.js', 'katex/katex.min.css', 'katex/katex.min.js']) cp(path.join(assets, f), f);
for (const f of fs.readdirSync(path.join(assets, 'katex/fonts'))) cp(path.join(assets, 'katex/fonts', f), 'katex/fonts/' + f);
for (const f of fs.readdirSync(path.join(__dirname, 'icons'))) cp(path.join(__dirname, 'icons', f), 'icons/' + f);
for (const f of ['boot.js', 'pwa.css', 'manifest.webmanifest']) cp(path.join(__dirname, f), f);
cp(wasm, 'mdr.wasm');

// CSP stricte : un .md peut contenir du HTML brut ; aucun script inline ni distant n'est autorisé.
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' https: data: blob:; media-src https: blob:; font-src 'self'; connect-src 'self'; " +
  "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="theme-color" content="#f7f2e8">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="MDReader">
<link rel="stylesheet" href="katex/katex.min.css">
<link rel="stylesheet" href="app.css">
<link rel="stylesheet" href="pwa.css">`;
const html = fs.readFileSync(path.join(assets, 'shell.html'), 'utf8')
  .replace('<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">')
  .replace('{{THEME}}', 'papier').replace('{{FONT}}', 'serif').replace('{{FS}}', '13.5').replace('{{WIDTH}}', 'normal')
  .replace('{{TITLE}}', 'MDReader').replace('{{DOCTITLE}}', '')
  .replace('{{HEAD}}', () => head).replace('{{BODYCLASS}}', 'nodoc')
  .replace('{{TOC}}', '').replace('{{CONTENT}}', '')
  .replace('<script>window.__BOOT = {{BOOT}};</script>', '').replace('{{SCRIPTS}}', '<script src="boot.js"></script>');
if (/\{\{\w+\}\}/.test(html)) throw new Error('placeholder non remplacé : ' + html.match(/\{\{\w+\}\}/)[0]);
fs.writeFileSync(path.join(out, 'index.html'), html);

// Service worker : précache de tous les fichiers, version = empreinte du contenu.
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(path.relative(out, p).split(path.sep).join('/'));
  }
})(out);
const h = crypto.createHash('sha1');
for (const f of files.sort()) h.update(f).update(fs.readFileSync(path.join(out, f)));
const version = h.digest('hex').slice(0, 10);
fs.writeFileSync(path.join(out, 'sw.js'), `const CACHE = 'mdr-${version}';
const FILES = ${JSON.stringify(['./', ...files])};
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});
`);
console.log(`web/dist prêt : ${files.length} fichiers, version ${version}`);
