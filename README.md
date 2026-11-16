# svg-deck

Standalone, zero-dependency Rust CLI compiler that compiles one or more `.svg` files and/or folders into a single, self-contained, offline-ready `.html` presentation.

## Usage

```bash
# Compile a folder of SVGs
svg-deck --folder ./demo-deck -o presentation.html

# Mix --file, --folder, and positional inputs in exact CLI order
svg-deck --file master.svg --folder ./overlays -o presentation.html
svg-deck master.svg ./extra_slides -o presentation.html

# Watch mode, font embedding, and PDF export
svg-deck --folder ./demo-deck --embed-fonts --watch -o presentation.html
svg-deck --folder ./demo-deck --pdf --lang it --filters "Theme Amber" -o presentation.html
```

## Player Behavior
- Opens directly on **Slide 1, Step 0** by default.
- Append `?home=1` to open the **Home Launcher (Slide 0)** with language selector, filter toggles, radio groups, and Presenter View launcher (or press `Home` / `0` / click `⌂` in the HUD).
- Press `P` for synchronized **Presenter View**, `G` / `Esc` for **Overview Grid**, hold `L` for **Virtual Laser**, `D`/`C` for **Freehand Drawing**, and `H` to toggle the **HUD**.

## Development

```bash
cargo test
cargo build --release
```
