// Embeds the icon and version info into MDReader.exe.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/icon/MDR.ico")
            .set("ProductName", "MDReader")
            .set("FileDescription", "MDReader (MDR) - lecteur Markdown")
            .set("LegalCopyright", "MIT License");
        res.compile().expect("failed to embed Windows resources");
    }
    println!("cargo:rerun-if-changed=assets/icon/MDR.ico");
}
