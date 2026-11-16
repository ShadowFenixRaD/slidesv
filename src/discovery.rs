use crate::cli::InputSource;
use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct DiscoveredInput {
    pub path: PathBuf,
    pub filename: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct DiscoveryResult {
    pub svg_files: Vec<DiscoveredInput>,
    pub sidecar_files: Vec<DiscoveredInput>,
    pub watch_paths: Vec<PathBuf>,
    pub font_search_dirs: Vec<PathBuf>,
}

pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ia = a.chars().peekable();
    let mut ib = b.chars().peekable();

    loop {
        match (ia.peek(), ib.peek()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(&ca), Some(&cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let mut na = String::new();
                    while let Some(&c) = ia.peek() {
                        if c.is_ascii_digit() {
                            na.push(c);
                            ia.next();
                        } else {
                            break;
                        }
                    }
                    let mut nb = String::new();
                    while let Some(&c) = ib.peek() {
                        if c.is_ascii_digit() {
                            nb.push(c);
                            ib.next();
                        } else {
                            break;
                        }
                    }
                    let va = na.trim_start_matches('0');
                    let vb = nb.trim_start_matches('0');
                    let ord = va.len().cmp(&vb.len()).then_with(|| va.cmp(vb));
                    if ord != Ordering::Equal {
                        return ord;
                    }
                    let len_ord = na.len().cmp(&nb.len());
                    if len_ord != Ordering::Equal {
                        return len_ord;
                    }
                } else {
                    let la = ca.to_ascii_lowercase();
                    let lb = cb.to_ascii_lowercase();
                    if la != lb {
                        return la.cmp(&lb);
                    }
                    ia.next();
                    ib.next();
                }
            }
        }
    }
}

fn is_svg(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("svg"))
}

fn is_sidecar(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("txt"))
}

fn canonical_key(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn add_sidecar_if_exists(
    path: &Path,
    sidecars: &mut Vec<DiscoveredInput>,
    seen_sidecars: &mut HashSet<PathBuf>,
) {
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str())
        && let Some(parent) = path.parent()
    {
        for ext in ["md", "txt"] {
            let candidate = parent.join(format!("{stem}.{ext}"));
            if candidate.is_file() {
                let key = canonical_key(&candidate);
                if seen_sidecars.insert(key)
                    && let Ok(content) = fs::read_to_string(&candidate)
                {
                    let filename = candidate
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or_default()
                        .to_string();
                    sidecars.push(DiscoveredInput {
                        path: candidate,
                        filename,
                        content,
                    });
                }
            }
        }
    }
}

pub fn discover_inputs(sources: &[InputSource]) -> Result<DiscoveryResult, String> {
    let mut svg_files = Vec::new();
    let mut sidecar_files = Vec::new();
    let mut seen_svgs = HashSet::new();
    let mut seen_sidecars = HashSet::new();
    let mut watch_paths = Vec::new();
    let mut font_search_dirs = Vec::new();

    for source in sources {
        let (path, expect_dir) = match source {
            InputSource::File(p) => (p, Some(false)),
            InputSource::Folder(p) => (p, Some(true)),
            InputSource::Auto(p) => (p, None),
        };

        if !path.exists() {
            return Err(format!("Input path does not exist: {}", path.display()));
        }

        let is_dir = path.is_dir();
        if let Some(expected) = expect_dir
            && expected != is_dir
        {
            return Err(format!(
                "Input path type mismatch for {}: expected {}",
                path.display(),
                if expected { "directory" } else { "file" }
            ));
        }

        watch_paths.push(path.clone());

        if is_dir {
            let fonts_sub = path.join("fonts");
            if fonts_sub.is_dir() && !font_search_dirs.contains(&fonts_sub) {
                font_search_dirs.push(fonts_sub);
            }

            let mut entries: Vec<PathBuf> = fs::read_dir(path)
                .map_err(|e| format!("Failed to read directory {}: {e}", path.display()))?
                .filter_map(|res| res.ok().map(|e| e.path()))
                .filter(|p| p.is_file())
                .collect();

            entries.sort_by(|a, b| {
                let na = a.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let nb = b.file_name().and_then(|n| n.to_str()).unwrap_or("");
                natural_cmp(na, nb)
            });

            for entry in entries {
                let filename = entry
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_string();

                if is_svg(&entry) {
                    if seen_svgs.insert(canonical_key(&entry)) {
                        let content = fs::read_to_string(&entry)
                            .map_err(|e| format!("Failed to read {}: {e}", entry.display()))?;
                        svg_files.push(DiscoveredInput {
                            path: entry,
                            filename,
                            content,
                        });
                    }
                } else if is_sidecar(&entry) && seen_sidecars.insert(canonical_key(&entry)) {
                    let content = fs::read_to_string(&entry)
                        .map_err(|e| format!("Failed to read {}: {e}", entry.display()))?;
                    sidecar_files.push(DiscoveredInput {
                        path: entry,
                        filename,
                        content,
                    });
                }
            }
        } else if is_svg(path) {
            if let Some(parent) = path.parent() {
                let fonts_sub = parent.join("fonts");
                if fonts_sub.is_dir() && !font_search_dirs.contains(&fonts_sub) {
                    font_search_dirs.push(fonts_sub);
                }
            }
            if seen_svgs.insert(canonical_key(path)) {
                let filename = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_string();
                let content = fs::read_to_string(path)
                    .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
                svg_files.push(DiscoveredInput {
                    path: path.clone(),
                    filename,
                    content,
                });
            }
            add_sidecar_if_exists(path, &mut sidecar_files, &mut seen_sidecars);
        } else if is_sidecar(path) && seen_sidecars.insert(canonical_key(path)) {
            let filename = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            let content = fs::read_to_string(path)
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
            sidecar_files.push(DiscoveredInput {
                path: path.clone(),
                filename,
                content,
            });
        }
    }

    Ok(DiscoveryResult {
        svg_files,
        sidecar_files,
        watch_paths,
        font_search_dirs,
    })
}
