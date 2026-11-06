'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VIEW_TYPE = 'mdreader.viewer';
const MD_EXT = /\.(md|markdown|mdown|mkd|mdx)$/i;

/* ---------------- Moteur Rust/WASM ---------------- */
let wasm = null;
function engine(ctx) {
  if (wasm) return wasm;
  const bytes = fs.readFileSync(path.join(ctx.extensionPath, 'media', 'mdr.wasm'));
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  wasm = exports;
  return wasm;
}

/** Markdown -> { title, toc, body } (HTML), calculé par render.rs compilé en WASM. */
function render(ctx, text) {
  const w = engine(ctx);
  const src = Buffer.from(text, 'utf8');
  const inPtr = w.alloc(src.length);
  new Uint8Array(w.memory.buffer, inPtr, src.length).set(src);
  const lenPtr = w.alloc(4);
  const outPtr = w.render(inPtr, src.length, lenPtr);
  const outLen = new DataView(w.memory.buffer).getUint32(lenPtr, true);
  // La mémoire a pu grandir pendant render() : on relit w.memory.buffer après l'appel.
  const mem = Buffer.from(w.memory.buffer, outPtr, outLen);
  const tl = mem.readUInt32LE(0), cl = mem.readUInt32LE(4), bl = mem.readUInt32LE(8);
  const str = (a, n) => mem.toString('utf8', a, a + n);
  const res = { title: str(12, tl), toc: str(12 + tl, cl), body: str(12 + tl + cl, bl) };
  w.dealloc(outPtr, outLen);
  w.dealloc(inPtr, src.length);
  w.dealloc(lenPtr, 4);
  return res;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const alnum = (s) => String(s).replace(/[^A-Za-z0-9]/g, '');

/* ---------------- Page (équivalent de build_page côté Rust) ---------------- */
function buildPage(ctx, webview, uri, r, prefs, pos) {
  const media = (p) => webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', p)).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const shell = fs.readFileSync(path.join(ctx.extensionPath, 'media', 'shell.html'), 'utf8');
  const base = webview.asWebviewUri(vscode.Uri.joinPath(uri, '..')).toString().replace(/\/?$/, '/');

  const THEME_IDS = ['papier', 'brume', 'sauge', 'nuit', 'abysse', 'aubergine', 'foret'];
  const theme = prefs.night ? prefs.nightTheme || 'nuit' : prefs.dayTheme || 'papier';
  const file = path.basename(uri.fsPath);
  const fs_ = Math.min(28, Math.max(9, Number(prefs.fs) || 13.5));

  const boot = JSON.stringify({
    standalone: false, prefs, zoom: 100, pos: pos ?? null, recent: [], file,
    hasDoc: true, headings: (r.toc.match(/<a /g) || []).length,
  }).replace(/<\//g, '<\\/');

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `media-src ${webview.cspSource} https:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">
<base href="${base}">
<link rel="stylesheet" href="${media('katex/katex.min.css')}">
<link rel="stylesheet" href="${media('app.css')}">
<style>#bFull,#bZoom,#bOpen,#bExport,.pop#pZoom,.pop#pExport,.welcome{display:none!important}</style>`;

  // Pont IPC : app.js parle à `window.ipc.postMessage(json)` comme avec WebView2.
  const shim = `const vs = acquireVsCodeApi();
window.ipc = { postMessage: (s) => vs.postMessage(JSON.parse(s)) };
window.addEventListener('message', (e) => { const m = e.data || {};
  if (m.type === 'toast' && window.app) window.app.toast(m.text); });`;
  const scripts = `<script nonce="${nonce}">${shim}</script>
<script nonce="${nonce}">window.__BOOT = ${boot};</script>
<script nonce="${nonce}" src="${media('katex/katex.min.js')}"></script>
<script nonce="${nonce}" src="${media('app.js')}"></script>`;

  const filled = shell
    .replace('{{THEME}}', THEME_IDS.includes(theme) ? theme : 'papier')
    .replace('{{FONT}}', alnum(prefs.font || 'serif'))
    .replace('{{FS}}', String(fs_))
    .replace('{{WIDTH}}', alnum(prefs.width || 'normal'))
    .replace('{{TITLE}}', esc(r.title || file))
    .replace('{{DOCTITLE}}', esc(file.replace(/\.md$/i, '')))
    .replace('{{HEAD}}', () => head)
    .replace('{{BODYCLASS}}', '')
    .replace('<script>window.__BOOT = {{BOOT}};</script>', '')
    .replace('{{SCRIPTS}}', () => scripts);
  // Le corps est inséré en dernier : son contenu n'est jamais scanné pour des placeholders.
  const [a, rest] = filled.split('{{TOC}}');
  const [b, c] = rest.split('{{CONTENT}}');
  return a + r.toc + b + r.body + c;
}

/* ---------------- Éditeur personnalisé ---------------- */
class Provider {
  constructor(ctx) { this.ctx = ctx; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const { ctx } = this;
    const uri = document.uri;
    const dir = vscode.Uri.joinPath(uri, '..');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media'), dir,
        ...(vscode.workspace.workspaceFolders || []).map((f) => f.uri)],
    };

    const refresh = async () => {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const r = render(ctx, Buffer.from(bytes).toString('utf8'));
        const prefs = ctx.globalState.get('prefs', {});
        const pos = (ctx.globalState.get('positions', {}))[uri.toString()];
        panel.webview.html = buildPage(ctx, panel.webview, uri, r, prefs, pos);
      } catch (e) {
        panel.webview.html = `<body style="font:14px sans-serif;padding:2em">Impossible de lire le fichier : ${esc(String(e.message || e))}</body>`;
      }
    };

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, path.basename(uri.fsPath)));
    let timer;
    const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 150); };
    watcher.onDidChange(later);
    watcher.onDidCreate(later);

    panel.webview.onDidReceiveMessage(async (m) => {
      switch (m.cmd) {
        case 'prefs': await ctx.globalState.update('prefs', m.prefs); break;
        case 'pos': {
          const all = ctx.globalState.get('positions', {});
          const keys = Object.keys(all);
          if (keys.length > 300 && !(uri.toString() in all)) delete all[keys[0]];
          all[uri.toString()] = m.pos;
          await ctx.globalState.update('positions', all);
          break;
        }
        case 'reload': refresh(); break;
        case 'link': await openLink(m.href, dir, panel.webview); break;
        case 'open': {
          const [pick] = (await vscode.window.showOpenDialog({
            defaultUri: dir, filters: { Markdown: ['md', 'markdown', 'mdown', 'mkd', 'mdx'] },
          })) || [];
          if (pick) vscode.commands.executeCommand('vscode.openWith', pick, VIEW_TYPE);
          break;
        }
        default: break; // ready, zoom, fullscreen, forget… : gérés par VS Code ou sans objet ici
      }
    });

    panel.onDidDispose(() => { clearTimeout(timer); watcher.dispose(); });
    await refresh();
  }
}

async function openLink(href, dir, webview) {
  if (/^(https?:|mailto:)/i.test(href) && !href.includes('vscode-resource') && !href.includes('vscode-cdn.net')) {
    return vscode.env.openExternal(vscode.Uri.parse(href));
  }
  // Lien relatif : a.href est résolu par <base> en URI de webview ; on retrouve le chemin relatif.
  const base = webview.asWebviewUri(dir).toString().replace(/\/?$/, '/');
  if (!href.startsWith(base)) return;
  const rel = decodeURIComponent(href.slice(base.length).split(/[?#]/)[0]);
  const target = vscode.Uri.joinPath(dir, rel);
  try { await vscode.workspace.fs.stat(target); } catch { return; }
  if (MD_EXT.test(target.path)) vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
  else vscode.commands.executeCommand('vscode.open', target);
}

/* ---------------- Activation ---------------- */
function activate(ctx) {
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new Provider(ctx), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('mdreader.open', (uri) => {
      uri = uri || vscode.window.activeTextEditor?.document.uri;
      if (uri) vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    }),
  );
}
function deactivate() {}
module.exports = { activate, deactivate };
