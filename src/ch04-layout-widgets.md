# Chapter 4: Layout, Widgets & State

So far we have worked inside a single `CentralPanel`. Real applications are more structured: a sidebar of controls, a top toolbar, a central canvas, perhaps a status bar at the bottom. This chapter teaches egui's layout system—how a `Ui` grows a cursor, how panels compose, how to size and center things, and how to lay out large or tabular data with `ScrollArea` and `Grid`. We then widen the widget vocabulary, introduce `RichText` for inline styling, and finish by building a **custom widget** that implements the `egui::Widget` trait—the same pattern the Rust Book uses to teach [implementing traits for your own types](https://doc.rust-lang.org/stable/book/ch10-02-traits.html). We also address the most subtle pitfall in immediate-mode UIs: keeping widget `Id`s stable in loops.

## The Layout System

Every `egui::Ui` has a `Layout` and a **cursor**—a point that advances as you add widgets. The layout decides which direction the cursor moves and how widgets are placed:

- `Layout::top_down(Align::Center)` — cursor moves down; widgets centered horizontally.
- `Layout::bottom_up(...)` — cursor moves upward.
- `Layout::left_to_right(Align::TOP)` — cursor moves right; widgets top-aligned.
- `Layout::right_to_left(...)` — cursor moves left.

The default for a fresh `Ui` is usually `top_down` (or whatever the parent panel dictates). You rarely set the layout on the root `Ui`; instead, you create inner `Ui`s with a chosen layout:

```rust,no_run
ui.horizontal(|ui| { /* left_to_right */ });
ui.vertical(|ui|   { /* top_down     */ });

// Explicit control:
ui.horizontal_top(|ui| { /* left_to_right, top aligned */ });
```

`ui.horizontal(|ui| { … })` is shorthand for "create a child `Ui` with `left_to_right`, add children, then collapse." The same closure pattern repeats throughout egui; see Rust Book [Ch. 13 on closures](https://doc.rust-lang.org/stable/book/ch13-01-closures.html) if the borrowed closure in `|ui|` looks unfamiliar.

## Panels

Panels are the structural backbone of an egui app. There are three families:

- **`CentralPanel`** — fills all remaining space; exactly one per frame, and it must be last.
- **`Panel`** — as of egui 0.35, the former `SidePanel` and `TopBottomPanel` were unified into a single `egui::Panel` type. You pick a side via the constructor: `Panel::left(id)` / `Panel::right(id)` give a resizable left or right column, and `Panel::top(id)` / `Panel::bottom(id)` give a resizable top or bottom bar. (Older code may still reference `SidePanel`/`TopBottomPanel`; on 0.35+ those names no longer exist—use `Panel` instead.)

**Order matters.** Panels claim space from the available rectangle, and each later panel sees only what is left. You must add side panels and top/bottom panels **before** the central panel:

```rust,no_run
egui::Panel::left("left_panel")
    .resizable(true)
    .default_size(220.0)
    .min_size(150.0).max_size(400.0)
    .show(ui, |ui| {
        ui.heading("Controls");
        // ... sidebar widgets ...
    });

egui::Panel::top("top_panel")
    .show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.menu_button("File", |ui| { /* ... */ });
            ui.menu_button("Edit", |ui| { /* ... */ });
        });
    });

egui::CentralPanel::default()
    .show(ui, |ui| {
        ui.heading("Canvas");
        // ... the main content ...
    });
```

If you reversed this—`CentralPanel` first—it would consume the whole window, and the side/top panels would render over (or be squeezed into) nothing.

> **API note (0.34+).** Since egui 0.34, panel `.show()` takes `&mut Ui` (the `Ui` you are currently building inside), **not** a `&Context`. Older code with `.show(ctx, …)` will not compile on 0.35. Inside `App::ui`, pass the `&mut Ui` you were handed (or a child `Ui` derived from it). When you genuinely have only a `Context`—e.g. in `run_simple_native`—you use `.show(ctx, …)` on that path instead.

## Sizing and Measuring

A `Ui` exposes the space it has, so you can lay things out precisely:

```rust,no_run
// How much room is left in this Ui right now?
let avail = ui.available_size();      // Vec2
let width = ui.available_width();     // f32
let used  = ui.min_rect();            // Rect of everything drawn so far

// A widget that is exactly w×h, sized explicitly:
ui.add_sized([width, 24.0], egui::Button::new("Full-width button"));

// Reserve vertical space and get a child Ui inside it:
let (rect, _response) = ui.allocate_exact_size(
    egui::vec2(200.0, 100.0),
    egui::Sense::hover(),
);
let mut child = ui.child_ui_with_id_source(
    rect,
    *ui.layout(),
    "child_block",
);
child.label("inside the allocated rect");
```

`add_sized` is the everyday tool for "make this widget exactly this big."

## Centering and Custom Layouts

egui's layout is deliberately simple; centering is a small recipe:

```rust,no_run
// Vertically center a row of widgets:
ui.vertical_centered(|ui| {
    ui.horizontal(|ui| {
        if ui.button("Save").clicked() { /* ... */ }
        if ui.button("Cancel").clicked() { /* ... */ }
    });
});

// Or allocate a region with a chosen layout:
ui.allocate_ui_with_layout(
    egui::vec2(300.0, 60.0),
    egui::Layout::top_down(egui::Align::Center),
    |ui| {
        ui.label("centered text");
    },
);
```

## ScrollArea

For lists longer than the window, wrap content in a `ScrollArea`:

```rust,no_run
egui::ScrollArea::vertical()
    .auto_shrink([false, true])
    .show(ui, |ui| {
        for i in 0..50 {
            ui.label(format!("row {}", i));
        }
    });
```

Variants: `ScrollArea::both()`, `ScrollArea::horizontal()`. For **thousands** of rows, do not build them all—use a virtualized list. egui does not ship one, but the pattern is: clip to the visible rows given the scroll offset, and only emit those. The egui examples repository includes virtual-list patterns; the key API is `ScrollArea::show_rows`, which takes the total count and a closure that is only invoked for visible indices.

## Grids

For tabular, aligned content use `Grid`. Column widths auto-size to the widest cell, and `end_row()` advances to the next row:

```rust,no_run
egui::Grid::new("settings_grid")
    .num_columns(2)
    .spacing([16.0, 8.0])
    .show(ui, |ui| {
        ui.label("Name");
        ui.text_edit_singleline(&mut self.name);
        ui.end_row();

        ui.label("Age");
        ui.add(egui::Slider::new(&mut self.age, 0..=120));
        ui.end_row();

        ui.label("Sound");
        ui.checkbox(&mut self.sound_on, "enabled");
        ui.end_row();
    });
```

Grids are great for settings dialogs and property editors—exactly what our sidebar needs.

## More Widgets

A quick tour of widgets you will reach for often:

```rust,no_run
let mut flag = true;
let mut value = 5;
let mut choice = 0u32;

ui.checkbox(&mut flag, "enable thing");

// A numeric drag field (scrub the value by dragging):
ui.add(egui::DragValue::new(&mut value).range(0..=100));

// Dropdown:
egui::ComboBox::from_label("mode")
    .selected_index(choice as usize)
    .show_ui(ui, |ui| {
        ui.selectable_value(&mut choice, 0, "Linear");
        ui.selectable_value(&mut choice, 1, "Smooth");
        ui.selectable_value(&mut choice, 2, "Stepped");
    });

// Collapsible section:
ui.collapsing("Advanced", |ui| {
    ui.label("hidden by default");
});

// Visual separators:
ui.separator();

// Progress and spinners:
ui.add(egui::ProgressBar::new(0.4).text("40%"));
ui.add(egui::Spinner::new());
```

## RichText

`RichText` lets you style a span of text—size, color, font family—and `ui.label` accepts it directly:

```rust,no_run
use egui::RichText;

ui.label(RichText::new("big and red").color(egui::Color32::RED).size(28.0));
ui.label(RichText::new("monospace").family(egui::FontFamily::Monospace));

// Spans in a single line:
let line = RichText::new("Price: ").strong()
    + RichText::new("$42").color(egui::Color32::LIGHT_GREEN);
ui.label(line);
```

For anything beyond inline text, `egui::Label` has `wrap_mode`, `truncate`, and similar options.

## Custom Widgets: the `egui::Widget` Trait

When none of the built-ins fit, you implement `egui::Widget`. The trait is small:

```rust,no_run
pub trait Widget {
    fn ui(self, ui: &mut Ui) -> Response;
}
```

A custom widget reserves space, handles interaction, paints, and returns a `Response`. Here is a complete **Knob** widget—a circular dial you drag vertically to change a value. It shows both idioms in one place: a struct implementing `Widget`, which internally uses lower-level `Ui` calls.

```rust,no_run
use eframe::egui;
use egui::{Response, Sense, Ui, Vec2, Widget};

pub struct Knob<'a> {
    value: &'a mut f32,
    radius: f32,
    range: std::ops::RangeInclusive<f32>,
}

impl<'a> Knob<'a> {
    pub fn new(value: &'a mut f32, range: std::ops::RangeInclusive<f32>) -> Self {
        Self { value, radius: 20.0, range }
    }
}

impl<'a> Widget for Knob<'a> {
    fn ui(self, ui: &mut Ui) -> Response {
        let size = Vec2::splat(self.radius * 2.0);
        let (rect, response) = ui.allocate_exact_size(size, Sense::drag());

        // Handle dragging: vertical drag changes the value.
        if response.dragged() {
            let dy = -response.drag_delta().y;
            let span = self.range.end() - self.range.start();
            *self.value = (*self.value + dy * span * 0.01)
                .clamp(*self.range.start(), *self.range.end());
        }

        // Paint the knob: a circle plus an indicator line.
        let center = rect.center();
        let painter = ui.painter_at(rect);
        let color = if response.hovered() || response.dragged() {
            egui::Color32::from_rgb(120, 180, 255)
        } else {
            egui::Color32::from_rgb(90, 90, 90)
        };
        painter.circle_stroke(center, self.radius * 0.9, egui::Stroke::new(2.0, color));

        // Angle: map [start..end] to [-135°..+135°].
        let t = (*self.value - self.range.start())
            / (self.range.end() - self.range.start());
        let angle = (-135.0_f32.to_radians())
            + t * (270.0_f32.to_radians());
        let tip = center
            + egui::vec2(
                (self.radius * 0.8) * angle.cos(),
                (self.radius * 0.8) * angle.sin(),
            );
        painter.line_segment(
            [center, tip],
            egui::Stroke::new(2.0, egui::Color32::WHITE),
        );

        // Always return the Response so callers can chain checks.
        response
    }
}
```

Use it like any built-in widget:

```rust,no_run
let mut gain = 0.5_f32;
ui.add(Knob::new(&mut gain, 0.0..=1.0));
```

> **Note on `drag_delta`.** `response.drag_delta()` returns the *per-frame* drag distance in screen pixels — it resets to zero each frame, it is **not** cumulative. The multiplier `0.01` in the Knob scales this per-pixel movement so that dragging 100 pixels changes the value by roughly one full range. If you want a different "feel," adjust the multiplier: a smaller value makes the knob less sensitive.

This is the same shape as Rust's own trait implementations: a type declares it implements a trait, the trait has a required method, and callers treat it uniformly. See Rust Book [Ch. 10 on traits](https://doc.rust-lang.org/stable/book/ch10-02-traits.html). The **two idioms** in the wild are:

1. **A struct implementing `Widget`** (above) — best for reusable, stateful-feeling widgets.
2. **A function returning `Response`** (`fn knob(ui, value, range) -> Response`) — best for one-off, parameterized widgets you do not need to name.

Either is fine; prefer the struct when you expect to reuse it or attach configuration via builder methods (`Knob::new(...).radius(30.0).color(...)`).

## The `Response` Object

Every widget returns a `Response`. It is your handle for "what happened to this widget this frame." Always return it from your own widgets—callers will want it:

```rust,no_run
let r = ui.button("delete");
if r.clicked() { /* one frame */ }
if r.hovered() { /* pointer is over it */ }
if r.dragged() { /* being dragged */ }
r.on_hover_text("permanently remove the item");   // tooltip

// Right-click context menu, attached to the same widget:
r.context_menu(|ui| {
    if ui.button("Duplicate").clicked() { /* ... */ }
    if ui.button("Delete").clicked()   { /* ... */ }
});
```

`Response` is cheap—it is essentially an `Id` plus some flags. Chaining like `r.on_hover_text(...)` returns a new `Response` you can keep chaining on, which is the idiomatic way to enrich a widget.

## Stable `Id`s in Loops

egui tracks per-widget state (scroll offsets, focus, animation timers, drag state) by `egui::Id`. The `Id` must be **stable** across frames for the same logical widget. The default `Id` for a `ui.button("Save")` is derived from the button text *and its position in the call sequence*—fine for static UIs, but **wrong in loops** where items can be added, removed, or reordered.

Consider a list of toggles:

```rust,no_run
// BUG: index-based implicit Ids shift when items are removed,
// so each toggle's checked-state jumps to its neighbor.
for (i, item) in items.iter().enumerate() {
    ui.checkbox(&mut item.enabled, &item.name); // implicit Id from i
    let _ = i;
}
```

The fix is to derive the `Id` from a **stable key** of the item:

```rust,no_run
for item in items.iter_mut() {
    // Stable Id keyed by the item's own identifier, not its position.
    ui.push_id(format!("toggle_{}", item.id), |ui| {
        ui.checkbox(&mut item.enabled, &item.name);
    });
}
```

> **Tip: `push_id` accepts `impl Into<Id>`.** `&str`, `String`, `Id`, and integer types all work. Using `name.as_str()` (a `&str`) is cheaper than `format!("toggle_{}", item.id)` because it avoids a heap allocation per row per frame. Reserve `format!` for when you need to combine multiple values into a key; prefer a bare `&str` or `Id` when a single stable key is available.

Other stable-Id tools:

```rust,no_run
use egui::Id;

let id = Id::new("my_knob");
let child_id = id.with("indicator");      // derive a child Id deterministically
ui.push_id(id, |ui| { /* widgets here get id-prefixed Ids */ });
```

> **Warning: the silent shuffle.** Unstable `Id`s do not crash—they silently mis-associate state. The symptom is "my checkbox state jumped to the next row when I deleted an item." Always key `Id`s on stable data, not loop indices.

## Putting It Together: A Panel-Based Layout

We finish with a small, working multi-panel app: a left sidebar of controls and a central display area. It exercises panels, grids, a custom widget, and stable `Id`s:

```rust,no_run
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use eframe::egui;
use egui::{Response, Sense, Ui, Vec2, Widget};

// --- A tiny custom widget (Knob, abridged from above) ---
struct Knob<'a> {
    value: &'a mut f32,
}
impl<'a> Widget for Knob<'a> {
    fn ui(self, ui: &mut Ui) -> Response {
        let radius = 20.0;
        let size = Vec2::splat(radius * 2.0);
        let (rect, response) = ui.allocate_exact_size(size, Sense::drag());
        if response.dragged() {
            *self.value = (*self.value - response.drag_delta().y * 0.01).clamp(0.0, 1.0);
        }
        let painter = ui.painter_at(rect);
        let center = rect.center();
        painter.circle_stroke(center, radius * 0.9,
            egui::Stroke::new(2.0, egui::Color32::LIGHT_BLUE));
        let angle = -135.0_f32.to_radians() + *self.value * 270.0_f32.to_radians();
        let tip = center + egui::vec2(
            (radius * 0.8) * angle.cos(),
            (radius * 0.8) * angle.sin(),
        );
        painter.line_segment([center, tip], egui::Stroke::new(2.0, egui::Color32::WHITE));
        response
    }
}

pub struct LayoutApp {
    name: String,
    gain: f32,
    rows: Vec<(String, bool)>,
}

impl Default for LayoutApp {
    fn default() -> Self {
        Self {
            name: "node 1".to_owned(),
            gain: 0.5,
            rows: vec![
                ("alpha".to_owned(), true),
                ("beta".to_owned(), false),
                ("gamma".to_owned(), true),
            ],
        }
    }
}

impl eframe::App for LayoutApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // 1) Top bar FIRST.
        egui::Panel::top("top_bar")
            .show(ui, |ui| {
                egui::MenuBar::new().ui(ui, |ui| {
                    ui.menu_button("File", |ui| {
                        if ui.button("New").clicked() { self.rows.clear(); }
                    });
                    ui.menu_button("Edit", |ui| {
                        if ui.button("Add row").clicked() {
                            self.rows.push((format!("row {}", self.rows.len()), false));
                        }
                    });
                });
            });

        // 2) Left sidebar NEXT.
        egui::Panel::left("sidebar")
            .resizable(true)
            .default_size(240.0)
            .min_size(160.0).max_size(420.0)
            .show(ui, |ui| {
                ui.heading("Controls");
                ui.separator();

                egui::Grid::new("settings")
                    .num_columns(2)
                    .spacing([12.0, 8.0])
                    .show(ui, |ui| {
                        ui.label("Name");
                        ui.text_edit_singleline(&mut self.name);
                        ui.end_row();
                        ui.label("Gain");
                        ui.add(Knob { value: &mut self.gain });
                        ui.end_row();
                    });

                ui.separator();
                ui.heading("Rows");

                // Stable Ids keyed on each row's *name*, not its index.
                for (name, enabled) in self.rows.iter_mut() {
                    ui.push_id(name.as_str(), |ui| {
                        ui.checkbox(enabled, name.as_str());
                    });
                }
            });

        // 3) Central panel LAST.
        egui::CentralPanel::default()
            .show(ui, |ui| {
                ui.heading("Canvas");
                ui.label(format!("editing: {}  (gain {:.2})", self.name, self.gain));

                ui.separator();
                ui.label("rows:");
                egui::ScrollArea::vertical().show(ui, |ui| {
                    egui::Grid::new("rows_grid").num_columns(2).show(ui, |ui| {
                        for (name, enabled) in &self.rows {
                            ui.label(name);
                            ui.label(if *enabled { "on" } else { "off" });
                            ui.end_row();
                        }
                    });
                });
            });
    }
}

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([900.0, 600.0])
            .with_title("flow-builder"),
        ..Default::default()
    };
    eframe::run_native(
        "flow-builder",
        options,
        Box::new(|_cc| Ok(Box::<LayoutApp>::default())),
    )
}
```

Run it. The top bar offers File/Edit menus; the resizable left sidebar holds a settings grid and a knob; the central area scrolls a tabular view of rows. Drag the knob to change the gain; toggle rows in the sidebar and watch the central table update next frame—no syncing code, because the state lives on `LayoutApp` and both panels simply read it.

## Next Steps

You can now compose multi-panel layouts, size and center widgets, scroll and grid content, style text with `RichText`, and write your own `egui::Widget` returning a proper `Response`. You also understand the one subtlety that bites everyone once: stable `Id`s in loops.

This completes the foundation of the book. From here, the natural next step is to bring in **`egui-snarl`** for the node-graph editor that `flow-builder` is named for: defining node types with typed input/output pins, wiring pins together, serializing graphs with `serde`, and rendering the snarl inside the central panel we just built. The data model lives in `src/graph/` (pure, no egui), the rendering lives in `src/panels/canvas.rs`, and `app.rs` owns it all—exactly the structure we set up in [Chapter 2](./ch02-project-setup.md).
