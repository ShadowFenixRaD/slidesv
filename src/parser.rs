use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LayerBand {
    Underlay,
    Normal,
    Overlay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitionType {
    Fade,
    Slide,
    Zoom,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SelectorRange {
    pub start: usize,
    pub end: usize,
    pub negate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSelector {
    pub raw: String,
    pub ranges: Vec<SelectorRange>,
    pub has_positive: bool,
    pub is_global: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ParsedShortcut {
    pub raw: String,
    pub modifiers: Vec<String>,
    pub key: String,
    pub display: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerMeta {
    pub filename: String,
    pub layer_key: String,
    pub selector: ParsedSelector,
    pub title: String,
    pub raw_title: String,
    pub band: LayerBand,
    pub z_index: i32,
    pub step: usize,
    pub transition: TransitionType,
    pub group: Option<String>,
    pub is_default: bool,
    pub languages: Vec<String>,
    pub shortcuts: Vec<ParsedShortcut>,
}

#[derive(Debug, Clone)]
pub struct SidecarMeta {
    pub selector: ParsedSelector,
}

fn selector_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^!?(\d+(_\d+)?)(,!?(\d+(_\d+)?))*$").unwrap())
}

pub fn is_valid_selector(token: &str) -> bool {
    selector_regex().is_match(token)
}

pub fn parse_selector(token: &str) -> ParsedSelector {
    let mut ranges = Vec::new();
    let mut has_positive = false;

    for raw_part in token.split(',') {
        let negate = raw_part.starts_with('!');
        let clean = if negate { &raw_part[1..] } else { raw_part };
        let mut split = clean.split('_');
        let a: usize = split.next().and_then(|s| s.parse().ok()).unwrap_or(1);
        let b: usize = split.next().and_then(|s| s.parse().ok()).unwrap_or(a);
        let start = a.min(b);
        let end = a.max(b);
        if !negate {
            has_positive = true;
        }
        ranges.push(SelectorRange { start, end, negate });
    }

    ParsedSelector {
        raw: token.to_string(),
        ranges,
        has_positive,
        is_global: false,
    }
}

pub fn create_global_selector() -> ParsedSelector {
    ParsedSelector {
        raw: String::new(),
        ranges: Vec::new(),
        has_positive: false,
        is_global: true,
    }
}

pub fn create_single_slide_selector(slide: usize) -> ParsedSelector {
    ParsedSelector {
        raw: slide.to_string(),
        ranges: vec![SelectorRange {
            start: slide,
            end: slide,
            negate: false,
        }],
        has_positive: true,
        is_global: false,
    }
}

pub fn matches_slide(selector: &ParsedSelector, slide_number: usize) -> bool {
    if slide_number < 1 {
        return false;
    }
    if selector.is_global {
        return true;
    }

    let mut included = !selector.has_positive;
    if selector.has_positive {
        for r in &selector.ranges {
            if !r.negate && slide_number >= r.start && slide_number <= r.end {
                included = true;
                break;
            }
        }
    }

    if !included {
        return false;
    }

    for r in &selector.ranges {
        if r.negate && slide_number >= r.start && slide_number <= r.end {
            return false;
        }
    }

    true
}

pub fn max_positive_slide(selector: &ParsedSelector) -> usize {
    selector
        .ranges
        .iter()
        .filter(|r| !r.negate)
        .map(|r| r.end)
        .max()
        .unwrap_or(0)
}

fn normalize_modifier(m: &str) -> &str {
    match m {
        "ctrl" | "control" => "ctrl",
        "alt" | "option" => "alt",
        "shift" => "shift",
        "win" | "meta" | "cmd" | "super" => "meta",
        other => other,
    }
}

pub fn parse_shortcut_token(token: &str) -> Option<ParsedShortcut> {
    let rest = token.strip_prefix("s_")?;
    let parts: Vec<String> = rest
        .split('_')
        .map(|p| p.to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return None;
    }

    let key = parts.last()?.clone();
    let raw_mods = &parts[..parts.len() - 1];
    let mut modifiers = Vec::new();
    for m in raw_mods {
        let norm = normalize_modifier(m).to_string();
        if !modifiers.contains(&norm) {
            modifiers.push(norm);
        }
    }

    let mut final_mods = Vec::new();
    for ordered in ["ctrl", "alt", "shift", "meta"] {
        if modifiers.iter().any(|m| m == ordered) {
            final_mods.push(ordered.to_string());
        }
    }
    for m in &modifiers {
        if !final_mods.contains(m) {
            final_mods.push(m.clone());
        }
    }

    let mut disp_parts = raw_mods.to_vec();
    disp_parts.push(key.clone());
    let display = disp_parts.join("+");

    let mut sig_parts = final_mods.clone();
    sig_parts.push(key.clone());
    let signature = sig_parts.join("+");

    Some(ParsedShortcut {
        raw: token.to_string(),
        modifiers: final_mods,
        key,
        display,
        signature,
    })
}

fn is_option_token(tok: &str) -> bool {
    tok == "underlay"
        || tok.starts_with("underlay_")
        || tok == "overlay"
        || tok.starts_with("overlay_")
        || tok.starts_with("step_")
        || tok.starts_with("t_")
        || tok.starts_with("g_")
        || tok == "default"
        || tok.starts_with("lang_")
        || tok.starts_with("s_")
}

#[derive(Debug, Default)]
pub struct ParsedOptions {
    pub band: Option<(LayerBand, i32)>,
    pub step: Option<usize>,
    pub transition: Option<TransitionType>,
    pub group: Option<String>,
    pub is_default: bool,
    pub languages: Vec<String>,
    pub shortcuts: Vec<ParsedShortcut>,
    pub matched_any_option: bool,
}

pub fn parse_option_tokens(tokens: &[&str]) -> ParsedOptions {
    let mut opts = ParsedOptions::default();
    let mut i = 0;

    while i < tokens.len() {
        let tok = tokens[i];
        if tok.is_empty() {
            i += 1;
            continue;
        }

        if tok == "underlay" || tok.starts_with("underlay_") {
            let mut z: i32 = 0;
            if let Some(rest) = tok.strip_prefix("underlay_") {
                if let Ok(parsed) = rest.parse::<i32>() {
                    z = parsed;
                }
            } else if i + 1 < tokens.len() && tokens[i + 1].chars().all(|c| c.is_ascii_digit()) {
                if let Ok(parsed) = tokens[i + 1].parse::<i32>() {
                    z = parsed;
                    i += 1;
                }
            }
            opts.band = Some((LayerBand::Underlay, -1000 + z));
            opts.matched_any_option = true;
        } else if tok == "overlay" || tok.starts_with("overlay_") {
            let mut z: i32 = 0;
            if let Some(rest) = tok.strip_prefix("overlay_") {
                if let Ok(parsed) = rest.parse::<i32>() {
                    z = parsed;
                }
            } else if i + 1 < tokens.len() && tokens[i + 1].chars().all(|c| c.is_ascii_digit()) {
                if let Ok(parsed) = tokens[i + 1].parse::<i32>() {
                    z = parsed;
                    i += 1;
                }
            }
            opts.band = Some((LayerBand::Overlay, 1000 + z));
            opts.matched_any_option = true;
        } else if let Some(rest) = tok.strip_prefix("step_") {
            if let Ok(k) = rest.parse::<usize>() {
                opts.step = Some(k);
                opts.matched_any_option = true;
            }
        } else if let Some(rest) = tok.strip_prefix("t_") {
            let trans = match rest.to_ascii_lowercase().as_str() {
                "fade" => Some(TransitionType::Fade),
                "slide" => Some(TransitionType::Slide),
                "zoom" => Some(TransitionType::Zoom),
                "none" => Some(TransitionType::None),
                _ => None,
            };
            if let Some(t) = trans {
                opts.transition = Some(t);
                opts.matched_any_option = true;
            }
        } else if let Some(rest) = tok.strip_prefix("g_") {
            let g = rest.trim();
            if !g.is_empty() {
                opts.group = Some(g.to_string());
                opts.matched_any_option = true;
            }
        } else if tok == "default" {
            opts.is_default = true;
            opts.matched_any_option = true;
        } else if let Some(rest) = tok.strip_prefix("lang_") {
            for code in rest.split('_') {
                let c = code.trim().to_ascii_lowercase();
                if !c.is_empty() && !opts.languages.contains(&c) {
                    opts.languages.push(c);
                }
            }
            if !opts.languages.is_empty() {
                opts.matched_any_option = true;
            }
        } else if tok.starts_with("s_") {
            if let Some(sc) = parse_shortcut_token(tok) {
                opts.shortcuts.push(sc);
                opts.matched_any_option = true;
            }
        }

        i += 1;
    }

    opts
}

/// Tier 1: Parse an SVG filename. Returns `Some(LayerMeta)` only if the stem
/// matches the option grammar (has a `<selector>-` prefix or at least one option token).
pub fn parse_tier1_filename(filename: &str) -> Option<LayerMeta> {
    let lower = filename.to_ascii_lowercase();
    if !lower.ends_with(".svg") {
        return None;
    }
    let stem = &filename[..filename.len() - 4];
    if stem.is_empty() {
        return None;
    }

    let tokens: Vec<&str> = stem.split('-').collect();
    let (selector, has_selector, cursor) = if is_valid_selector(tokens[0]) {
        (parse_selector(tokens[0]), true, 1)
    } else {
        (create_global_selector(), false, 0)
    };

    let raw_title = tokens.get(cursor).copied().unwrap_or("untitled");
    let title = {
        let t = raw_title.replace('_', " ").trim().to_string();
        if t.is_empty() { "untitled".to_string() } else { t }
    };

    let opt_tokens = if cursor + 1 < tokens.len() {
        &tokens[cursor + 1..]
    } else {
        &[]
    };
    let opts = parse_option_tokens(opt_tokens);

    if !has_selector && !opts.matched_any_option {
        return None;
    }

    let (band, z_index) = opts.band.unwrap_or((LayerBand::Normal, 0));

    Some(LayerMeta {
        filename: filename.to_string(),
        layer_key: filename.to_string(),
        selector,
        title,
        raw_title: raw_title.to_string(),
        band,
        z_index,
        step: opts.step.unwrap_or(0),
        transition: opts.transition.unwrap_or(TransitionType::Fade),
        group: opts.group,
        is_default: opts.is_default,
        languages: opts.languages,
        shortcuts: opts.shortcuts,
    })
}

/// Tier 2 (and Tier 1 nested `<g>`): Parse an internal `<g>` label or id.
/// Supports `slide_1`, `slide_1_3`, `1-intro`, `2_4-bg-underlay`, `step_1`, `lang_it`, `-s_ctrl_z`, etc.
pub fn parse_layer_label(label: &str, layer_key: &str) -> Option<LayerMeta> {
    let trimmed = label.trim().trim_start_matches('-');
    if trimmed.is_empty() {
        return None;
    }

    let tokens: Vec<&str> = trimmed.split('-').filter(|t| !t.is_empty()).collect();
    if tokens.is_empty() {
        return None;
    }

    let first = tokens[0];
    let mut cursor = 0;
    let mut has_selector = false;
    let mut selector = create_global_selector();

    if let Some(after_slide) = first.strip_prefix("slide_")
        && is_valid_selector(after_slide)
    {
        selector = parse_selector(after_slide);
        has_selector = true;
        cursor = 1;
    } else if is_valid_selector(first) {
        selector = parse_selector(first);
        has_selector = true;
        cursor = 1;
    }

    // Check if the token at `cursor` is actually an option token (e.g. `step_1` or `lang_it`)
    let (raw_title, opt_start) = if cursor < tokens.len() && !is_option_token(tokens[cursor]) {
        (tokens[cursor], cursor + 1)
    } else {
        ("layer", cursor)
    };

    let opt_tokens = if opt_start < tokens.len() {
        &tokens[opt_start..]
    } else {
        &[]
    };
    let opts = parse_option_tokens(opt_tokens);

    if !has_selector && !opts.matched_any_option {
        return None;
    }

    let title = {
        let t = raw_title.replace('_', " ").trim().to_string();
        if t.is_empty() { "layer".to_string() } else { t }
    };
    let (band, z_index) = opts.band.unwrap_or((LayerBand::Normal, 0));

    Some(LayerMeta {
        filename: label.to_string(),
        layer_key: layer_key.to_string(),
        selector,
        title,
        raw_title: raw_title.to_string(),
        band,
        z_index,
        step: opts.step.unwrap_or(0),
        transition: opts.transition.unwrap_or(TransitionType::Fade),
        group: opts.group,
        is_default: opts.is_default,
        languages: opts.languages,
        shortcuts: opts.shortcuts,
    })
}

pub fn parse_sidecar_filename(filename: &str) -> Option<SidecarMeta> {
    let lower = filename.to_ascii_lowercase();
    let ext_len = if lower.ends_with(".md") {
        3
    } else if lower.ends_with(".txt") {
        4
    } else {
        return None;
    };

    let stem = &filename[..filename.len() - ext_len];
    if stem.is_empty() {
        return None;
    }

    let tokens: Vec<&str> = stem.split('-').collect();
    let selector = if is_valid_selector(tokens[0]) {
        parse_selector(tokens[0])
    } else {
        create_global_selector()
    };

    Some(SidecarMeta { selector })
}
