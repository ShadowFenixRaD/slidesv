use crate::discovery::DiscoveredInput;
use crate::sanitizer::{ComposedLayer, DeckData};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const PLAYER_HTML: &str = include_str!("../assets/player.html");
const PLAYER_CSS: &str = include_str!("../assets/player.css");
const PLAYER_JS: &str = include_str!("../assets/player.js");

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<String>,
}

fn is_generic_family(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "sans-serif"
            | "serif"
            | "monospace"
            | "cursive"
            | "fantasy"
            | "system-ui"
            | "ui-sans-serif"
            | "ui-serif"
            | "ui-monospace"
            | "inherit"
            | "initial"
            | "unset"
    )
}

pub fn extract_font_families(svg_files: &[DiscoveredInput]) -> Vec<String> {
    static ATTR_RE: OnceLock<Regex> = OnceLock::new();
    static CSS_RE: OnceLock<Regex> = OnceLock::new();

    let attr_re =
        ATTR_RE.get_or_init(|| Regex::new(r#"(?i)\bfont-family\s*=\s*(?:"([^"]+)"|'([^']+)')"#).unwrap());
    let css_re = CSS_RE.get_or_init(|| Regex::new(r"(?i)\bfont-family\s*:\s*([^;}\n]+)").unwrap());

    let mut families = Vec::new();
    let mut seen = HashSet::new();

    for file in svg_files {
        for caps in attr_re.captures_iter(&file.content) {
            let raw = caps.get(1).or_else(|| caps.get(2)).map(|m| m.as_str()).unwrap_or("");
            for part in raw.split(',') {
                let clean = part.trim().trim_matches(|c| c == '\'' || c == '"');
                if !clean.is_empty() && !is_generic_family(clean) && seen.insert(clean.to_string()) {
                    families.push(clean.to_string());
                }
            }
        }
        for caps in css_re.captures_iter(&file.content) {
            let raw = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            for part in raw.split(',') {
                let clean = part.trim().trim_matches(|c| c == '\'' || c == '"');
                if !clean.is_empty() && !is_generic_family(clean) && seen.insert(clean.to_string()) {
                    families.push(clean.to_string());
                }
            }
        }
    }

    families
}

fn normalize_font_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn font_ext_info(path: &Path) -> Option<(u8, &'static str, &'static str)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "woff2" => Some((0, "font/woff2", "woff2")),
        "woff" => Some((1, "font/woff", "woff")),
        "ttf" => Some((2, "font/ttf", "truetype")),
        "otf" => Some((3, "font/otf", "opentype")),
        _ => None,
    }
}

fn walk_font_dir(dir: &Path, out: &mut Vec<PathBuf>) {
    if !dir.is_dir() {
        return;
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk_font_dir(&path, out);
            } else if path.is_file() && font_ext_info(&path).is_some() {
                out.push(path);
            }
        }
    }
}

pub fn build_embedded_font_css(
    extra_dirs: &[PathBuf],
    svg_files: &[DiscoveredInput],
) -> (String, usize) {
    let families = extract_font_families(svg_files);
    if families.is_empty() {
        return (String::new(), 0);
    }

    let mut search_dirs: Vec<PathBuf> = extra_dirs.to_vec();
    search_dirs.push(PathBuf::from("./fonts"));
    search_dirs.push(PathBuf::from("/usr/share/fonts"));
    search_dirs.push(PathBuf::from("/usr/local/share/fonts"));
    search_dirs.push(PathBuf::from("/Library/Fonts"));
    if let Ok(home) = env::var("HOME") {
        let h = PathBuf::from(home);
        search_dirs.push(h.join(".local/share/fonts"));
        search_dirs.push(h.join(".fonts"));
        search_dirs.push(h.join("Library/Fonts"));
    }

    let mut available_files = Vec::new();
    for dir in &search_dirs {
        walk_font_dir(dir, &mut available_files);
    }

    if available_files.is_empty() {
        return (String::new(), 0);
    }

    let mut rules = Vec::new();
    let mut embedded_count = 0;

    for family in families {
        let target_norm = normalize_font_name(&family);
        if target_norm.is_empty() {
            continue;
        }

        let mut candidates: Vec<&PathBuf> = available_files
            .iter()
            .filter(|p| {
                let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                let norm = normalize_font_name(stem);
                norm == target_norm || norm.starts_with(&target_norm)
            })
            .collect();

        if candidates.is_empty() {
            continue;
        }

        candidates.sort_by_key(|p| font_ext_info(p).map(|(prio, _, _)| prio).unwrap_or(9));

        let chosen = candidates[0];
        if let Some((_, mime, format)) = font_ext_info(chosen)
            && let Ok(bytes) = fs::read(chosen)
        {
            const WARN_THRESHOLD: usize = 500 * 1024;
            if bytes.len() > WARN_THRESHOLD {
                eprintln!(
                    "[warn] Embedded font '{}' ({} KB) exceeds 500 KB; consider using a .woff2 or subsetted font.",
                    chosen.display(),
                    bytes.len() / 1024
                );
            }
            let b64 = BASE64.encode(&bytes);
            let escaped_family = family.replace('"', "\\\"");
            rules.push(format!(
                "@font-face {{\n  font-family: \"{escaped_family}\";\n  src: url(\"data:{mime};base64,{b64}\") format(\"{format}\");\n  font-display: swap;\n}}"
            ));
            embedded_count += 1;
        }
    }

    (rules.join("\n"), embedded_count)
}

fn escape_json_for_script(json: &str) -> String {
    json.replace("</script", "<\\/script")
        .replace("</SCRIPT", "<\\/SCRIPT")
}

pub fn render_presentation_html(
    deck: &DeckData,
    font_css: &str,
    config: &PlayerConfig,
) -> Result<String, String> {
    let deck_json = serde_json::to_string(deck)
        .map_err(|e| format!("Failed to serialize deck JSON: {e}"))?;
    let cfg_json = serde_json::to_string(config)
        .map_err(|e| format!("Failed to serialize config JSON: {e}"))?;

    let style = if font_css.is_empty() {
        PLAYER_CSS.to_string()
    } else {
        format!("{font_css}\n{PLAYER_CSS}")
    };

    let title = format!("svg-deck — {} Slides", deck.total_slides);

    let html = PLAYER_HTML
        .replace("{{TITLE}}", &title)
        .replace("{{STYLE}}", &style)
        .replace("{{DECK_JSON}}", &escape_json_for_script(&deck_json))
        .replace("{{CONFIG_JSON}}", &escape_json_for_script(&cfg_json))
        .replace("{{SCRIPT}}", PLAYER_JS);

    Ok(html)
}

fn find_headless_browser() -> Option<PathBuf> {
    if let Ok(custom) = env::var("CHROME_PATH")
        && !custom.trim().is_empty()
    {
        let p = PathBuf::from(custom.trim());
        if p.exists() {
            return Some(p);
        }
    }

    let candidates = [
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "brave-browser",
        "brave",
        "microsoft-edge",
        "msedge",
    ];

    for bin in candidates {
        if let Ok(out) = Command::new("which").arg(bin).output()
            && out.status.success()
        {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if let Some(first_line) = stdout.lines().next() {
                let trimmed = first_line.trim();
                if !trimmed.is_empty() {
                    return Some(PathBuf::from(trimmed));
                }
            }
        }
    }

    None
}

fn is_layer_active_for_pdf(
    layer: &ComposedLayer,
    step: usize,
    lang: &str,
    filter_set: &HashSet<String>,
    group_choices: &HashMap<String, String>,
) -> bool {
    let meta = &layer.meta;
    if meta.step > step {
        return false;
    }
    if !meta.languages.is_empty() && !lang.is_empty() && !meta.languages.iter().any(|l| l == lang)
    {
        return false;
    }
    if let Some(ref g) = meta.group {
        return group_choices.get(g) == Some(&meta.layer_key);
    }
    if !meta.shortcuts.is_empty() {
        return filter_set.contains(&meta.layer_key.to_ascii_lowercase())
            || filter_set.contains(&meta.title.to_ascii_lowercase())
            || meta.is_default;
    }
    true
}

fn apply_switch_language_static(svg_markup: &str, lang: &str) -> String {
    if lang.is_empty() {
        return svg_markup.to_string();
    }
    let Ok(doc) = roxmltree::Document::parse(svg_markup) else {
        return svg_markup.to_string();
    };
    let target_base = lang.split('-').next().unwrap_or(lang);
    let mut hide_ranges: Vec<(usize, usize)> = Vec::new();

    for node in doc.descendants() {
        if node.is_element()
            && node.has_tag_name("g")
            && node.attribute("data-slidesv-switch") == Some("1")
        {
            let children: Vec<_> = node.children().filter(|c| c.is_element()).collect();
            if children.is_empty() {
                continue;
            }
            let mut matched = None;
            let mut fallback = None;
            for (idx, child) in children.iter().enumerate() {
                if let Some(attr_val) = child.attribute("data-system-language") {
                    let is_match = attr_val.split(',').any(|part| {
                        let code = part.trim().to_ascii_lowercase();
                        code == lang || code.split('-').next().unwrap_or("") == target_base
                    });
                    if is_match && matched.is_none() {
                        matched = Some(idx);
                    }
                } else if fallback.is_none() {
                    fallback = Some(idx);
                }
            }
            let winner = matched.or(fallback);
            for (idx, child) in children.iter().enumerate() {
                if Some(idx) != winner {
                    let r = child.range();
                    hide_ranges.push((r.start, r.end));
                }
            }
        }
    }

    if hide_ranges.is_empty() {
        return svg_markup.to_string();
    }
    hide_ranges.sort_by_key(|(s, _)| *s);
    let mut out = String::with_capacity(svg_markup.len());
    let mut pos = 0;
    for (start, end) in hide_ranges {
        if start >= pos && end <= svg_markup.len() {
            out.push_str(&svg_markup[pos..start]);
            pos = end;
        }
    }
    out.push_str(&svg_markup[pos..]);
    out
}

fn apply_managed_g_visibility_static(
    svg_markup: &str,
    step: usize,
    lang: &str,
    filter_set: &HashSet<String>,
    group_choices: &HashMap<String, String>,
) -> String {
    static G_OPEN_RE: OnceLock<Regex> = OnceLock::new();
    static STEP_RE: OnceLock<Regex> = OnceLock::new();
    static LANG_RE: OnceLock<Regex> = OnceLock::new();
    static FILTER_RE: OnceLock<Regex> = OnceLock::new();
    static GROUP_RE: OnceLock<Regex> = OnceLock::new();
    static DEFAULT_RE: OnceLock<Regex> = OnceLock::new();

    let g_open_re = G_OPEN_RE.get_or_init(|| Regex::new(r"(?is)<g\b([^>]*)>").unwrap());
    let step_re = STEP_RE.get_or_init(|| Regex::new(r#"\bdata-step="(\d+)""#).unwrap());
    let lang_re = LANG_RE.get_or_init(|| Regex::new(r#"\bdata-lang="([^"]*)""#).unwrap());
    let filter_re = FILTER_RE.get_or_init(|| Regex::new(r#"\bdata-filter="([^"]*)""#).unwrap());
    let group_re = GROUP_RE.get_or_init(|| Regex::new(r#"\bdata-group="([^"]*)""#).unwrap());
    let default_re = DEFAULT_RE.get_or_init(|| Regex::new(r#"\bdata-default="1""#).unwrap());

    g_open_re
        .replace_all(svg_markup, |caps: &regex::Captures| {
            let attrs = &caps[1];
            let has_managed = step_re.is_match(attrs)
                || lang_re.is_match(attrs)
                || filter_re.is_match(attrs)
                || group_re.is_match(attrs);
            if !has_managed {
                return caps[0].to_string();
            }

            let mut visible = true;
            if let Some(sc) = step_re.captures(attrs)
                && let Ok(g_step) = sc[1].parse::<usize>()
                && g_step > step
            {
                visible = false;
            }
            if visible && let Some(lc) = lang_re.captures(attrs) && !lang.is_empty() {
                let langs: Vec<&str> = lc[1].split(',').map(str::trim).collect();
                if !langs.iter().any(|l| l.eq_ignore_ascii_case(lang)) {
                    visible = false;
                }
            }
            if visible && let Some(gc) = group_re.captures(attrs) {
                let gname = &gc[1];
                let fkey = filter_re.captures(attrs).map(|c| c[1].to_string()).unwrap_or_default();
                if group_choices.get(gname).map(String::as_str) != Some(fkey.as_str()) {
                    visible = false;
                }
            } else if visible && let Some(fc) = filter_re.captures(attrs) {
                let fkey = fc[1].to_ascii_lowercase();
                if !filter_set.contains(&fkey) && !default_re.is_match(attrs) {
                    visible = false;
                }
            }

            if visible {
                caps[0].to_string()
            } else {
                format!("<g{attrs} style=\"display: none\">")
            }
        })
        .into_owned()
}

pub fn export_deck_to_pdf(
    deck: &DeckData,
    font_css: &str,
    pdf_output_path: &Path,
    config: &PlayerConfig,
) -> Result<(), String> {
    let browser = find_headless_browser().ok_or_else(|| {
        "No headless Chromium/Chrome/Brave/Edge binary found in PATH (or CHROME_PATH).".to_string()
    })?;

    let lang = config
        .lang
        .as_deref()
        .or_else(|| deck.languages.first().map(String::as_str))
        .unwrap_or("")
        .to_ascii_lowercase();

    let filter_set: HashSet<String> = config
        .filters
        .iter()
        .map(|f| f.trim().to_ascii_lowercase())
        .filter(|f| !f.is_empty())
        .collect();

    let mut group_choices = HashMap::new();
    for g in &deck.groups {
        let matched = g.options.iter().find(|o| {
            filter_set.contains(&o.layer_key.to_ascii_lowercase())
                || filter_set.contains(&o.title.to_ascii_lowercase())
        });
        let chosen = matched
            .or_else(|| g.options.iter().find(|o| o.is_default))
            .or_else(|| g.options.first());
        if let Some(opt) = chosen {
            group_choices.insert(g.name.clone(), opt.layer_key.clone());
        }
    }

    let mut pages_html = Vec::new();
    for slide in &deck.slides {
        for step in 0..=slide.max_step {
            let layers_html: Vec<String> = slide
                .layers
                .iter()
                .filter(|l| is_layer_active_for_pdf(l, step, &lang, &filter_set, &group_choices))
                .map(|l| {
                    let with_lang = apply_switch_language_static(&l.svg_markup, &lang);
                    let with_g = apply_managed_g_visibility_static(
                        &with_lang,
                        step,
                        &lang,
                        &filter_set,
                        &group_choices,
                    );
                    format!("<div class=\"pdf-layer\">{with_g}</div>")
                })
                .collect();
            pages_html.push(format!("<div class=\"pdf-page\">{}</div>", layers_html.join("\n")));
        }
    }

    let print_html = format!(
        r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    {font_css}
    @page {{ size: 1280px 720px; margin: 0; }}
    * {{ box-sizing: border-box; }}
    html, body {{ margin: 0; padding: 0; background: #000; }}
    .pdf-page {{
      width: 1280px;
      height: 720px;
      display: grid;
      place-items: center;
      page-break-after: always;
      break-after: page;
      overflow: hidden;
      background: #000;
    }}
    .pdf-page:last-child {{
      page-break-after: auto;
      break-after: auto;
    }}
    .pdf-layer {{
      grid-area: 1 / 1;
      width: 1280px;
      height: 720px;
      display: flex;
      align-items: center;
      justify-content: center;
    }}
    .pdf-layer > svg {{
      width: 100%;
      height: 100%;
      display: block;
    }}
  </style>
</head>
<body>
  {}
</body>
</html>"#,
        pages_html.join("\n")
    );

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_dir = env::temp_dir().join(format!("svg-deck-pdf-{ts}"));
    fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create temp dir {}: {e}", tmp_dir.display()))?;
    let tmp_html = tmp_dir.join("print.html");
    fs::write(&tmp_html, print_html)
        .map_err(|e| format!("Failed to write temp HTML: {e}"))?;

    if let Some(parent) = pdf_output_path.parent()
        && !parent.as_os_str().is_empty()
    {
        let _ = fs::create_dir_all(parent);
    }
    let abs_pdf = env::current_dir()
        .map(|cwd| cwd.join(pdf_output_path))
        .unwrap_or_else(|_| pdf_output_path.to_path_buf());

    let status = Command::new(&browser)
        .args([
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            &format!("--print-to-pdf={}", abs_pdf.display()),
            "--print-to-pdf-no-header",
            &format!("file://{}", tmp_html.display()),
        ])
        .status();

    let _ = fs::remove_dir_all(&tmp_dir);

    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("Headless browser exited with status {s}")),
        Err(e) => Err(format!("Failed to launch {}: {e}", browser.display())),
    }
}
