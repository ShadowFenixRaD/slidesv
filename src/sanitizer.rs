use crate::discovery::DiscoveredInput;
use crate::parser::{
    LayerBand, LayerMeta, ParsedShortcut, SizingSpec, TransitionType, create_single_slide_selector,
    matches_slide, max_positive_slide, parse_layer_label, parse_sidecar_filename,
    parse_tier1_filename,
};
use regex::Regex;
use roxmltree::{Document, Node};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

const INKSCAPE_NS: &str = "http://www.inkscape.org/namespaces/inkscape";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubLayerMeta {
    pub layer_key: String,
    pub step: usize,
    pub group: Option<String>,
    pub is_default: bool,
    pub languages: Vec<String>,
    pub shortcuts: Vec<ParsedShortcut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposedLayer {
    pub id: String,
    pub meta: LayerMeta,
    pub sub_layers: Vec<SubLayerMeta>,
    pub svg_markup: String,
    pub order: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposedSlide {
    pub index: usize,
    pub title: String,
    pub transition: TransitionType,
    pub max_step: usize,
    pub layers: Vec<ComposedLayer>,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterGroupOption {
    pub layer_key: String,
    pub title: String,
    pub is_default: bool,
    pub shortcuts: Vec<ParsedShortcut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterGroupInfo {
    pub name: String,
    pub options: Vec<FilterGroupOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleFilterInfo {
    pub layer_key: String,
    pub title: String,
    pub is_default: bool,
    pub shortcuts: Vec<ParsedShortcut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckData {
    pub total_slides: usize,
    pub slides: Vec<ComposedSlide>,
    pub languages: Vec<String>,
    pub groups: Vec<FilterGroupInfo>,
    pub toggles: Vec<ToggleFilterInfo>,
    pub build_date: String,
}

#[derive(Debug, Clone)]
struct ManagedGroupInfo {
    full_range: std::ops::Range<usize>,
    open_tag_start: usize,
    open_tag_end: usize,
    meta: LayerMeta,
    desc_notes: Vec<String>,
}

#[derive(Debug, Clone)]
enum FileKind {
    /// Whole SVG is a single layer (Tier 1 without nested grammar <g>s, or Tier 3)
    Whole {
        meta: LayerMeta,
        raw_svg: String,
        desc_notes: Vec<String>,
        system_languages: Vec<String>,
    },
    /// Intact multi-layer SVG (Tier 1 with nested grammar <g>s, or Tier 2)
    MultiLayer {
        clean_raw: String,
        file_meta: Option<LayerMeta>,
        groups: Vec<ManagedGroupInfo>,
        desc_notes: Vec<String>,
        system_languages: Vec<String>,
    },
}

#[derive(Debug, Clone)]
struct ParsedFileEntry {
    file_idx: usize,
    kind: FileKind,
}

fn prolog_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?is)^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!DOCTYPE[\s\S]*?>\s*)?").unwrap()
    })
}

fn root_svg_open_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<svg\b([^>]*)>").unwrap())
}

fn switch_open_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)<switch\b([^>]*)>").unwrap())
}

fn switch_close_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)</switch\s*>").unwrap())
}

fn system_lang_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)\bsystemLanguage\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap())
}

fn id_attr_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\bid\s*=\s*(?:"([^"]+)"|'([^']+)')"#).unwrap())
}

fn url_ref_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"url\(\s*#([^)\s'\x22]+)\s*\)").unwrap())
}

fn href_ref_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)\b((?:xlink:)?href)\s*=\s*(?:"(#[^"]*)"|'(#[^']*)')"#).unwrap()
    })
}

fn smil_attr_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)\b(begin|end)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap())
}

fn smil_sync_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\b([A-Za-z_][A-Za-z0-9_:-]*)\.([A-Za-z_][A-Za-z0-9_()-]*)").unwrap()
    })
}

pub fn strip_xml_prolog(raw: &str) -> String {
    let no_bom = raw.trim_start_matches('\u{FEFF}');
    prolog_regex().replace(no_bom, "").trim().to_string()
}

/// Strip initial visibility/display/opacity attributes and inline style properties
/// on a managed `<g ...>` opening tag so runtime state controls visibility deterministically.
pub fn strip_g_visibility(g_open_tag: &str) -> String {
    static VIS_ATTR_RE: OnceLock<Regex> = OnceLock::new();
    static STYLE_ATTR_RE: OnceLock<Regex> = OnceLock::new();
    static STYLE_VIS_RE: OnceLock<Regex> = OnceLock::new();

    let vis_attr = VIS_ATTR_RE.get_or_init(|| {
        Regex::new(r#"(?i)\s+\b(?:display|visibility|opacity)\s*=\s*(?:"[^"]*"|'[^']*')"#).unwrap()
    });
    let style_attr =
        STYLE_ATTR_RE.get_or_init(|| Regex::new(r#"(?is)\s*\bstyle\s*=\s*"([^"]*)""#).unwrap());
    let style_vis =
        STYLE_VIS_RE.get_or_init(|| Regex::new(r"(?i)^(?:display|visibility|opacity)\s*:").unwrap());

    let mut cleaned = vis_attr.replace_all(g_open_tag, "").into_owned();
    cleaned = style_attr
        .replace(&cleaned, |scaps: &regex::Captures| {
            let kept: Vec<&str> = scaps[1]
                .split(';')
                .map(|p| p.trim())
                .filter(|p| !p.is_empty() && !style_vis.is_match(p))
                .collect();
            if kept.is_empty() {
                String::new()
            } else {
                format!(" style=\"{}\"", kept.join("; "))
            }
        })
        .into_owned();
    cleaned
}

fn split_tag_closing(tag: &str) -> Option<(&str, &str)> {
    if let Some(prefix) = tag.strip_suffix("/>") {
        Some((prefix, "/>"))
    } else if let Some(prefix) = tag.strip_suffix('>') {
        Some((prefix, ">"))
    } else {
        None
    }
}

pub fn force_g_hidden(g_open_tag: &str) -> String {
    static STYLE_ATTR_RE: OnceLock<Regex> = OnceLock::new();
    let style_attr =
        STYLE_ATTR_RE.get_or_init(|| Regex::new(r#"(?is)\bstyle\s*=\s*"([^"]*)""#).unwrap());

    let cleaned = strip_g_visibility(g_open_tag);
    if style_attr.is_match(&cleaned) {
        style_attr
            .replace(&cleaned, |caps: &regex::Captures| {
                let mut parts: Vec<String> = caps[1]
                    .split(';')
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect();
                parts.push("display: none".to_string());
                format!("style=\"{}\"", parts.join("; "))
            })
            .into_owned()
    } else if let Some((prefix, closing)) = split_tag_closing(&cleaned) {
        format!("{prefix} style=\"display: none\"{closing}")
    } else {
        cleaned
    }
}

fn escape_attr(val: &str) -> String {
    val.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn annotate_active_g(g_open_tag: &str, meta: &LayerMeta) -> String {
    let cleaned = strip_g_visibility(g_open_tag);
    let Some((prefix, closing)) = split_tag_closing(&cleaned) else {
        return cleaned;
    };

    let mut attrs = String::new();
    let slides_val = if meta.selector.is_global {
        "*"
    } else {
        meta.selector.raw.as_str()
    };
    attrs.push_str(&format!(" data-slides=\"{}\"", escape_attr(slides_val)));
    attrs.push_str(&format!(" data-step=\"{}\"", meta.step));

    if !meta.languages.is_empty() {
        attrs.push_str(&format!(
            " data-lang=\"{}\"",
            escape_attr(&meta.languages.join(","))
        ));
    }
    if meta.group.is_some() || !meta.shortcuts.is_empty() {
        attrs.push_str(&format!(" data-filter=\"{}\"", escape_attr(&meta.layer_key)));
    }
    if let Some(ref g) = meta.group {
        attrs.push_str(&format!(" data-group=\"{}\"", escape_attr(g)));
    }
    if meta.is_default {
        attrs.push_str(" data-default=\"1\"");
    }
    let band_str = match meta.band {
        LayerBand::Underlay => "underlay",
        LayerBand::Normal => "normal",
        LayerBand::Overlay => "overlay",
    };
    attrs.push_str(&format!(" data-band=\"{band_str}\""));

    if meta.sizing.unboxed {
        attrs.push_str(" data-unboxed=\"1\"");
    }
    if meta.sizing.sized {
        attrs.push_str(" data-sized=\"1\"");
    }

    format!("{prefix}{attrs}{closing}")
}

fn find_open_tag_end(source: &str, start: usize) -> usize {
    let bytes = source.as_bytes();
    let mut i = start;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let b = bytes[i];
        match quote {
            Some(q) if b == q => quote = None,
            Some(_) => {}
            None if b == b'"' || b == b'\'' => quote = Some(b),
            None if b == b'>' => return i + 1,
            None => {}
        }
        i += 1;
    }
    source.len()
}

fn normalize_root_svg_attrs(attrs: &str, band: LayerBand, sizing: &SizingSpec) -> String {
    static VB_RE: OnceLock<Regex> = OnceLock::new();
    static W_RE: OnceLock<Regex> = OnceLock::new();
    static H_RE: OnceLock<Regex> = OnceLock::new();
    static WH_STRIP_RE: OnceLock<Regex> = OnceLock::new();
    static PAR_RE: OnceLock<Regex> = OnceLock::new();
    static STYLE_RE: OnceLock<Regex> = OnceLock::new();
    static BG_PROP_RE: OnceLock<Regex> = OnceLock::new();

    let vb_re = VB_RE.get_or_init(|| Regex::new(r"(?i)\bviewBox\s*=").unwrap());
    let w_re = W_RE.get_or_init(|| {
        Regex::new(
            r#"(?i)\bwidth\s*=\s*(?:"([0-9.]+)(?:px|mm|cm|in|pt|pc|em|rem)?"|'([0-9.]+)(?:px|mm|cm|in|pt|pc|em|rem)?')"#,
        )
        .unwrap()
    });
    let h_re = H_RE.get_or_init(|| {
        Regex::new(
            r#"(?i)\bheight\s*=\s*(?:"([0-9.]+)(?:px|mm|cm|in|pt|pc|em|rem)?"|'([0-9.]+)(?:px|mm|cm|in|pt|pc|em|rem)?')"#,
        )
        .unwrap()
    });
    let wh_strip = WH_STRIP_RE.get_or_init(|| {
        Regex::new(r#"(?i)\s+\b(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')"#).unwrap()
    });
    let par_re = PAR_RE
        .get_or_init(|| Regex::new(r#"(?i)\bpreserveAspectRatio\s*=\s*(?:"[^"]*"|'[^']*')"#).unwrap());
    let style_re = STYLE_RE.get_or_init(|| Regex::new(r#"(?is)\bstyle\s*=\s*"([^"]*)""#).unwrap());
    let bg_prop =
        BG_PROP_RE.get_or_init(|| Regex::new(r"(?i)^background(?:-color)?\s*:").unwrap());

    let mut cleaned = attrs.to_string();

    if sizing.sized {
        // -sized: do NOT touch width, height, viewBox, or preserveAspectRatio
        if !cleaned.contains("data-sized=") {
            cleaned.push_str(" data-sized=\"1\"");
        }
    } else {
        if !vb_re.is_match(&cleaned) {
            let w = w_re
                .captures(&cleaned)
                .and_then(|c| c.get(1).or_else(|| c.get(2)))
                .map(|m| m.as_str().to_string());
            let h = h_re
                .captures(&cleaned)
                .and_then(|c| c.get(1).or_else(|| c.get(2)))
                .map(|m| m.as_str().to_string());
            if let (Some(w), Some(h)) = (w, h) {
                cleaned.push_str(&format!(" viewBox=\"0 0 {w} {h}\""));
            }
        }

        cleaned = wh_strip.replace_all(&cleaned, "").into_owned();

        let par_val = if sizing.unboxed {
            if !cleaned.contains("data-unboxed=") {
                cleaned.push_str(" data-unboxed=\"1\"");
            }
            "preserveAspectRatio=\"none\""
        } else {
            "preserveAspectRatio=\"xMidYMid meet\""
        };
        if par_re.is_match(&cleaned) {
            cleaned = par_re.replace_all(&cleaned, par_val).into_owned();
        } else {
            cleaned.push(' ');
            cleaned.push_str(par_val);
        }
    }

    if band == LayerBand::Underlay || band == LayerBand::Overlay {
        if style_re.is_match(&cleaned) {
            cleaned = style_re
                .replace(&cleaned, |caps: &regex::Captures| {
                    let mut kept: Vec<String> = caps[1]
                        .split(';')
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty() && !bg_prop.is_match(p))
                        .collect();
                    kept.push("background: transparent".to_string());
                    format!("style=\"{}\"", kept.join("; "))
                })
                .into_owned();
        } else {
            cleaned.push_str(" style=\"background: transparent\"");
        }
    }

    cleaned
}

fn unit_to_px(val: f64, unit: &str) -> Option<f64> {
    match unit.to_ascii_lowercase().as_str() {
        "" | "px" => Some(val),
        "in" => Some(val * 96.0),
        "cm" => Some(val * 96.0 / 2.54),
        "mm" => Some(val * 96.0 / 25.4),
        "pt" => Some(val * 96.0 / 72.0),
        "pc" => Some(val * 16.0),
        _ => None,
    }
}

fn format_num(v: f64) -> String {
    let rounded = (v * 1000.0).round() / 1000.0;
    if (rounded - rounded.round()).abs() < 1e-6 {
        format!("{}", rounded.round() as i64)
    } else {
        let s = format!("{rounded:.3}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn extract_root_dim_px(attrs: &str, attr_name: &str) -> Option<f64> {
    let pattern = format!(
        r#"(?i)\b{attr_name}\s*=\s*(?:"([0-9.]+)(px|mm|cm|in|pt|pc)?"|'([0-9.]+)(px|mm|cm|in|pt|pc)?')"#
    );
    let re = Regex::new(&pattern).ok()?;
    let caps = re.captures(attrs)?;
    let num_str = caps.get(1).or_else(|| caps.get(3))?.as_str();
    let unit_str = caps
        .get(2)
        .or_else(|| caps.get(4))
        .map(|m| m.as_str())
        .unwrap_or("");
    let val: f64 = num_str.parse().ok()?;
    unit_to_px(val, unit_str)
}

fn extract_viewbox_dims(svg: &str) -> Option<(f64, f64)> {
    static VB_VAL_RE: OnceLock<Regex> = OnceLock::new();
    let re = VB_VAL_RE.get_or_init(|| {
        Regex::new(r#"(?i)\bviewBox\s*=\s*(?:"([^"]+)"|'([^']+)')"#).unwrap()
    });
    let caps = re.captures(svg)?;
    let raw = caps.get(1).or_else(|| caps.get(2))?.as_str();
    let nums: Vec<f64> = raw
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<f64>().ok())
        .collect();
    if nums.len() == 4 && nums[2] > 0.0 && nums[3] > 0.0 {
        Some((nums[2], nums[3]))
    } else {
        None
    }
}

/// Convert geometric attributes with physical units (`px`, `mm`, `cm`, `in`, `pt`, `pc`)
/// into `viewBox` user units so all elements scale proportionally with the slide,
/// skipping any `<g ... data-sized="1">...</g>` subtrees.
fn normalize_inner_units_to_viewbox(
    full_svg: &str,
    body_start: usize,
    scale_x: f64,
    scale_y: f64,
) -> String {
    static GEOM_ATTR_RE: OnceLock<Regex> = OnceLock::new();
    let geom_re = GEOM_ATTR_RE.get_or_init(|| {
        Regex::new(
            r#"(?i)\b(x|y|x1|y1|x2|y2|dx|dy|cx|cy|r|rx|ry|width|height|font-size|stroke-width)\s*=\s*(?:"([0-9.]+)(px|mm|cm|in|pt|pc)"|'([0-9.]+)(px|mm|cm|in|pt|pc)')"#,
        )
        .unwrap()
    });

    let replace_chunk = |chunk: &str| -> String {
        geom_re
            .replace_all(chunk, |caps: &regex::Captures| {
                let attr = &caps[1];
                let num_str = caps.get(2).or_else(|| caps.get(4)).map(|m| m.as_str()).unwrap_or("0");
                let unit = caps.get(3).or_else(|| caps.get(5)).map(|m| m.as_str()).unwrap_or("px");
                let Ok(val) = num_str.parse::<f64>() else {
                    return caps[0].to_string();
                };
                let Some(px) = unit_to_px(val, unit) else {
                    return caps[0].to_string();
                };
                let factor = match attr.to_ascii_lowercase().as_str() {
                    "y" | "y1" | "y2" | "dy" | "cy" | "ry" | "height" => scale_y,
                    _ => scale_x,
                };
                format!("{attr}=\"{}\"", format_num(px * factor))
            })
            .into_owned()
    };

    let body = &full_svg[body_start..];
    if !body.contains("data-sized=\"1\"") {
        return format!("{}{}", &full_svg[..body_start], replace_chunk(body));
    }

    let Ok(doc) = Document::parse(full_svg) else {
        return format!("{}{}", &full_svg[..body_start], replace_chunk(body));
    };

    let mut sized_ranges: Vec<std::ops::Range<usize>> = doc
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("g") && n.attribute("data-sized") == Some("1"))
        .map(|n| n.range())
        .collect();
    sized_ranges.sort_by_key(|r| r.start);

    let mut out = String::with_capacity(full_svg.len());
    out.push_str(&full_svg[..body_start]);
    let mut pos = body_start;
    for r in sized_ranges {
        if r.start > pos && r.start <= full_svg.len() {
            out.push_str(&replace_chunk(&full_svg[pos..r.start]));
            pos = r.start;
        }
        if r.end > pos && r.end <= full_svg.len() {
            out.push_str(&full_svg[pos..r.end]);
            pos = r.end;
        }
    }
    if pos < full_svg.len() {
        out.push_str(&replace_chunk(&full_svg[pos..]));
    }
    out
}

pub fn sanitize_and_namespace_svg(
    raw_svg: &str,
    prefix: &str,
    band: LayerBand,
    sizing: &SizingSpec,
) -> String {
    let mut svg = strip_xml_prolog(raw_svg);

    let mut unit_scale: Option<(f64, f64)> = None;
    if !sizing.sized
        && let Some(caps) = root_svg_open_regex().captures(&svg)
    {
        let orig_attrs = &caps[1];
        let root_w_px = extract_root_dim_px(orig_attrs, "width");
        let root_h_px = extract_root_dim_px(orig_attrs, "height");
        let normalized_root = normalize_root_svg_attrs(orig_attrs, band, sizing);
        if let Some((vb_w, vb_h)) = extract_viewbox_dims(&normalized_root) {
            let sx = root_w_px.map(|w| vb_w / w).unwrap_or(1.0);
            let sy = root_h_px.map(|h| vb_h / h).unwrap_or(sx);
            unit_scale = Some((sx, sy));
        }
    }

    svg = root_svg_open_regex()
        .replace(&svg, |caps: &regex::Captures| {
            let attrs = normalize_root_svg_attrs(&caps[1], band, sizing);
            format!("<svg{attrs}>")
        })
        .into_owned();

    if !sizing.sized
        && let Some((sx, sy)) = unit_scale
        && let Some(m) = root_svg_open_regex().find(&svg)
    {
        svg = normalize_inner_units_to_viewbox(&svg, m.end(), sx, sy);
    }

    // Convert <switch> into <g data-slidesv-switch="1"> so the browser's native
    // <switch> layout rule doesn't suppress non-first children when JS switches languages.
    svg = switch_open_regex()
        .replace_all(&svg, "<g data-slidesv-switch=\"1\"$1>")
        .into_owned();
    svg = switch_close_regex().replace_all(&svg, "</g>").into_owned();

    svg = system_lang_regex()
        .replace_all(&svg, |caps: &regex::Captures| {
            let val = caps
                .get(1)
                .or_else(|| caps.get(2))
                .map(|m| m.as_str())
                .unwrap_or("");
            format!("data-system-language=\"{val}\"")
        })
        .into_owned();

    let mut known_ids = HashSet::new();
    for caps in id_attr_regex().captures_iter(&svg) {
        if let Some(m) = caps.get(1).or_else(|| caps.get(2)) {
            known_ids.insert(m.as_str().to_string());
        }
    }

    if !known_ids.is_empty() {
        svg = id_attr_regex()
            .replace_all(&svg, |caps: &regex::Captures| {
                let val = caps
                    .get(1)
                    .or_else(|| caps.get(2))
                    .map(|m| m.as_str())
                    .unwrap_or("");
                format!("id=\"{prefix}{val}\"")
            })
            .into_owned();

        svg = url_ref_regex()
            .replace_all(&svg, |caps: &regex::Captures| {
                let ref_id = &caps[1];
                if known_ids.contains(ref_id) {
                    format!("url(#{prefix}{ref_id})")
                } else {
                    caps[0].to_string()
                }
            })
            .into_owned();

        svg = href_ref_regex()
            .replace_all(&svg, |caps: &regex::Captures| {
                let attr_name = &caps[1];
                let href = caps
                    .get(2)
                    .or_else(|| caps.get(3))
                    .map(|m| m.as_str())
                    .unwrap_or("");
                let ref_id = href.strip_prefix('#').unwrap_or(href);
                if known_ids.contains(ref_id) {
                    format!("{attr_name}=\"#{prefix}{ref_id}\"")
                } else {
                    caps[0].to_string()
                }
            })
            .into_owned();

        svg = smil_attr_regex()
            .replace_all(&svg, |caps: &regex::Captures| {
                let attr_name = &caps[1];
                let val = caps
                    .get(2)
                    .or_else(|| caps.get(3))
                    .map(|m| m.as_str())
                    .unwrap_or("");
                let rewritten: Vec<String> = val
                    .split(';')
                    .map(|item| {
                        let trimmed = item.trim();
                        if trimmed.is_empty() {
                            return item.to_string();
                        }
                        smil_sync_regex()
                            .replace_all(trimmed, |scaps: &regex::Captures| {
                                let id_part = &scaps[1];
                                let event_part = &scaps[2];
                                if known_ids.contains(id_part) {
                                    format!("{prefix}{id_part}.{event_part}")
                                } else {
                                    scaps[0].to_string()
                                }
                            })
                            .into_owned()
                    })
                    .collect();
                format!("{attr_name}=\"{}\"", rewritten.join(";"))
            })
            .into_owned();
    }

    svg
}

fn extract_system_languages(svg: &str) -> Vec<String> {
    let mut langs = Vec::new();
    for caps in system_lang_regex().captures_iter(svg) {
        let raw = caps
            .get(1)
            .or_else(|| caps.get(2))
            .map(|m| m.as_str())
            .unwrap_or("");
        for part in raw.split(',') {
            let code = part.trim().to_ascii_lowercase();
            if !code.is_empty() && !langs.contains(&code) {
                langs.push(code);
            }
        }
    }
    langs
}

fn extract_scoped_desc_notes(
    doc: &Document,
    root: Node,
    groups: &mut [ManagedGroupInfo],
) -> Vec<String> {
    let mut root_notes = Vec::new();
    for node in doc.descendants() {
        if node.has_tag_name("desc")
            && node.ancestors().any(|a| a == root)
            && let Some(txt) = node.text()
        {
            let trimmed = txt.trim().to_string();
            if trimmed.is_empty() {
                continue;
            }
            let r = node.range();
            // Find the innermost managed <g> enclosing this <desc>
            let owner_idx = groups
                .iter()
                .enumerate()
                .filter(|(_, g)| g.full_range.start <= r.start && r.end <= g.full_range.end)
                .max_by_key(|(_, g)| g.full_range.start)
                .map(|(idx, _)| idx);

            if let Some(idx) = owner_idx {
                if !groups[idx].desc_notes.contains(&trimmed) {
                    groups[idx].desc_notes.push(trimmed);
                }
            } else if !root_notes.contains(&trimmed) {
                root_notes.push(trimmed);
            }
        }
    }
    root_notes
}

fn escape_xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn resolve_placeholders(
    markup: &str,
    index: usize,
    total: usize,
    title: &str,
    progress: usize,
    date: &str,
) -> String {
    markup
        .replace("{{INDEX}}", &index.to_string())
        .replace("{{TOTAL}}", &total.to_string())
        .replace("{{TITLE}}", &escape_xml_text(title))
        .replace("{{PROGRESS}}", &progress.to_string())
        .replace("{{DATE}}", &escape_xml_text(date))
}

fn merge_nested_meta(parent: &LayerMeta, child: &LayerMeta) -> LayerMeta {
    let mut merged = parent.clone();
    merged.layer_key = child.layer_key.clone();
    if !child.selector.is_global {
        merged.selector = child.selector.clone();
    }
    if child.step > 0 {
        merged.step = child.step;
    }
    if child.band != LayerBand::Normal {
        merged.band = child.band;
        merged.z_index = child.z_index;
    }
    if !child.languages.is_empty() {
        merged.languages = child.languages.clone();
    }
    if child.group.is_some() {
        merged.group = child.group.clone();
        merged.is_default = child.is_default;
    }
    if !child.shortcuts.is_empty() {
        merged.shortcuts = child.shortcuts.clone();
        if child.is_default {
            merged.is_default = true;
        }
    }
    if child.raw_title != "layer" {
        merged.title = child.title.clone();
        merged.raw_title = child.raw_title.clone();
    }
    if child.sizing.unboxed {
        merged.sizing.unboxed = true;
    }
    if child.sizing.sized {
        merged.sizing.sized = true;
    }
    merged
}

/// Non-destructively rewrite `<g ...>` opening tags in place inside the intact SVG:
/// - Active `<g>`s for this `(band, z_index)` on `slide_index` get visibility stripped + `data-*` attributes.
/// - Inactive `<g>`s (belonging to other slides or other bands) get `style="display: none"` while
///   keeping the entire `<svg>` root, `<defs>`, `<style>`, and ancestor `transform` chains intact.
fn rewrite_intact_svg_for_slot(
    clean_raw: &str,
    groups: &[ManagedGroupInfo],
    active_indices: &HashSet<usize>,
) -> String {
    let mut edits: Vec<(usize, usize, String)> = Vec::with_capacity(groups.len());
    for (idx, g) in groups.iter().enumerate() {
        let orig_open = &clean_raw[g.open_tag_start..g.open_tag_end];
        let is_ancestor_of_active = active_indices.iter().any(|&a_idx| {
            a_idx != idx
                && g.full_range.start < groups[a_idx].full_range.start
                && groups[a_idx].full_range.end <= g.full_range.end
        });
        let replacement = if active_indices.contains(&idx) {
            annotate_active_g(orig_open, &g.meta)
        } else if is_ancestor_of_active {
            strip_g_visibility(orig_open)
        } else {
            force_g_hidden(orig_open)
        };
        edits.push((g.open_tag_start, g.open_tag_end, replacement));
    }

    edits.sort_by_key(|(start, _, _)| *start);
    let mut out = String::with_capacity(clean_raw.len() + 256);
    let mut pos = 0;
    for (start, end, repl) in edits {
        if start >= pos && end <= clean_raw.len() {
            out.push_str(&clean_raw[pos..start]);
            out.push_str(&repl);
            pos = end;
        }
    }
    out.push_str(&clean_raw[pos..]);
    out
}

pub fn compose_deck(
    svg_files: &[DiscoveredInput],
    sidecar_files: &[DiscoveredInput],
    build_date: &str,
) -> DeckData {
    let mut entries: Vec<ParsedFileEntry> = Vec::with_capacity(svg_files.len());
    let mut current_max_slide: usize = 0;

    for (file_idx, file) in svg_files.iter().enumerate() {
        let clean_raw = strip_xml_prolog(&file.content);
        let tier1_meta = parse_tier1_filename(&file.filename);
        let sys_langs = extract_system_languages(&clean_raw);

        let doc = match Document::parse(&clean_raw) {
            Ok(d) => d,
            Err(_) => {
                let meta = tier1_meta.unwrap_or_else(|| {
                    current_max_slide += 1;
                    let stem = file.filename.strip_suffix(".svg").unwrap_or(&file.filename);
                    LayerMeta {
                        filename: file.filename.clone(),
                        layer_key: file.filename.clone(),
                        selector: create_single_slide_selector(current_max_slide),
                        title: stem.replace('_', " "),
                        raw_title: stem.to_string(),
                        band: LayerBand::Normal,
                        z_index: 0,
                        step: 0,
                        transition: TransitionType::Fade,
                        group: None,
                        is_default: false,
                        languages: Vec::new(),
                        shortcuts: Vec::new(),
                        sizing: SizingSpec::default(),
                    }
                });
                current_max_slide = current_max_slide.max(max_positive_slide(&meta.selector));
                entries.push(ParsedFileEntry {
                    file_idx,
                    kind: FileKind::Whole {
                        meta,
                        raw_svg: clean_raw,
                        desc_notes: Vec::new(),
                        system_languages: sys_langs,
                    },
                });
                continue;
            }
        };

        let root = doc.root_element();

        // Inspect all <g> elements at any depth (preserving parent transform chains)
        let mut matched_groups: Vec<ManagedGroupInfo> = Vec::new();
        for node in doc.descendants() {
            if node.is_element() && node.has_tag_name("g") {
                let label = node
                    .attribute((INKSCAPE_NS, "label"))
                    .or_else(|| node.attribute("id"));
                if let Some(lbl) = label {
                    let key = format!("{}#{}", file.filename, lbl);
                    if let Some(g_meta) = parse_layer_label(lbl, &key) {
                        let meta = if let Some(ref fm) = tier1_meta {
                            merge_nested_meta(fm, &g_meta)
                        } else {
                            g_meta
                        };
                        let full_range = node.range();
                        let start = full_range.start;
                        let open_end = find_open_tag_end(&clean_raw, start);
                        matched_groups.push(ManagedGroupInfo {
                            full_range,
                            open_tag_start: start,
                            open_tag_end: open_end,
                            meta,
                            desc_notes: Vec::new(),
                        });
                    }
                }
            }
        }

        let desc_notes = extract_scoped_desc_notes(&doc, root, &mut matched_groups);

        if let Some(file_meta) = tier1_meta {
            current_max_slide = current_max_slide.max(max_positive_slide(&file_meta.selector));
            if matched_groups.is_empty() {
                let notes = if file_meta.band == LayerBand::Normal {
                    desc_notes
                } else {
                    Vec::new()
                };
                entries.push(ParsedFileEntry {
                    file_idx,
                    kind: FileKind::Whole {
                        meta: file_meta,
                        raw_svg: clean_raw,
                        desc_notes: notes,
                        system_languages: sys_langs,
                    },
                });
            } else {
                for g in &matched_groups {
                    current_max_slide = current_max_slide.max(max_positive_slide(&g.meta.selector));
                }
                let notes = if file_meta.band == LayerBand::Normal {
                    desc_notes
                } else {
                    Vec::new()
                };
                entries.push(ParsedFileEntry {
                    file_idx,
                    kind: FileKind::MultiLayer {
                        clean_raw,
                        file_meta: Some(file_meta),
                        groups: matched_groups,
                        desc_notes: notes,
                        system_languages: sys_langs,
                    },
                });
            }
        } else if !matched_groups.is_empty() {
            for g in &matched_groups {
                current_max_slide = current_max_slide.max(max_positive_slide(&g.meta.selector));
            }
            entries.push(ParsedFileEntry {
                file_idx,
                kind: FileKind::MultiLayer {
                    clean_raw,
                    file_meta: None,
                    groups: matched_groups,
                    desc_notes,
                    system_languages: sys_langs,
                },
            });
        } else {
            // Tier 3: sequential auto-slide fallback
            current_max_slide += 1;
            let stem = file.filename.strip_suffix(".svg").unwrap_or(&file.filename);
            let meta = LayerMeta {
                filename: file.filename.clone(),
                layer_key: file.filename.clone(),
                selector: create_single_slide_selector(current_max_slide),
                title: stem.replace('_', " "),
                raw_title: stem.to_string(),
                band: LayerBand::Normal,
                z_index: 0,
                step: 0,
                transition: TransitionType::Fade,
                group: None,
                is_default: false,
                languages: Vec::new(),
                shortcuts: Vec::new(),
                sizing: SizingSpec::default(),
            };
            entries.push(ParsedFileEntry {
                file_idx,
                kind: FileKind::Whole {
                    meta,
                    raw_svg: clean_raw,
                    desc_notes,
                    system_languages: sys_langs,
                },
            });
        }
    }

    let total_slides = if entries.is_empty() {
        0
    } else {
        current_max_slide.max(1)
    };

    // Collect languages, groups, and toggles across all entries
    let mut languages: Vec<String> = Vec::new();
    fn add_lang(languages: &mut Vec<String>, code: &str) {
        let norm = code.trim().to_ascii_lowercase();
        if !norm.is_empty() && !languages.contains(&norm) {
            languages.push(norm);
        }
    }

    let mut group_order: Vec<String> = Vec::new();
    let mut group_map: HashMap<String, Vec<FilterGroupOption>> = HashMap::new();
    let mut toggles: Vec<ToggleFilterInfo> = Vec::new();
    let mut seen_toggle_keys: HashSet<String> = HashSet::new();

    let mut register_meta = |meta: &LayerMeta, languages: &mut Vec<String>| {
        for l in &meta.languages {
            add_lang(languages, l);
        }
        if let Some(ref gname) = meta.group {
            if !group_map.contains_key(gname) {
                group_order.push(gname.clone());
                group_map.insert(gname.clone(), Vec::new());
            }
            let opts = group_map.get_mut(gname).unwrap();
            if !opts.iter().any(|o| o.layer_key == meta.layer_key) {
                opts.push(FilterGroupOption {
                    layer_key: meta.layer_key.clone(),
                    title: meta.title.clone(),
                    is_default: meta.is_default,
                    shortcuts: meta.shortcuts.clone(),
                });
            }
        } else if !meta.shortcuts.is_empty() && seen_toggle_keys.insert(meta.layer_key.clone()) {
            toggles.push(ToggleFilterInfo {
                layer_key: meta.layer_key.clone(),
                title: meta.title.clone(),
                is_default: meta.is_default,
                shortcuts: meta.shortcuts.clone(),
            });
        }
    };

    for entry in &entries {
        match &entry.kind {
            FileKind::Whole {
                meta,
                system_languages,
                ..
            } => {
                for l in system_languages {
                    add_lang(&mut languages, l);
                }
                register_meta(meta, &mut languages);
            }
            FileKind::MultiLayer {
                file_meta,
                groups,
                system_languages,
                ..
            } => {
                for l in system_languages {
                    add_lang(&mut languages, l);
                }
                if let Some(fm) = file_meta {
                    register_meta(fm, &mut languages);
                }
                for g in groups {
                    register_meta(&g.meta, &mut languages);
                }
            }
        }
    }

    let mut groups: Vec<FilterGroupInfo> = Vec::new();
    for gname in group_order {
        if let Some(mut opts) = group_map.remove(&gname) {
            if !opts.is_empty() && !opts.iter().any(|o| o.is_default) {
                opts[0].is_default = true;
            }
            groups.push(FilterGroupInfo {
                name: gname,
                options: opts,
            });
        }
    }

    let parsed_sidecars: Vec<_> = sidecar_files
        .iter()
        .filter_map(|f| parse_sidecar_filename(&f.filename).map(|m| (m, f.content.trim())))
        .collect();

    let mut slides = Vec::with_capacity(total_slides);
    for slide_index in 1..=total_slides {
        // Build layer slots for this slide: (z_index, min_step, file_order, ComposedLayer, desc_notes)
        struct SlotCandidate {
            z_index: i32,
            min_step: usize,
            file_order: usize,
            meta: LayerMeta,
            sub_layers: Vec<SubLayerMeta>,
            svg_template: String,
            desc_notes: Vec<String>,
        }

        let mut candidates: Vec<SlotCandidate> = Vec::new();

        for (file_order, entry) in entries.iter().enumerate() {
            match &entry.kind {
                FileKind::Whole {
                    meta,
                    raw_svg,
                    desc_notes,
                    ..
                } => {
                    if !matches_slide(&meta.selector, slide_index) {
                        continue;
                    }
                    let prefix = format!("f{}_", entry.file_idx);
                    let svg_template =
                        sanitize_and_namespace_svg(raw_svg, &prefix, meta.band, &meta.sizing);
                    candidates.push(SlotCandidate {
                        z_index: meta.z_index,
                        min_step: meta.step,
                        file_order,
                        meta: meta.clone(),
                        sub_layers: Vec::new(),
                        svg_template,
                        desc_notes: desc_notes.clone(),
                    });
                }
                FileKind::MultiLayer {
                    clean_raw,
                    file_meta,
                    groups,
                    desc_notes,
                    ..
                } => {
                    // Group matching <g> layers on this slide by z_index
                    let mut by_z: BTreeMap<i32, Vec<usize>> = BTreeMap::new();
                    for (g_idx, g) in groups.iter().enumerate() {
                        if matches_slide(&g.meta.selector, slide_index) {
                            by_z.entry(g.meta.z_index).or_default().push(g_idx);
                        }
                    }

                    if by_z.is_empty() {
                        continue;
                    }

                    let single_slot = by_z.len() == 1;
                    for (slot_idx, (z_idx, g_indices)) in by_z.into_iter().enumerate() {
                        let active_set: HashSet<usize> = g_indices.iter().copied().collect();
                        let intact = rewrite_intact_svg_for_slot(clean_raw, groups, &active_set);
                        let first_meta = &groups[g_indices[0]].meta;
                        let prefix = if single_slot {
                            format!("f{}_", entry.file_idx)
                        } else {
                            format!("f{}_s{}_b{}_", entry.file_idx, slide_index, slot_idx)
                        };
                        let empty_sizing = SizingSpec::default();
                        let root_sizing = file_meta
                            .as_ref()
                            .map(|fm| &fm.sizing)
                            .unwrap_or(&empty_sizing);
                        let svg_template = sanitize_and_namespace_svg(
                            &intact,
                            &prefix,
                            first_meta.band,
                            root_sizing,
                        );

                        let mut slot_meta = file_meta.clone().unwrap_or_else(|| first_meta.clone());
                        slot_meta.band = first_meta.band;
                        slot_meta.z_index = z_idx;
                        // Clear layer-level step/filter/lang if driven by sub_layers
                        if g_indices.len() > 1 {
                            slot_meta.step = 0;
                            slot_meta.group = None;
                            slot_meta.shortcuts.clear();
                            slot_meta.languages.clear();
                        } else {
                            slot_meta = first_meta.clone();
                        }

                        let sub_layers: Vec<SubLayerMeta> = g_indices
                            .iter()
                            .map(|&gi| {
                                let gm = &groups[gi].meta;
                                SubLayerMeta {
                                    layer_key: gm.layer_key.clone(),
                                    step: gm.step,
                                    group: gm.group.clone(),
                                    is_default: gm.is_default,
                                    languages: gm.languages.clone(),
                                    shortcuts: gm.shortcuts.clone(),
                                }
                            })
                            .collect();

                        let min_step = sub_layers.iter().map(|s| s.step).min().unwrap_or(0);
                        let mut slot_notes = if slot_idx == 0 && first_meta.band == LayerBand::Normal
                        {
                            desc_notes.clone()
                        } else {
                            Vec::new()
                        };
                        for &gi in &g_indices {
                            for note in &groups[gi].desc_notes {
                                if !slot_notes.contains(note) {
                                    slot_notes.push(note.clone());
                                }
                            }
                        }

                        candidates.push(SlotCandidate {
                            z_index: z_idx,
                            min_step,
                            file_order,
                            meta: slot_meta,
                            sub_layers,
                            svg_template,
                            desc_notes: slot_notes,
                        });
                    }
                }
            }
        }

        candidates.sort_by(|a, b| {
            a.z_index
                .cmp(&b.z_index)
                .then_with(|| a.min_step.cmp(&b.min_step))
                .then_with(|| a.file_order.cmp(&b.file_order))
        });

        let primary_normal = candidates
            .iter()
            .find(|c| c.meta.band == LayerBand::Normal);

        let slide_title = primary_normal
            .map(|c| c.meta.title.clone())
            .or_else(|| candidates.first().map(|c| c.meta.title.clone()))
            .unwrap_or_else(|| format!("Slide {slide_index}"));

        let transition = primary_normal
            .map(|c| c.meta.transition)
            .or_else(|| candidates.first().map(|c| c.meta.transition))
            .unwrap_or(TransitionType::Fade);

        let progress = if total_slides > 0 {
            ((slide_index * 100) + (total_slides / 2)) / total_slides
        } else {
            0
        };

        let mut max_step = 0;
        let mut composed_layers = Vec::with_capacity(candidates.len());
        let mut note_parts: Vec<String> = Vec::new();

        for (layer_order, c) in candidates.into_iter().enumerate() {
            max_step = max_step.max(c.meta.step);
            for sl in &c.sub_layers {
                max_step = max_step.max(sl.step);
            }

            let resolved = resolve_placeholders(
                &c.svg_template,
                slide_index,
                total_slides,
                &slide_title,
                progress,
                build_date,
            );

            for desc in &c.desc_notes {
                if !note_parts.contains(desc) {
                    note_parts.push(desc.clone());
                }
            }

            composed_layers.push(ComposedLayer {
                id: format!("s{slide_index}_l{layer_order}_root"),
                meta: c.meta,
                sub_layers: c.sub_layers,
                svg_markup: resolved,
                order: layer_order,
            });
        }

        for (sc_meta, sc_content) in &parsed_sidecars {
            if !sc_content.is_empty() && matches_slide(&sc_meta.selector, slide_index) {
                note_parts.insert(0, (*sc_content).to_string());
            }
        }

        slides.push(ComposedSlide {
            index: slide_index,
            title: slide_title,
            transition,
            max_step,
            layers: composed_layers,
            notes: note_parts.join("\n\n"),
        });
    }

    DeckData {
        total_slides,
        slides,
        languages,
        groups,
        toggles,
        build_date: build_date.to_string(),
    }
}
