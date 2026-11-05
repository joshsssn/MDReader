#![windows_subsystem = "windows"]
mod render;

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::{Fullscreen, Icon, Theme, Window, WindowBuilder};
use wry::http::{header::CONTENT_TYPE, Request, Response};
use wry::{DragDropEvent, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

const ORIGIN: &str = "http://mdr.localhost";
const ASSET_PREFIX: &str = "/__mdr/";
const APP_NAME: &str = "MDReader";

static SHELL: &str = include_str!("../assets/shell.html");
static APP_CSS: &str = include_str!("../assets/app.css");
static APP_JS: &str = include_str!("../assets/app.js");
static KATEX_CSS: &str = include_str!("../assets/katex/katex.min.css");
static KATEX_JS: &str = include_str!("../assets/katex/katex.min.js");
static FONTS: &[(&str, &[u8])] = include!("fonts.inc");

/// (theme id, is dark, background color) — must match app.css.
const THEMES: &[(&str, bool, (u8, u8, u8))] = &[
    ("papier", false, (0xf7, 0xf2, 0xe8)),
    ("brume", false, (0xf2, 0xf4, 0xf8)),
    ("sauge", false, (0xf0, 0xf3, 0xec)),
    ("nuit", true, (0x26, 0x26, 0x24)),
    ("abysse", true, (0x10, 0x17, 0x24)),
    ("aubergine", true, (0x1f, 0x1b, 0x27)),
    ("foret", true, (0x18, 0x20, 0x1c)),
];

enum UserEvent {
    Ipc(String),
    Open(PathBuf),
    Changed,
    PdfDone(bool, String),
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Settings {
    zoom: f64,
    prefs: Value,
    recent: Vec<String>,
    positions: HashMap<String, Value>,
    window: Option<(f64, f64, bool)>,
}

struct Doc {
    path: PathBuf,
    rendered: render::Rendered,
}

/// What the custom protocol serves: the current page and the folder of the open file.
#[derive(Default)]
struct Served {
    page: Arc<String>,
    base: Option<PathBuf>,
}

type Watch = Arc<Mutex<Option<(PathBuf, Option<SystemTime>)>>>;

struct App {
    window: Window,
    webview: WebView,
    settings: Settings,
    settings_path: PathBuf,
    doc: Option<Doc>,
    served: Arc<Mutex<Served>>,
    watch: Watch,
    proxy: EventLoopProxy<UserEvent>,
    fullscreen: bool,
    nav: u64,
    /// CLI `--pdf in.md out.pdf`: export then quit.
    auto_pdf: Option<PathBuf>,
    quit: bool,
}

fn main() {
    let data_dir = data_dir();
    let settings_path = data_dir.join("settings.json");
    let settings: Settings = fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // CLI: MDReader --export input.md output.html
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if args.len() == 3 && args[0].as_os_str() == "--export" {
        let src = fs::read_to_string(&args[1]).unwrap_or_default();
        let doc = Doc { path: args[1].clone(), rendered: render::render(&src) };
        let _ = fs::write(&args[2], build_page(&settings, Some(&doc), true));
        return;
    }
    let auto_pdf = (args.len() == 3 && args[0].as_os_str() == "--pdf").then(|| args[2].clone());

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let (theme, dark, bg) = current_theme(&settings.prefs);
    let (w, h, maximized) = settings.window.unwrap_or((1280.0, 860.0, false));
    let window = WindowBuilder::new()
        .with_title(APP_NAME)
        .with_inner_size(LogicalSize::new(w.max(480.0), h.max(360.0)))
        .with_maximized(maximized)
        .with_visible(auto_pdf.is_none())
        .with_theme(Some(if dark { Theme::Dark } else { Theme::Light }))
        .with_window_icon(app_icon())
        .build(&event_loop)
        .expect("window");
    let _ = theme;

    let served = Arc::new(Mutex::new(Served::default()));
    let web_context = Box::leak(Box::new(WebContext::new(Some(data_dir.join("webview")))));

    let srv = served.clone();
    let p_ipc = proxy.clone();
    let p_drop = proxy.clone();
    let p_nav = proxy.clone();
    let webview = WebViewBuilder::new_with_web_context(web_context)
        .with_background_color((bg.0, bg.1, bg.2, 255))
        .with_hotkeys_zoom(false)
        .with_browser_accelerator_keys(false)
        .with_devtools(cfg!(debug_assertions))
        .with_custom_protocol("mdr".into(), move |_id, req| serve(&srv, &req))
        .with_ipc_handler(move |req: Request<String>| {
            let _ = p_ipc.send_event(UserEvent::Ipc(req.into_body()));
        })
        .with_drag_drop_handler(move |e| {
            if let DragDropEvent::Drop { paths, .. } = e {
                if let Some(p) = paths.into_iter().next() {
                    let _ = p_drop.send_event(UserEvent::Open(p));
                }
            }
            true
        })
        .with_navigation_handler(move |url: String| {
            let main_page = url
                .strip_prefix(ORIGIN)
                .map(|r| r == "/" || r.starts_with("/?") || r.starts_with("/#"))
                .unwrap_or(false);
            if main_page || url.starts_with("about:") {
                return true;
            }
            let _ = p_nav.send_event(UserEvent::Ipc(json!({"cmd": "link", "href": url}).to_string()));
            false
        })
        .build(&window)
        .expect("webview");

    enable_pinch_zoom(&webview);

    let watch: Watch = Arc::new(Mutex::new(None));
    spawn_watcher(watch.clone(), proxy.clone());

    let mut app = App {
        window,
        webview,
        settings,
        settings_path,
        doc: None,
        served,
        watch,
        proxy,
        fullscreen: false,
        nav: 0,
        auto_pdf,
        quit: false,
    };
    if app.settings.zoom < 25.0 {
        app.settings.zoom = 100.0;
    }
    let _ = app.webview.zoom(app.settings.zoom / 100.0);

    let file_arg = if app.auto_pdf.is_some() { args.get(1).cloned() } else { args.first().cloned() };
    match file_arg.filter(|p| p.is_file()) {
        Some(p) => app.open(p),
        None => app.show(),
    }

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                app.remember_window();
                app.save();
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::Ipc(msg)) => app.ipc(&msg),
            Event::UserEvent(UserEvent::PdfDone(..)) if app.auto_pdf.is_some() => app.quit = true,
            Event::UserEvent(UserEvent::Open(p)) => app.open(p),
            Event::UserEvent(UserEvent::Changed) => {
                if app.reload() {
                    app.js("app.toast('Fichier modifié — rechargé')");
                }
            }
            Event::UserEvent(UserEvent::PdfDone(ok, path)) => {
                app.sync_background();
                if ok {
                    app.js(&format!("app.saved('PDF enregistré', {})", json!(path)));
                } else {
                    app.js("app.toast('Échec de l’export PDF')");
                }
            }
            _ => {}
        }
        if app.quit {
            *control_flow = ControlFlow::Exit;
        }
    });
}

impl App {
    fn js(&self, code: &str) {
        let _ = self.webview.evaluate_script(&format!("window.app && ({code})"));
    }

    fn open(&mut self, path: PathBuf) {
        let path = fs::canonicalize(&path).map(strip_unc).unwrap_or(path);
        let src = match fs::read(&path) {
            Ok(b) => String::from_utf8(b).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()),
            Err(e) => {
                self.js(&format!("app.toast({})", json!(format!("Impossible d’ouvrir : {e}"))));
                return;
            }
        };
        let rendered = render::render(&src);
        let key = path.display().to_string();
        self.settings.recent.retain(|r| r != &key);
        self.settings.recent.insert(0, key);
        self.settings.recent.truncate(15);
        *self.watch.lock().unwrap() = Some((path.clone(), mtime(&path)));
        self.doc = Some(Doc { path, rendered });
        self.save();
        self.show();
    }

    /// Re-read the current file. Returns false if there is none.
    fn reload(&mut self) -> bool {
        match self.doc.as_ref().map(|d| d.path.clone()) {
            Some(p) => {
                self.open(p);
                true
            }
            None => false,
        }
    }

    fn show(&mut self) {
        let page = self.page(false);
        {
            let mut s = self.served.lock().unwrap();
            s.page = Arc::new(page);
            s.base = self.doc.as_ref().and_then(|d| d.path.parent().map(Path::to_path_buf));
        }
        let title = match &self.doc {
            Some(d) => format!("{} — {APP_NAME}", file_name(&d.path)),
            None => APP_NAME.to_string(),
        };
        self.window.set_title(&title);
        self.nav += 1;
        let _ = self.webview.load_url(&format!("{ORIGIN}/?v={}", self.nav));
    }

    fn page(&self, standalone: bool) -> String {
        build_page(&self.settings, self.doc.as_ref(), standalone)
    }
    fn ipc(&mut self, msg: &str) {
        let v: Value = serde_json::from_str(msg).unwrap_or_default();
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match v.get("cmd").and_then(Value::as_str).unwrap_or("") {
            "open" => {
                let dlg = rfd::FileDialog::new()
                    .set_title("Ouvrir un fichier Markdown")
                    .add_filter("Markdown", &["md", "markdown", "mdown", "mkd", "mdx", "txt"])
                    .add_filter("Tous les fichiers", &["*"])
                    .set_parent(&self.window);
                let dlg = match self.doc.as_ref().and_then(|d| d.path.parent()) {
                    Some(dir) => dlg.set_directory(dir),
                    None => dlg,
                };
                if let Some(p) = dlg.pick_file() {
                    self.open(p);
                }
            }
            "openPath" => {
                let p = PathBuf::from(s("path"));
                if p.is_file() {
                    self.open(p);
                } else {
                    self.settings.recent.retain(|r| r != &s("path"));
                    self.js("app.toast('Fichier introuvable')");
                }
            }
            "forget" => {
                self.settings.recent.retain(|r| r != &s("path"));
                self.save();
            }
            "reload" => {
                self.reload();
            }
            "zoom" => {
                let z = v.get("value").and_then(Value::as_f64).unwrap_or(100.0).clamp(25.0, 500.0);
                self.settings.zoom = z;
                let _ = self.webview.zoom(z / 100.0);
            }
            "fullscreen" => {
                self.fullscreen = !self.fullscreen;
                self.window.set_fullscreen(self.fullscreen.then_some(Fullscreen::Borderless(None)));
                self.js(&format!("app.onFullscreen({})", self.fullscreen));
            }
            "exitFullscreen" => {
                if self.fullscreen {
                    self.fullscreen = false;
                    self.window.set_fullscreen(None);
                    self.js("app.onFullscreen(false)");
                }
            }
            "prefs" => {
                self.settings.prefs = v.get("prefs").cloned().unwrap_or(Value::Null);
                let (_, dark, _) = current_theme(&self.settings.prefs);
                self.window.set_theme(Some(if dark { Theme::Dark } else { Theme::Light }));
                self.sync_background();
                self.save();
            }
            "pos" => {
                if let Some(d) = &self.doc {
                    let key = d.path.display().to_string();
                    if self.settings.positions.len() > 300 && !self.settings.positions.contains_key(&key) {
                        let k = self.settings.positions.keys().next().cloned();
                        if let Some(k) = k {
                            self.settings.positions.remove(&k);
                        }
                    }
                    self.settings.positions.insert(key, v.get("pos").cloned().unwrap_or(Value::Null));
                    self.save();
                }
            }
            "link" => self.link(&s("href")),
            "ready" => {
                if self.auto_pdf.is_some() {
                    if self.doc.is_some() { self.js("app.autoPdf()") } else { self.quit = true }
                }
            }
            "pdfReady" => {
                if let Some(p) = self.auto_pdf.clone() {
                    if self.print_to_pdf(&p).is_err() {
                        self.quit = true;
                    }
                }
            }
            "exportHtml" => self.export_html(),
            "pdf" => self.export_pdf(),
            "reveal" => {
                let _ = std::process::Command::new("explorer").arg(s("path")).spawn();
            }
            _ => {}
        }
    }

    fn link(&mut self, href: &str) {
        if let Some(rest) = href.strip_prefix(ORIGIN) {
            let path = percent_decode(rest.split(['?', '#']).next().unwrap_or(""));
            let Some(base) = self.served.lock().unwrap().base.clone() else { return };
            let p = base.join(path.trim_start_matches('/'));
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if matches!(ext.as_str(), "md" | "markdown" | "mdown" | "mkd" | "mdx") && p.is_file() {
                self.open(p);
            } else if p.exists() {
                let _ = std::process::Command::new("explorer").arg(&p).spawn();
            }
        } else if href.starts_with("http://") || href.starts_with("https://") || href.starts_with("mailto:") {
            shell_open(href);
        }
    }

    fn default_name(&self, ext: &str) -> String {
        let stem = self
            .doc
            .as_ref()
            .and_then(|d| d.path.file_stem())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "document".into());
        format!("{stem}.{ext}")
    }

    fn save_dialog(&self, title: &str, label: &str, ext: &str) -> Option<PathBuf> {
        let mut dlg = rfd::FileDialog::new()
            .set_title(title)
            .add_filter(label, &[ext])
            .set_file_name(self.default_name(ext))
            .set_parent(&self.window);
        if let Some(dir) = self.doc.as_ref().and_then(|d| d.path.parent()) {
            dlg = dlg.set_directory(dir);
        }
        dlg.save_file()
    }

    fn export_html(&mut self) {
        if self.doc.is_none() {
            return;
        }
        let Some(path) = self.save_dialog("Exporter en HTML", "Page HTML", "html") else { return };
        match fs::write(&path, self.page(true)) {
            Ok(()) => self.js(&format!("app.saved('HTML enregistré', {})", json!(path.display().to_string()))),
            Err(e) => self.js(&format!("app.toast({})", json!(format!("Échec : {e}")))),
        }
    }

    fn export_pdf(&mut self) {
        if self.doc.is_none() {
            return;
        }
        let Some(path) = self.save_dialog("Exporter en PDF", "Document PDF", "pdf") else {
            self.js("app.pdfCancelled()");
            return;
        };
        self.js("app.toast('Création du PDF…', 60000)");
        if let Err(e) = self.print_to_pdf(&path) {
            self.js(&format!("app.toast({})", json!(format!("Échec de l’export PDF : {e}"))));
        }
    }

    fn print_to_pdf(&self, path: &Path) -> windows::core::Result<()> {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7};
        use windows::core::{Interface, HSTRING};

        let wv: ICoreWebView2_7 = self.webview.webview().cast()?;
        let env: ICoreWebView2Environment6 = self.webview.environment().cast()?;
        let settings = unsafe { env.CreatePrintSettings()? };
        unsafe {
            settings.SetShouldPrintHeaderAndFooter(false.into())?;
            settings.SetShouldPrintBackgrounds(true.into())?;
            settings.SetMarginTop(0.6)?;
            settings.SetMarginBottom(0.6)?;
            settings.SetMarginLeft(0.6)?;
            settings.SetMarginRight(0.6)?;
        }
        // Page margins are painted with the webview background: make it white while printing.
        let _ = self.webview.set_background_color((255, 255, 255, 255));
        let proxy = self.proxy.clone();
        let shown = path.display().to_string();
        let handler = webview2_com::PrintToPdfCompletedHandler::create(Box::new(move |res, ok| {
            let _ = proxy.send_event(UserEvent::PdfDone(res.is_ok() && ok, shown));
            Ok(())
        }));
        unsafe { wv.PrintToPdf(&HSTRING::from(path.as_os_str()), &settings, &handler) }
    }

    fn sync_background(&self) {
        let (_, _, bg) = current_theme(&self.settings.prefs);
        let _ = self.webview.set_background_color((bg.0, bg.1, bg.2, 255));
    }

    fn remember_window(&mut self) {
        if self.fullscreen {
            return;
        }
        let maximized = self.window.is_maximized();
        let prev = self.settings.window.unwrap_or((1280.0, 860.0, false));
        let size = if maximized {
            (prev.0, prev.1)
        } else {
            let s = self.window.inner_size().to_logical::<f64>(self.window.scale_factor());
            (s.width, s.height)
        };
        self.settings.window = Some((size.0, size.1, maximized));
    }

    fn save(&self) {
        if let Ok(s) = serde_json::to_string(&self.settings) {
            let _ = fs::write(&self.settings_path, s);
        }
    }
}

fn build_page(settings: &Settings, doc: Option<&Doc>, standalone: bool) -> String {
        let prefs = &settings.prefs;
        let (theme, _, _) = current_theme(prefs);
        let pref = |k: &str, d: &str| -> String {
            let v = prefs.get(k).and_then(Value::as_str).unwrap_or(d);
            v.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
        };

        let (title, toc, body, pos, file) = match doc {
            Some(d) => {
                let key = d.path.display().to_string();
                let title = d.rendered.title.clone().unwrap_or_else(|| file_name(&d.path));
                (
                    title,
                    render::toc_html(&d.rendered.toc),
                    d.rendered.body.as_str(),
                    settings.positions.get(&key).cloned().unwrap_or(Value::Null),
                    file_name(&d.path),
                )
            }
            None => (APP_NAME.to_string(), String::new(), "", Value::Null, String::new()),
        };
        let recent: Vec<Value> = settings
            .recent
            .iter()
            .map(|r| json!({"path": r, "name": file_name(Path::new(r)), "dir": Path::new(r).parent().map(|p| p.display().to_string()).unwrap_or_default()}))
            .collect();
        let boot = json!({
            "standalone": standalone,
            "prefs": prefs,
            "zoom": settings.zoom,
            "pos": pos,
            "recent": if standalone { json!([]) } else { json!(recent) },
            "file": file,
            "hasDoc": doc.is_some(),
            "headings": doc.map(|d| d.rendered.toc.len()).unwrap_or(0),
        })
        .to_string()
        .replace("</", "<\\/");

        let (head, scripts) = if standalone {
            (
                format!("<style>{}</style>\n<style>{}</style>", inline_katex_css(), APP_CSS),
                format!("<script>{}</script>\n<script>{}</script>", KATEX_JS, APP_JS.replace("</script", "<\\/script")),
            )
        } else {
            (
                format!("<link rel=\"stylesheet\" href=\"{ASSET_PREFIX}katex/katex.min.css\">\n<link rel=\"stylesheet\" href=\"{ASSET_PREFIX}app.css\">"),
                format!("<script src=\"{ASSET_PREFIX}katex/katex.min.js\"></script>\n<script src=\"{ASSET_PREFIX}app.js\"></script>"),
            )
        };

        let mut html = String::with_capacity(body.len() + toc.len() + 64 * 1024);
        // Fill the shell template. Body goes in last so its content is never scanned for placeholders.
        let shell = SHELL
            .replace("{{THEME}}", &theme)
            .replace("{{FONT}}", &pref("font", "serif"))
            .replace(
                "{{FS}}",
                &prefs.get("fs").and_then(Value::as_f64).unwrap_or(13.5).clamp(9.0, 28.0).to_string(),
            )
            .replace("{{WIDTH}}", &pref("width", "normal"))
            .replace("{{TITLE}}", &render::esc(&title))
            .replace("{{DOCTITLE}}", &render::esc(file.strip_suffix(".md").unwrap_or(&file)))
            .replace("{{HEAD}}", &head)
            .replace("{{BODYCLASS}}", if doc.is_some() { "" } else { "nodoc" })
            .replace("{{BOOT}}", &boot)
            .replace("{{SCRIPTS}}", &scripts);
        let (a, rest) = shell.split_once("{{TOC}}").unwrap_or((&shell, ""));
        let (b, c) = rest.split_once("{{CONTENT}}").unwrap_or((rest, ""));
        html.push_str(a);
        html.push_str(&toc);
        html.push_str(b);
        html.push_str(body);
        html.push_str(c);
        html
    }

/// Touchpad / touchscreen pinch = visual zoom on the area under the fingers (like Chrome).
/// wry turns it off together with the zoom hotkeys, so turn it back on.
fn enable_pinch_zoom(webview: &WebView) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings5;
    use windows::core::Interface;
    unsafe {
        if let Ok(settings) = webview.webview().Settings() {
            if let Ok(s5) = settings.cast::<ICoreWebView2Settings5>() {
                let _ = s5.SetIsPinchZoomEnabled(true.into());
            }
        }
    }
}

fn serve(served: &Mutex<Served>, req: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = req.uri().path();
    let ok = |mime: &str, body: Cow<'static, [u8]>| {
        Response::builder().header(CONTENT_TYPE, mime).body(body).unwrap()
    };
    if path == "/" || path == "/index.html" {
        let page = served.lock().unwrap().page.clone();
        return ok("text/html; charset=utf-8", Cow::Owned(page.as_bytes().to_vec()));
    }
    if let Some(asset) = path.strip_prefix(ASSET_PREFIX) {
        let found: Option<(&'static [u8], &str)> = match asset {
            "app.css" => Some((APP_CSS.as_bytes(), "text/css")),
            "app.js" => Some((APP_JS.as_bytes(), "text/javascript")),
            "katex/katex.min.css" => Some((KATEX_CSS.as_bytes(), "text/css")),
            "katex/katex.min.js" => Some((KATEX_JS.as_bytes(), "text/javascript")),
            a => a
                .strip_prefix("katex/fonts/")
                .and_then(|f| f.strip_suffix(".woff2"))
                .and_then(|n| FONTS.iter().find(|(name, _)| *name == n))
                .map(|(_, b)| (*b, "font/woff2")),
        };
        if let Some((b, mime)) = found {
            return ok(mime, Cow::Borrowed(b));
        }
    } else if let Some(base) = served.lock().unwrap().base.clone() {
        // Files next to the document (images…).
        let p = base.join(percent_decode(path).trim_start_matches('/'));
        if let Ok(bytes) = fs::read(&p) {
            return ok(mime_for(&p), Cow::Owned(bytes));
        }
    }
    Response::builder().status(404).body(Cow::Borrowed(&b""[..])).unwrap()
}

fn mime_for(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "css" => "text/css",
        "js" => "text/javascript",
        "html" | "htm" => "text/html",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn inline_katex_css() -> String {
    let mut css = KATEX_CSS.to_string();
    for (name, bytes) in FONTS {
        css = css.replace(
            &format!("url(fonts/{name}.woff2)"),
            &format!("url(data:font/woff2;base64,{})", base64(bytes)),
        );
    }
    css
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut o = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        o.push(T[(n >> 18) as usize & 63] as char);
        o.push(T[(n >> 12) as usize & 63] as char);
        o.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        o.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    o
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn current_theme(prefs: &Value) -> (String, bool, (u8, u8, u8)) {
    let night = prefs.get("night").and_then(Value::as_bool).unwrap_or(false);
    let key = if night { "nightTheme" } else { "dayTheme" };
    let wanted = prefs.get(key).and_then(Value::as_str).unwrap_or(if night { "nuit" } else { "papier" });
    let t = THEMES
        .iter()
        .find(|t| t.0 == wanted)
        .unwrap_or(if night { &THEMES[3] } else { &THEMES[0] });
    (t.0.to_string(), t.1, t.2)
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn strip_unc(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn shell_open(target: &str) {
    let _ = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", target]).spawn();
}

/// Portable: keep settings and the WebView2 cache in a folder next to the exe.
fn data_dir() -> PathBuf {
    let beside = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join("MDR-data")));
    if let Some(d) = beside {
        // Keep settings from the pre-1.0 folder name.
        if let Some(old) = d.parent().map(|p| p.join("mdreader-data")) {
            if old.is_dir() && !d.exists() {
                let _ = fs::rename(&old, &d);
            }
        }
        if fs::create_dir_all(&d).is_ok() && fs::write(d.join(".probe"), b"").is_ok() {
            let _ = fs::remove_file(d.join(".probe"));
            return d;
        }
    }
    let d = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("MDReader");
    let _ = fs::create_dir_all(&d);
    d
}

/// Reload when the open file changes on disk.
fn spawn_watcher(watch: Watch, proxy: EventLoopProxy<UserEvent>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(800));
        let changed = {
            let mut w = watch.lock().unwrap();
            match w.as_mut() {
                Some((p, last)) => {
                    let now = mtime(p);
                    if now.is_some() && now != *last {
                        *last = now;
                        true
                    } else {
                        false
                    }
                }
                None => false,
            }
        };
        if changed {
            // Let the writer finish.
            std::thread::sleep(Duration::from_millis(300));
            if proxy.send_event(UserEvent::Changed).is_err() {
                return;
            }
        }
    });
}

/// The icon embedded in the exe by build.rs (resource id 1).
fn app_icon() -> Option<Icon> {
    use tao::platform::windows::IconExtWindows;
    Icon::from_resource(1, None).ok()
}
