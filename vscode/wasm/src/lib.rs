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
