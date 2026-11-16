use clap::{Arg, ArgAction, Command};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub enum InputSource {
    File(PathBuf),
    Folder(PathBuf),
    Auto(PathBuf),
}

#[derive(Debug, Clone)]
pub struct CliArgs {
    pub inputs: Vec<InputSource>,
    pub output: PathBuf,
    pub watch: bool,
    pub pdf: bool,
    pub embed_fonts: bool,
    pub lang: Option<String>,
    pub filters: Vec<String>,
}

pub fn parse_cli() -> CliArgs {
    let cmd = Command::new("svg-deck")
        .version(env!("CARGO_PKG_VERSION"))
        .about("Standalone zero-dependency SVG presentation compiler")
        .arg(
            Arg::new("file")
                .long("file")
                .value_name("PATH")
                .action(ArgAction::Append)
                .help("Input SVG file (can be repeated)"),
        )
        .arg(
            Arg::new("folder")
                .long("folder")
                .value_name("DIR")
                .action(ArgAction::Append)
                .help("Input folder containing SVG/MD/TXT files (can be repeated)"),
        )
        .arg(
            Arg::new("inputs")
                .value_name("INPUTS")
                .num_args(0..)
                .action(ArgAction::Append)
                .help("Positional SVG files or folders"),
        )
        .arg(
            Arg::new("output")
                .short('o')
                .long("output")
                .value_name("PATH")
                .default_value("presentation.html")
                .help("Output HTML file path"),
        )
        .arg(
            Arg::new("watch")
                .long("watch")
                .action(ArgAction::SetTrue)
                .help("Watch input files and folders and recompile on save"),
        )
        .arg(
            Arg::new("pdf")
                .long("pdf")
                .action(ArgAction::SetTrue)
                .help("Export multi-page PDF via headless Chromium/Brave/Edge"),
        )
        .arg(
            Arg::new("embed-fonts")
                .long("embed-fonts")
                .action(ArgAction::SetTrue)
                .help("Scan font-family declarations and embed matching fonts as Base64"),
        )
        .arg(
            Arg::new("lang")
                .long("lang")
                .value_name("CODE")
                .help("Default or PDF export language code"),
        )
        .arg(
            Arg::new("filters")
                .long("filters")
                .value_name("LIST")
                .help("Comma-separated filter titles or keys to enable"),
        );

    let matches = cmd.get_matches();

    // Preserve exact CLI argument order across --file, --folder, and positional inputs
    let mut indexed: Vec<(usize, InputSource)> = Vec::new();

    if let (Some(indices), Some(vals)) = (
        matches.indices_of("file"),
        matches.get_many::<String>("file"),
    ) {
        for (idx, val) in indices.zip(vals) {
            indexed.push((idx, InputSource::File(PathBuf::from(val))));
        }
    }

    if let (Some(indices), Some(vals)) = (
        matches.indices_of("folder"),
        matches.get_many::<String>("folder"),
    ) {
        for (idx, val) in indices.zip(vals) {
            indexed.push((idx, InputSource::Folder(PathBuf::from(val))));
        }
    }

    if let (Some(indices), Some(vals)) = (
        matches.indices_of("inputs"),
        matches.get_many::<String>("inputs"),
    ) {
        for (idx, val) in indices.zip(vals) {
            indexed.push((idx, InputSource::Auto(PathBuf::from(val))));
        }
    }

    indexed.sort_by_key(|(idx, _)| *idx);
    let mut inputs: Vec<InputSource> = indexed.into_iter().map(|(_, s)| s).collect();

    if inputs.is_empty() {
        inputs.push(InputSource::Folder(PathBuf::from(".")));
    }

    let output = PathBuf::from(
        matches
            .get_one::<String>("output")
            .map(String::as_str)
            .unwrap_or("presentation.html"),
    );

    let filters = matches
        .get_one::<String>("filters")
        .map(|s| {
            s.split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();

    CliArgs {
        inputs,
        output,
        watch: matches.get_flag("watch"),
        pdf: matches.get_flag("pdf"),
        embed_fonts: matches.get_flag("embed-fonts"),
        lang: matches.get_one::<String>("lang").cloned(),
        filters,
    }
}
