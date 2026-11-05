//! Markdown -> HTML. Produces the body (split into <section class="sec"> chunks so the
//! webview only lays out what is on screen) and the table of contents.

use pulldown_cmark::{html, CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd};
use std::collections::HashMap;
use std::fmt::Write;

pub struct Heading {
    pub level: u8,
    pub id: String,
    pub text: String,
}

pub struct Rendered {
    pub body: String,
    pub toc: Vec<Heading>,
    pub title: Option<String>,
}

/// Max top-level blocks per section before we cut a new one.
const BLOCKS_PER_SECTION: usize = 40;
const SEC_BREAK: &str = "</section>\n<section class=\"sec\">";

pub fn render(src: &str) -> Rendered {
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);
    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_MATH
        | Options::ENABLE_HEADING_ATTRIBUTES
        | Options::ENABLE_GFM
        | Options::ENABLE_DEFINITION_LIST
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS;

    let mut out: Vec<Event> = Vec::with_capacity(src.len() / 6);
    let mut toc: Vec<Heading> = Vec::new();
    let mut slugs: HashMap<String, usize> = HashMap::new();
    let mut title = None;

    let mut depth = 0usize;
    let mut blocks = 0usize;
    let mut in_meta = false;
    let mut math_block: Option<String> = None;
    let mut heading: Option<Tag> = None;
    let mut hbuf: Vec<Event> = Vec::new();
    let mut htext = String::new();

    out.push(Event::Html("<section class=\"sec\">".into()));

    for ev in Parser::new_ext(src, opts) {
        if in_meta {
            if let Event::End(TagEnd::MetadataBlock(_)) = ev {
                in_meta = false;
            }
            continue;
        }
        if let Some(m) = math_block.as_mut() {
            match ev {
                Event::Text(t) => m.push_str(&t),
                Event::End(TagEnd::CodeBlock) => {
                    let m = math_block.take().unwrap();
                    out.push(Event::Html("<p class=\"mathp\">".into()));
                    out.push(Event::DisplayMath(m.into()));
                    out.push(Event::Html("</p>".into()));
                    if depth == 0 {
                        blocks += 1;
                    }
                }
                _ => {}
            }
            continue;
        }
        if heading.is_some() {
            match ev {
                Event::End(TagEnd::Heading(level)) => {
                    let Some(Tag::Heading { id, classes, attrs, .. }) = heading.take() else { unreachable!() };
                    let text = htext.trim().to_string();
                    htext.clear();
                    let id = match id {
                        Some(id) => id.to_string(),
                        None => unique(&mut slugs, slug(&text)),
                    };
                    if title.is_none() && level as u8 == 1 {
                        title = Some(text.clone());
                    }
                    toc.push(Heading { level: level as u8, id: id.clone(), text });
                    out.push(Event::Start(Tag::Heading { level, id: Some(id.into()), classes, attrs }));
                    out.append(&mut hbuf);
                    out.push(Event::End(TagEnd::Heading(level)));
                    if depth == 0 {
                        blocks += 1;
                    }
                }
                other => {
                    match &other {
                        Event::Text(t) | Event::Code(t) | Event::InlineMath(t) => htext.push_str(t),
                        Event::SoftBreak | Event::HardBreak => htext.push(' '),
                        _ => {}
                    }
                    hbuf.push(other);
                }
            }
            continue;
        }

        match ev {
            Event::Start(Tag::MetadataBlock(_)) => in_meta = true,
            Event::Start(Tag::Heading { level, id, classes, attrs }) => {
                if depth == 0 && (level as u8) <= 3 && blocks > 0 {
                    out.push(Event::Html(SEC_BREAK.into()));
                    blocks = 0;
                }
                heading = Some(Tag::Heading { level, id, classes, attrs });
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(ref lang)))
                if matches!(lang.trim(), "math" | "latex" | "tex" | "katex") =>
            {
                math_block = Some(String::new());
            }
            Event::Start(Tag::Table(a)) => {
                out.push(Event::Html("<div class=\"table-wrap\">".into()));
                out.push(Event::Start(Tag::Table(a)));
                depth += 1;
            }
            Event::End(TagEnd::Table) => {
                out.push(Event::End(TagEnd::Table));
                out.push(Event::Html("</div>".into()));
                depth -= 1;
                end_block(&mut out, depth, &mut blocks);
            }
            Event::Start(t) => {
                depth += 1;
                out.push(Event::Start(t));
            }
            Event::End(t) => {
                depth = depth.saturating_sub(1);
                out.push(Event::End(t));
                end_block(&mut out, depth, &mut blocks);
            }
            Event::Rule => {
                out.push(Event::Rule);
                end_block(&mut out, depth, &mut blocks);
            }
            e => out.push(e),
        }
    }
    out.push(Event::Html("</section>".into()));

    let mut body = String::with_capacity(src.len() + src.len() / 2);
    html::push_html(&mut body, out.into_iter());
    let body = body.replace("<img ", "<img loading=\"lazy\" decoding=\"async\" ");
    Rendered { body, toc, title }
}

fn end_block(out: &mut Vec<Event>, depth: usize, blocks: &mut usize) {
    if depth == 0 {
        *blocks += 1;
        if *blocks >= BLOCKS_PER_SECTION {
            out.push(Event::Html(CowStr::Borrowed(SEC_BREAK)));
            *blocks = 0;
        }
    }
}

fn slug(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    let mut dash = false;
    for c in s.chars() {
        if c.is_alphanumeric() {
            o.extend(c.to_lowercase());
            dash = false;
        } else if matches!(c, ' ' | '-' | '_' | '.') && !o.is_empty() && !dash {
            o.push('-');
            dash = true;
        }
    }
    while o.ends_with('-') {
        o.pop();
    }
    if o.is_empty() {
        o.push_str("section");
    }
    o
}

fn unique(seen: &mut HashMap<String, usize>, base: String) -> String {
    let n = seen.entry(base.clone()).or_insert(0);
    *n += 1;
    if *n == 1 { base } else { format!("{base}-{}", *n - 1) }
}

pub fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            _ => o.push(c),
        }
    }
    o
}

pub fn toc_html(toc: &[Heading]) -> String {
    let mut s = String::with_capacity(toc.len() * 80);
    for (i, h) in toc.iter().enumerate() {
        let _ = write!(
            s,
            "<a href=\"#{}\" class=\"t{}\" data-i=\"{}\">{}</a>",
            esc(&h.id),
            h.level,
            i,
            esc(&h.text)
        );
    }
    s
}
