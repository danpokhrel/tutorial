# Chapter 6: Theming, Fonts & Styling

egui ships with sensible defaults, but most real applications eventually want a distinct look — a cohesive color palette, a custom font (including non-Latin scripts), larger headings, or rounded buttons. egui gives you three independent knobs for this, and in this chapter we'll learn how each one works and how to bundle them into a reusable `theme` module. This chapter builds on the module-structure ideas from [Chapter 5](./ch05-architecture.md); if you skipped ahead, the `theme.rs` file we create here slots directly into the layout from that chapter.

## Three Styling Concepts

egui separates appearance into three structs, each controlling a different aspect:

- **`Visuals`** — *colors*. Background, text, widget backgrounds, borders, selection highlights, and whether the whole theme is dark or light.
- **`Style`** — *geometry*. Margins, spacing, corner rounding, text styles (which map `TextStyle` to font + size), and animation timings.
- **`FontDefinitions`** — *fonts*. The actual font data and how `FontFamily` values map to lists of fonts.

All three live on the `egui::Context` and can be changed at any time. They are also cheap to clone, so you can snapshot and restore them.

## Dark and Light Mode

The quickest way to change your app's appearance is to swap the entire `Visuals`:

```rust,no_run
use eframe::egui;

impl eframe::App for MyApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        ui.horizontal(|ui| {
            if ui.button("Dark").clicked() {
                ui.ctx().set_visuals(egui::Visuals::dark());
            }
            if ui.button("Light").clicked() {
                ui.ctx().set_visuals(egui::Visuals::light());
            }
        });
    }
}
```

`set_visuals` updates the context immediately and applies to every widget drawn afterward in the same frame and beyond.

For the familiar sun/moon toggle that matches the Rust Book's own documentation site, use the built-in helper:

```rust,no_run
ui.horizontal(|ui| {
    egui::widgets::global_dark_light_mode_buttons(ui);
});
```

This renders two small buttons that flip between `Visuals::dark()` and `Visuals::light()`. It is the easiest way to give users control.

### Following the System Theme

To follow the OS preference, query it once at startup and again whenever you want to react to changes:

```rust,no_run
fn system_is_dark() -> bool {
    eframe::dark_light::detect() == eframe::dark_light::Theme::Dark
}

impl MyApp {
    pub fn new(ctx: &egui::Context) -> Self {
        ctx.set_visuals(if system_is_dark() {
            egui::Visuals::dark()
        } else {
            egui::Visuals::light()
        });
        Self { /* ... */ }
    }
}
```

> **Tip:** `eframe::dark_light` is a small crate re-exported by eframe that probes the OS for the current accent/theme. On platforms where detection fails it falls back to dark, which is a safe default for developer tools.

## Per-Widget and Per-Subtree Styling

Sometimes you want a change to apply only to a subtree — a red error panel, a compact toolbar — without affecting the rest of the app. Use `ui.scope`:

```rust,no_run
ui.scope(|ui| {
    // Make everything in this scope use smaller spacing and a red tint.
    ui.style_mut().spacing.item_spacing = egui::vec2(2.0, 2.0);
    ui.visuals_mut().override_text_color = Some(egui::Color32::RED);
    ui.label("This is a compact, red warning block.");
    ui.button("Me too");
});

// Outside the scope, the original style and visuals are restored.
ui.button("Back to normal spacing and color");
```

`ui.scope` snapshots `Style` and `Visuals` on entry and restores them on exit, so any mutation made through `ui.style_mut()` or `ui.visuals_mut()` is local to the scope. This is the immediate-mode equivalent of a CSS scope and costs nothing persistent.

## `RichText` and `Button` Inline Styling

For one-off styling without a scope, `RichText` and `Button` carry their own style overrides. This is the idiomatic way to color a single label or fill a single button:

```rust,no_run
use eframe::egui;

impl eframe::App for MyApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // RichText lets you set color, size, and font family inline.
        ui.label(
            egui::RichText::new("Danger!")
                .color(egui::Color32::RED)
                .text_style(egui::TextStyle::Heading)
                .strong(),
        );

        // Button styling: fill, stroke, and text color.
        if ui
            .add(
                egui::Button::new(
                    egui::RichText::new("Delete")
                        .color(egui::Color32::WHITE),
                )
                .fill(egui::Color32::from_rgb(180, 40, 40))
                .stroke(egui::Stroke::NONE),
            )
            .clicked()
        {
            // ...
        }
    }
}
```

Because `RichText` and `Button` are builders, you can chain as many overrides as you need. They do not touch the context, so they are safe to use anywhere.

## Fonts

egui's font system has three pieces:

- **`FontData`** — raw font bytes, wrapped from a `&'static [u8]` or owned `Vec<u8>`.
- **`FontFamily`** — a named family: `Proportional` (the default for body text) or `Monospace` (code). You can define your own as well.
- **`FontDefinitions`** — the map that says "for `Proportional`, try font A, then B, then C."

Each family is a *fallback chain*: egui tries the first font for a glyph, and if it lacks that glyph, falls through to the next. This is how you mix a Latin font with a CJK font.

```rust,no_run
use eframe::egui;

fn install_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();

    // Register a custom proportional font from bytes compiled in.
    fonts.font_data.insert(
        "my_sans".to_owned(),
        egui::FontData::from_static(include_bytes!(
            "../assets/MySans-Regular.ttf"
        )),
    );

    // Put it first in the Proportional fallback chain.
    fonts
        .families
        .entry(egui::FontFamily::Proportional)
        .or_default()
        .insert(0, "my_sans".to_owned());

    ctx.set_fonts(fonts);
}
```

`include_bytes!` embeds the file into the binary at compile time (Rust Book [Chapter 19.5](https://doc.rust-lang.org/stable/book/ch19-06-macros.html) discusses macros more broadly; `include_bytes!` itself is documented among the standard macros). Using `from_static` lets egui borrow the bytes with a `'static` lifetime, avoiding a copy.

### CJK and Non-Latin Fonts

To support Chinese, Japanese, or Korean text, embed a CJK font and *prepend* it to the `Proportional` chain. Prepending (rather than appending) ensures CJK glyphs render in the CJK font rather than falling through to the Latin font's missing-glyph box:

```rust,no_run
fn install_cjk_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();

    fonts.font_data.insert(
        "noto_cjk".to_owned(),
        egui::FontData::from_static(include_bytes!(
            "../assets/NotoSansCJK-Regular.ttc"
        )),
    );

    // Prepend so CJK glyphs are found here first.
    fonts
        .families
        .entry(egui::FontFamily::Proportional)
        .or_default()
        .insert(0, "noto_cjk".to_owned());

    // Also make it available as its own family for explicit use.
    fonts
        .families
        .entry(egui::FontFamily::Name("CJK".into()))
        .or_default()
        .push("noto_cjk".to_owned());

    ctx.set_fonts(fonts);
}
```

> **Warning:** CJK font files are large (often 10–20 MB). If binary size matters, consider subsetting the font to the glyphs you need before embedding, or loading it from disk at runtime via `FontData::from_owned(std::fs::read(path)?)`.

## Text Size and Styling

egui maps a small set of `TextStyle` values to `(FontFamily, f32 size)` pairs inside `Style::text_styles`. Since egui 0.34 the default body size is **13.0 pt**. The standard styles are:

- `TextStyle::Small`
- `TextStyle::Body` — the default for `ui.label`.
- `TextStyle::Monospace`
- `TextStyle::Button`
- `TextStyle::Heading`

You can override any of them, or add your own:

```rust,no_run
fn tune_text_styles(ctx: &egui::Context) {
    use egui::{FontFamily, TextStyle};

    let mut style = (*ctx.style()).clone();
    style.text_styles = [
        (TextStyle::Heading, FontFamily::Proportional, 22.0),
        (TextStyle::Body, FontFamily::Proportional, 15.0),
        (TextStyle::Monospace, FontFamily::Monospace, 13.0),
        (TextStyle::Button, FontFamily::Proportional, 15.0),
        (TextStyle::Small, FontFamily::Proportional, 11.0),
    ]
    .into_iter()
    .collect();
    ctx.set_style(style);
}
```

To use a specific style on a label, use `RichText::text_style`:

```rust,no_run
ui.label(egui::RichText::new("Title").text_style(egui::TextStyle::Heading));
```

## Images and Textures

There are two ways to display images in egui.

### URI-Based Image Loaders (Preferred)

The `egui_extras` crate provides image loaders that fetch from a URI (a file path, `http://` URL, or `bytes://` embedding). Install them once at startup and then use `ui.image`:

```rust,no_run
use eframe::egui;

impl MyApp {
    pub fn new(ctx: &egui::Context) -> Self {
        // Install the loaders. Do this exactly once.
        egui_extras::install_image_loaders(ctx);
        Self { /* ... */ }
    }
}

impl eframe::App for MyApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // The loader fetches and caches the image asynchronously.
        ui.image(egui::include_image!("../assets/logo.png"));
    }
}
```

`egui::include_image!` embeds the image and returns a URI `ui.image` understands. For runtime paths, pass the string URI directly.

> **Warning — the #1 cause of blank images:** forgetting to call `egui_extras::install_image_loaders(ctx)`. Without it, `ui.image` has no loader registered and silently renders nothing (or a placeholder) on the first frames. If your images never appear, check this first.

### Manual `TextureHandle`

For full control — procedural textures, dynamically generated images, pixel buffers — create a `TextureHandle` from a `ColorImage`:

```rust,no_run
use eframe::egui;

pub struct MyApp {
    texture: Option<egui::TextureHandle>,
}

impl MyApp {
    pub fn new(ctx: &egui::Context) -> Self {
        // Build a 64x64 gradient image.
        let size = [64, 64];
        let pixels: Vec<egui::Color32> = (0..64 * 64)
            .map(|i| {
                let t = (i % 64) as f32 / 64.0;
                egui::Color32::from_rgb(
                    (t * 255.0) as u8,
                    100,
                    (255.0 - t * 255.0) as u8,
                )
            })
            .collect();
        let image = egui::ColorImage {
            size,
            pixels,
            format: egui::ColorImageFormat::Rgba8,
        };
        let texture =
            ctx.load_texture("my-gradient", image, egui::TextureOptions::LINEAR);
        Self {
            texture: Some(texture),
        }
    }
}

impl eframe::App for MyApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        if let Some(tex) = &self.texture {
            ui.image(egui::load::TextureHandle::id(tex), [128.0, 128.0]);
        }
    }
}
```

Store the `TextureHandle` on your `App` struct so it is not recreated every frame — recreating it would re-upload the data to the GPU each frame and waste bandwidth.

## Creating a Theme Module

Now let's bundle everything into a `theme.rs` module, as suggested in [Chapter 5](./ch05-architecture.md). The goal is one call at startup that applies a cohesive look:

```rust,no_run
// src/theme.rs
use eframe::egui;

/// A cohesive color palette for the node-graph editor.
pub struct EditorTheme {
    pub bg: egui::Color32,
    pub panel_bg: egui::Color32,
    pub text: egui::Color32,
    pub accent: egui::Color32,
    pub accent_hover: egui::Color32,
    pub node_bg: egui::Color32,
    pub node_border: egui::Color32,
}

impl EditorTheme {
    /// A custom dark theme with a blue accent.
    pub fn dark() -> Self {
        Self {
            bg: egui::Color32::from_rgb(24, 24, 28),
            panel_bg: egui::Color32::from_rgb(32, 32, 38),
            text: egui::Color32::from_rgb(220, 222, 228),
            accent: egui::Color32::from_rgb(86, 140, 245),
            accent_hover: egui::Color32::from_rgb(120, 165, 255),
            node_bg: egui::Color32::from_rgb(44, 46, 54),
            node_border: egui::Color32::from_rgb(70, 74, 86),
        }
    }

    /// Apply the theme to a context: visuals, style, and fonts together.
    pub fn apply(&self, ctx: &egui::Context) {
        let mut visuals = egui::Visuals::dark();

        // Backgrounds.
        visuals.panel_bg = self.panel_bg;
        visuals.window_bg = self.panel_bg;
        visuals.extreme_bg_color = self.bg;

        // Widgets.
        visuals.widgets.noninteractive.bg_fill = self.bg;
        visuals.widgets.noninteractive.fg_stroke =
            egui::Stroke::new(1.0, self.text);
        visuals.widgets.inactive.bg_fill = self.node_bg;
        visuals.widgets.inactive.fg_stroke =
            egui::Stroke::new(1.0, self.text);
        visuals.widgets.hovered.bg_fill = self.accent_hover;
        visuals.widgets.hovered.fg_stroke =
            egui::Stroke::new(1.0, egui::Color32::WHITE);
        visuals.widgets.active.bg_fill = self.accent;
        visuals.widgets.active.fg_stroke =
            egui::Stroke::new(1.0, egui::Color32::WHITE);

        // Selection and hyperlinks use the accent.
        visuals.selection.bg_fill = self.accent;
        visuals.hyperlink_color = self.accent;

        ctx.set_visuals(visuals);

        // Geometry: comfortable spacing and slightly rounded widgets.
        let mut style = (*ctx.style()).clone();
        style.spacing.item_spacing = egui::vec2(8.0, 6.0);
        style.spacing.button_padding = egui::vec2(10.0, 4.0);
        style.spacing.window_margin = egui::Margin::same(10);
        for (_style, widget) in style.visuals.widgets.iter_mut() {
            widget.rounding = egui::Rounding::same(6.0);
        }
        ctx.set_style(style);
    }
}
```

> **Note:** `Visuals::dark()` is our starting point; we then override the fields we care about. Starting from a built-in preset and overriding is more robust than building a `Visuals` from scratch, because new egui versions may add fields that default sensibly when you start from a preset.

Applying it is a one-liner at startup:

```rust,no_run
// src/app.rs
use crate::theme::EditorTheme;

impl MyApp {
    pub fn new(ctx: &egui::Context) -> Self {
        EditorTheme::dark().apply(ctx);
        Self { /* ... */ }
    }
}
```

Because the theme lives in its own module with no `egui::Ui` rendering logic, you can later add a `EditorTheme::light()` constructor, serialize user preferences into it, or swap themes at runtime by calling `apply` again — the context picks up the change immediately.

---

Your application now has a clean architecture and a custom look. Next we need to let the user *do* things: type into boxes, open menus, pick files, and respond to confirmation dialogs. In [Chapter 7](./ch07-input-menus.md) we'll cover input handling, menu bars, floating windows, modal dialogs, and native file pickers.
