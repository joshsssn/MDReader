// Copie les ressources partagées avec l'application Windows (../assets) et le WASM dans media/.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), assets = path.join(root, '..', 'assets'), media = path.join(root, 'media');
fs.rmSync(media, { recursive: true, force: true });
fs.mkdirSync(path.join(media, 'katex', 'fonts'), { recursive: true });
for (const f of ['app.css', 'app.js', 'shell.html', 'katex/katex.min.css', 'katex/katex.min.js'])
  fs.copyFileSync(path.join(assets, f), path.join(media, f));
const fonts = path.join(assets, 'katex', 'fonts');
for (const f of fs.readdirSync(fonts)) fs.copyFileSync(path.join(fonts, f), path.join(media, 'katex', 'fonts', f));
fs.copyFileSync(path.join(root, 'wasm/target/wasm32-unknown-unknown/release/mdr_wasm.wasm'), path.join(media, 'mdr.wasm'));
fs.copyFileSync(path.join(assets, 'icon', 'MDR.png'), path.join(root, 'icon.png'));
fs.copyFileSync(path.join(root, '..', 'LICENSE'), path.join(root, 'LICENSE'));
console.log('media/ prêt');
