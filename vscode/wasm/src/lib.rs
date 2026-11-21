//! Interface C minimale autour de `render.rs` (partagé avec l'application Windows).
//!
//! JS appelle `alloc(n)`, écrit le Markdown (UTF-8) dans la mémoire, puis `render(ptr, len)`.
//! Le résultat est un tampon : 3 × u32 little-endian (longueurs titre, sommaire HTML, corps HTML)
//! suivis des trois chaînes UTF-8 concaténées. `free_result` libère le tampon.

#[path = "../../../src/render.rs"]
mod render;

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, cap: usize) {
    drop(Vec::from_raw_parts(ptr, 0, cap.max(1)));
}

/// Renvoie un pointeur vers le tampon résultat ; sa taille totale est écrite dans `out_len`.
#[no_mangle]
pub unsafe extern "C" fn render(ptr: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
    let src = String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len));
    let r = render::render(&src);
    let title = r.title.unwrap_or_default();
    let toc = render::toc_html(&r.toc);
    let mut buf = Vec::with_capacity(12 + title.len() + toc.len() + r.body.len());
    for n in [title.len(), toc.len(), r.body.len()] {
        buf.extend_from_slice(&(n as u32).to_le_bytes());
    }
    buf.extend_from_slice(title.as_bytes());
    buf.extend_from_slice(toc.as_bytes());
    buf.extend_from_slice(r.body.as_bytes());
    buf.shrink_to_fit();
    *out_len = buf.len();
    let p = buf.as_mut_ptr();
    std::mem::forget(buf);
    p
}

fn json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Pour l'éditeur : les blocs de premier niveau avec leur source exacte, en JSON
/// `{"head": "...", "blocks": [{"src": "...", "tail": "...", "html": "..."}]}` (UTF-8).
/// Même protocole mémoire que `render` ; le tampon se libère avec `dealloc`.
#[no_mangle]
pub unsafe extern "C" fn blocks(ptr: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
    let src = String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len));
    let (head, list) = render::blocks(&src);
    let mut s = String::with_capacity(src.len() * 3 + 64);
    s.push_str("{\"head\":");
    json_str(&mut s, &head);
    s.push_str(",\"blocks\":[");
    for (i, b) in list.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str("{\"src\":");
        json_str(&mut s, &b.src);
        s.push_str(",\"tail\":");
        json_str(&mut s, &b.tail);
        s.push_str(",\"html\":");
        json_str(&mut s, &b.html);
        s.push('}');
    }
    s.push_str("]}");
    let mut buf = s.into_bytes();
    buf.shrink_to_fit();
    *out_len = buf.len();
    let p = buf.as_mut_ptr();
    std::mem::forget(buf);
    p
}
