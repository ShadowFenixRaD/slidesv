mod cli;
mod codegen;
mod discovery;
mod parser;
mod sanitizer;

use crate::cli::{CliArgs, parse_cli};
use crate::codegen::{
    PlayerConfig, build_embedded_font_css, export_deck_to_pdf, render_presentation_html,
};
use crate::discovery::discover_inputs;
use crate::sanitizer::compose_deck;
use notify::{EventKind, RecursiveMode, Watcher};
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn current_iso_date() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Civil date from Unix days (Howard Hinnant's algorithm)
    let z = secs.div_euclid(86_400) + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    format!("{year:04}-{m:02}-{d:02}")
}

fn compile_once(args: &CliArgs) -> Result<Vec<PathBuf>, String> {
    let discovered = discover_inputs(&args.inputs)?;
    let date = current_iso_date();
    let deck = compose_deck(&discovered.svg_files, &discovered.sidecar_files, &date);

    let (font_css, embedded_fonts) = if args.embed_fonts {
        build_embedded_font_css(&discovered.font_search_dirs, &discovered.svg_files)
    } else {
        (String::new(), 0)
    };

    let config = PlayerConfig {
        lang: args.lang.clone(),
        filters: args.filters.clone(),
    };

    let html = render_presentation_html(&deck, &font_css, &config)?;

    if let Some(parent) = args.output.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory {}: {e}", parent.display()))?;
    }

    fs::write(&args.output, &html)
        .map_err(|e| format!("Failed to write {}: {e}", args.output.display()))?;

    println!(
        "[build] {} ({} slides, {} langs, {} fonts embedded, {} KB)",
        args.output.display(),
        deck.total_slides,
        deck.languages.len(),
        embedded_fonts,
        (html.len() + 512) / 1024
    );

    if args.pdf {
        let pdf_path = args.output.with_extension("pdf");
        export_deck_to_pdf(&deck, &font_css, &pdf_path, &config)?;
        println!("[pdf] Exported {}", pdf_path.display());
    }

    let mut watch_paths = discovered.watch_paths;
    for font_dir in discovered.font_search_dirs {
        if !watch_paths.contains(&font_dir) {
            watch_paths.push(font_dir);
        }
    }
    if std::path::Path::new("./fonts").is_dir() {
        let local_fonts = PathBuf::from("./fonts");
        if !watch_paths.contains(&local_fonts) {
            watch_paths.push(local_fonts);
        }
    }

    Ok(watch_paths)
}

fn main() {
    let args = parse_cli();

    let watch_paths = match compile_once(&args) {
        Ok(paths) => paths,
        Err(err) => {
            eprintln!("Error: {err}");
            std::process::exit(1);
        }
    };

    if !args.watch {
        return;
    }

    println!("[watch] Watching {} input path(s) for changes...", watch_paths.len());
    let (tx, rx) = mpsc::channel();
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(err) => {
            eprintln!("Failed to initialize file watcher: {err}");
            std::process::exit(1);
        }
    };

    for path in &watch_paths {
        let mode = if path.is_dir() {
            RecursiveMode::NonRecursive
        } else {
            RecursiveMode::NonRecursive
        };
        if let Err(err) = watcher.watch(path, mode) {
            eprintln!("Warning: could not watch {}: {err}", path.display());
        }
    }

    loop {
        match rx.recv() {
            Ok(Ok(event)) => {
                let relevant = matches!(
                    event.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) && event.paths.iter().any(|p| {
                    p.extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| {
                            matches!(
                                e.to_ascii_lowercase().as_str(),
                                "svg" | "md" | "txt" | "woff2" | "woff" | "ttf" | "otf"
                            )
                        })
                });

                if !relevant {
                    continue;
                }

                // Debounce rapid editor writes
                std::thread::sleep(Duration::from_millis(120));
                while rx.try_recv().is_ok() {}

                if let Err(err) = compile_once(&args) {
                    eprintln!("[watch] Build error: {err}");
                }
            }
            Ok(Err(err)) => {
                eprintln!("[watch] Watcher error: {err}");
            }
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::InputSource;
    use crate::discovery::{DiscoveredInput, natural_cmp};
    use crate::parser::{
        LayerBand, TransitionType, matches_slide, parse_layer_label, parse_tier1_filename,
    };
    use crate::sanitizer::{
        annotate_active_g, force_g_hidden, sanitize_and_namespace_svg, strip_g_visibility,
    };
    use std::cmp::Ordering;

    #[test]
    fn test_tier1_filename_grammar() {
        let s1 = parse_tier1_filename("1-intro.svg").unwrap();
        assert_eq!(s1.title, "intro");
        assert!(matches_slide(&s1.selector, 1));
        assert!(!matches_slide(&s1.selector, 2));

        let range = parse_tier1_filename("1_5,!3-chapter_one.svg").unwrap();
        assert_eq!(range.title, "chapter one");
        assert!(matches_slide(&range.selector, 1));
        assert!(!matches_slide(&range.selector, 3));
        assert!(matches_slide(&range.selector, 5));

        let neg = parse_tier1_filename("!1,!10-footer-overlay_2.svg").unwrap();
        assert_eq!(neg.band, LayerBand::Overlay);
        assert_eq!(neg.z_index, 1002);
        assert!(!matches_slide(&neg.selector, 1));
        assert!(matches_slide(&neg.selector, 2));
        assert!(!matches_slide(&neg.selector, 10));

        let multi = parse_tier1_filename(
            "2_4-system_architecture-overlay_3-step_2-t_zoom-g_theme-default-lang_it_en-s_ctrl_win_z-s_alt_k.svg",
        )
        .unwrap();
        assert_eq!(multi.step, 2);
        assert_eq!(multi.transition, TransitionType::Zoom);
        assert_eq!(multi.group.as_deref(), Some("theme"));
        assert!(multi.is_default);
        assert_eq!(multi.languages, vec!["it", "en"]);
        assert_eq!(multi.shortcuts.len(), 2);
        assert_eq!(multi.shortcuts[0].signature, "ctrl+meta+z");
        assert_eq!(multi.shortcuts[1].signature, "alt+k");

        // Unstructured filenames do not match Tier 1
        assert!(parse_tier1_filename("deck.svg").is_none());
        assert!(parse_tier1_filename("chart.svg").is_none());
    }

    #[test]
    fn test_tier2_layer_labels() {
        let g1 = parse_layer_label("slide_1", "deck.svg#slide_1").unwrap();
        assert!(matches_slide(&g1.selector, 1));
        assert!(!matches_slide(&g1.selector, 2));

        let g2 = parse_layer_label("slide_2-step_1", "deck.svg#slide_2-step_1").unwrap();
        assert!(matches_slide(&g2.selector, 2));
        assert_eq!(g2.step, 1);

        let g3 = parse_layer_label("2_4-bg-underlay", "deck.svg#2_4-bg-underlay").unwrap();
        assert_eq!(g3.band, LayerBand::Underlay);
        assert!(matches_slide(&g3.selector, 3));

        let g4 = parse_layer_label("-s_ctrl_z", "deck.svg#-s_ctrl_z").unwrap();
        assert_eq!(g4.shortcuts.len(), 1);
        assert_eq!(g4.shortcuts[0].signature, "ctrl+z");

        assert!(parse_layer_label("Layer 1", "deck.svg#Layer 1").is_none());
    }

    #[test]
    fn test_visibility_reset_and_svg_sanitization() {
        let g = r#"<g id="l1" display="none" visibility="hidden" opacity="0" style="display: none; fill: #fff; opacity: 0.0; visibility: hidden"><rect /></g>"#;
        let stripped = strip_g_visibility(g);
        assert!(!stripped.contains("display"));
        assert!(!stripped.contains("visibility"));
        assert!(!stripped.contains("opacity"));
        assert!(stripped.contains("fill: #fff"));

        let raw = r##"<?xml version="1.0"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" style="background: #fff">
  <defs><linearGradient id="g1"/></defs>
  <rect fill="url(#g1)">
    <animate id="a1" attributeName="opacity" from="0" to="1" dur="1s" begin="0s" />
    <animate attributeName="x" from="0" to="10" dur="1s" begin="a1.end+0.2s" />
  </rect>
  <use href="#g1" />
  <switch><text systemLanguage="it">Ciao</text></switch>
</svg>"##;

        let clean = sanitize_and_namespace_svg(raw, "f0_", LayerBand::Overlay);
        assert!(!clean.contains("<?xml"));
        assert!(!clean.contains("<!DOCTYPE"));
        assert!(clean.contains("viewBox=\"0 0 1280 720\""));
        assert!(clean.contains("background: transparent"));
        assert!(clean.contains("id=\"f0_g1\""));
        assert!(clean.contains("url(#f0_g1)"));
        assert!(clean.contains("href=\"#f0_g1\""));
        assert!(clean.contains("begin=\"f0_a1.end+0.2s\""));
        assert!(clean.contains("data-slidesv-switch=\"1\""));
        assert!(clean.contains("data-system-language=\"it\""));
        assert!(!clean.contains("<switch"));
    }

    #[test]
    fn test_three_tier_unified_composition() {
        let tier2_master = DiscoveredInput {
            path: PathBuf::from("master.svg"),
            filename: "master.svg".to_string(),
            content: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
              <defs><linearGradient id="mgrad"><stop offset="0%"/></linearGradient></defs>
              <style>.title { fill: #fff; }</style>
              <g id="viewport" transform="translate(10, 20)">
                <g inkscape:label="bg-underlay" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"><rect fill="url(#mgrad)"/></g>
                <g inkscape:label="slide_1" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" style="display:none"><rect fill="url(#mgrad)"/></g>
                <g inkscape:label="slide_1-step_1" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" opacity="0"><text class="title">Step</text></g>
              </g>
            </svg>"#
                .to_string(),
        };

        let tier3_standalone = DiscoveredInput {
            path: PathBuf::from("chart.svg"),
            filename: "chart.svg".to_string(),
            content: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><desc>Chart note</desc><circle cx="50" cy="50" r="20"/></svg>"#
                .to_string(),
        };

        let tier1_overlay = DiscoveredInput {
            path: PathBuf::from("global-overlay_1.svg"),
            filename: "global-overlay_1.svg".to_string(),
            content: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><text>{{INDEX}}/{{TOTAL}} - {{TITLE}}</text></svg>"#
                .to_string(),
        };

        let deck = compose_deck(
            &[tier2_master, tier3_standalone, tier1_overlay],
            &[],
            "2026-11-16",
        );

        assert_eq!(deck.total_slides, 2);
        assert_eq!(deck.slides[0].max_step, 1);
        assert_eq!(deck.slides[1].title, "chart");
        assert_eq!(deck.slides[1].notes, "Chart note");

        // Slide 1 has: master underlay clone, master normal clone, and global overlay
        assert_eq!(deck.slides[0].layers.len(), 3);
        let normal_svg = &deck.slides[0].layers[1].svg_markup;
        // Preserves <defs>, <style>, and parent <g transform="translate(10, 20)">
        assert!(normal_svg.contains("<defs>"));
        assert!(normal_svg.contains("<style>"));
        assert!(normal_svg.contains("transform=\"translate(10, 20)\""));
        // Active <g>s are annotated with data-* and editor visibility was stripped
        assert!(normal_svg.contains("data-step=\"1\""));
        assert!(!normal_svg.contains("opacity=\"0\""));
        // Different band clones use distinct ID prefixes to avoid <defs> collisions
        assert_ne!(
            deck.slides[0].layers[0].svg_markup.contains("f0_s1_b0_mgrad"),
            deck.slides[0].layers[1].svg_markup.contains("f0_s1_b0_mgrad"),
        );

        // Ensure global overlay resolved placeholders on slide 2
        assert!(
            deck.slides[1]
                .layers
                .last()
                .unwrap()
                .svg_markup
                .contains("2/2 - chart")
        );
    }

    #[test]
    fn test_natural_sort_and_demo_deck_mixed_inputs() {
        assert_eq!(natural_cmp("2-a.svg", "10-a.svg"), Ordering::Less);

        let discovered = discover_inputs(&[
            InputSource::File(PathBuf::from("demo-deck/1-welcome_deck-t_zoom.svg")),
            InputSource::Folder(PathBuf::from("demo-deck")),
        ])
        .unwrap();

        let deck = compose_deck(
            &discovered.svg_files,
            &discovered.sidecar_files,
            "2026-11-16",
        );
        assert_eq!(deck.total_slides, 3);
        assert!(deck.languages.contains(&"en".to_string()));
        assert!(deck.languages.contains(&"it".to_string()));

        let html = render_presentation_html(
            &deck,
            "",
            &PlayerConfig {
                lang: None,
                filters: vec![],
            },
        )
        .unwrap();
        assert!(html.contains("window.__SLIDESV_DECK__"));
        assert!(html.contains("homeParam === '1'"));
        assert!(html.contains("beginElement()"));

        // Verify canonical deduplication preserved first-seen order without duplicating welcome slide
        let slide1_welcome_count = discovered
            .svg_files
            .iter()
            .filter(|f| f.filename == "1-welcome_deck-t_zoom.svg")
            .count();
        assert_eq!(slide1_welcome_count, 1);
        assert_eq!(discovered.svg_files[0].filename, "1-welcome_deck-t_zoom.svg");
    }

    #[test]
    fn test_self_closing_g_scoped_desc_and_managed_ancestor() {
        let meta = parse_tier1_filename("1-test.svg").unwrap();
        let active = annotate_active_g(r#"<g id="empty" display="none"/>"#, &meta);
        assert!(active.ends_with("/>"));
        assert!(active.contains("data-step=\"0\""));
        assert!(!active.contains("display=\"none\""));

        let hidden = force_g_hidden(r#"<g id="empty"/>"#);
        assert!(hidden.ends_with("/>"));
        assert!(hidden.contains("style=\"display: none\""));

        // MultiLayer with scoped <desc> and a managed ancestor <g> enclosing a managed child <g>
        let nested_master = DiscoveredInput {
            path: PathBuf::from("nested.svg"),
            filename: "nested.svg".to_string(),
            content: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
              <desc>Root global note</desc>
              <g id="1_2-wrapper" transform="translate(5,5)">
                <g id="1-slide1_box">
                  <desc>Slide 1 only note</desc>
                  <rect width="100" height="100"/>
                </g>
                <g id="2-slide2_box">
                  <desc>Slide 2 only note</desc>
                  <rect width="100" height="100"/>
                </g>
              </g>
            </svg>"#
                .to_string(),
        };

        let deck = compose_deck(&[nested_master], &[], "2026-11-16");
        assert_eq!(deck.total_slides, 2);
        assert!(deck.slides[0].notes.contains("Root global note"));
        assert!(deck.slides[0].notes.contains("Slide 1 only note"));
        assert!(!deck.slides[0].notes.contains("Slide 2 only note"));

        assert!(deck.slides[1].notes.contains("Root global note"));
        assert!(deck.slides[1].notes.contains("Slide 2 only note"));
        assert!(!deck.slides[1].notes.contains("Slide 1 only note"));

        // Managed ancestor <g id="1_2-wrapper"> must NOT get display: none on slide 1 or 2
        let s1_svg = &deck.slides[0].layers[0].svg_markup;
        assert!(s1_svg.contains("id=\"f0_1_2-wrapper\""));
        assert!(!s1_svg.contains("id=\"f0_1_2-wrapper\" transform=\"translate(5,5)\" style=\"display: none\""));
    }
}
