# Chapter 12: Styling the Graph

Our editor is functional and interactive, but it still uses the default visual style — generic frames, default wire curves, no color-coded pins at a global level. In this chapter we build a polished dark theme: a custom `SnarlStyle` with a dark node frame and grid background, color-coded pins wired into a `theme` module, per-node-type colored headers, and per-pin wire styles. This chapter builds on the `PinInfo` material from [Chapter 9](./ch09-nodes-pins.md), the connection logic from [Chapter 10](./ch10-connections.md), and the theming-module ideas from [Chapter 6](./ch06-theming.md).

## `SnarlStyle`: The Global Graph Style

Where `egui`'s `Visuals`/`Style`/`FontDefinitions` (from [Chapter 6](./ch06-theming.md)) style the whole application, `SnarlStyle` styles *the graph specifically*. It controls the graph background, the default node frame, the pin layout, the pin size, and more. You construct it with `SnarlStyle::new()` and override fields with struct-update syntax — the same `{ ..Default::default() }` idiom the Rust Book introduces when discussing structs in [Chapter 5.1](https://doc.rust-lang.org/stable/book/ch05-01-defining-structs.html):

```rust,no_run
use egui_snarl::SnarlStyle;

let style = SnarlStyle {
    // All other fields keep their `new()` defaults:
    ..SnarlStyle::new()
};
```

The most useful fields are:

| Field | Controls |
|---|---|
| `node_layout` | How pins are arranged (`Basic` = inputs left, outputs right). |
| `pin_placement` | Where pins sit relative to the node border (`Edge`, etc.). |
| `pin_size` | The radius/size of pin shapes. |
| `node_frame` | The default `egui::Frame` around each node. |
| `bg_frame` | The `egui::Frame` for the graph background (a grid by default). |

You pass the style to the widget via `.style(style)`:

```rust,no_run
use eframe::egui;
use egui_snarl::{SnarlStyle, ui::SnarlWidget};

impl eframe::App for SnarlApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show_inside(ui, |ui| {
            SnarlWidget::new()
                .id_salt(egui::Id::new("demo-snarl"))
                .style(self.style.clone())
                .show(&mut self.snarl, &mut self.viewer, ui);
        });
    }
}
```

Because `SnarlStyle` is cheap to clone, store it on the `App` and apply it every frame. This mirrors how we stored the app-wide `theme` module in [Chapter 6](./ch06-theming.md): a single source of truth for appearance.

## A Dark Theme

Let us build a dark style. The `node_frame` sets each node's background, margin, corner radius, and border; the `bg_frame` sets the canvas background. egui's `Frame` is a builder we used in [Chapter 6](./ch06-theming.md):

```rust,no_run
use eframe::egui;
use egui_snarl::SnarlStyle;

pub fn dark_snarl_style() -> SnarlStyle {
    let node_frame = egui::Frame::default()
        .fill(egui::Color32::from_rgb(40, 42, 48))
        .corner_radius(6.0)
        .stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(70, 74, 82)))
        .inner_margin(egui::Margin::same(4.0));

    let bg_frame = egui::Frame::default()
        .fill(egui::Color32::from_rgb(24, 26, 30))
        .stroke(egui::Stroke::NONE);

    SnarlStyle {
        node_frame: Some(node_frame),
        bg_frame: Some(bg_frame),
        ..SnarlStyle::new()
    }
}
```

The header frame we customize separately, per node type, by overriding `SnarlViewer::header_frame` (we did this in [Chapter 9](./ch09-nodes-pins.md)). The `SnarlStyle.node_frame` is the *body* frame; `header_frame` on the viewer overrides the header.

## `NodeLayout` and Pin Placement

`NodeLayout` decides how pins are arranged within a node. The default is `Basic` — input pins stacked on the left, output pins stacked on the right, with the body in between. This is what we have been using implicitly all along. You can construct the default explicitly:

```rust,no_run
use egui_snarl::{NodeLayout, SnarlStyle};

let style = SnarlStyle {
    node_layout: NodeLayout::coil(),
    ..SnarlStyle::new()
};
```

`NodeLayout::coil()` produces the standard Basic layout. (The name reflects the internal rendering approach; the visible result is the familiar left-inputs / right-outputs arrangement.) For most graphs this is exactly right, and we will not change it. The point of knowing the field exists is that *alternative layouts* are possible if your graph needs them.

`PinPlacement` decides where the pin dot sits relative to the node frame. The `Edge` variant draws pins right on the node's border — the look used by most shader-graph editors. You set it on the style:

```rust,no_run
use egui_snarl::{SnarlStyle, ui::PinPlacement};

let style = SnarlStyle {
    pin_placement: PinPlacement::Edge,
    ..SnarlStyle::new()
};
```

> **Tip:** `PinPlacement::Edge` is the most polished look for a node graph: the pin dots sit half-in, half-out of the node border, so wires visually "plug in." Try it before settling for the default, which places pins just inside the frame.

## Pin Shapes and Colors: A Color Convention

In [Chapter 9](./ch09-nodes-pins.md) we color-coded pins by hand. Now we formalize the convention in a `theme` module, so every pin returns a consistent color for its data type. This is the same encapsulation idea as the `theme.rs` module from [Chapter 6](./ch06-theming.md): keep your color constants in one place so a redesign touches one file.

```rust,no_run
// src/snarl_theme.rs
use eframe::egui;
use egui_snarl::ui::{PinInfo, WireStyle};

/// The data types in our graph and their colors.
pub fn pin_color(ty: DataType) -> egui::Color32 {
    match ty {
        DataType::Number => egui::Color32::from_rgb(220, 80, 80),
        DataType::Text => egui::Color32::from_rgb(80, 200, 80),
    }
}

/// A round pin filled with the type's color, with axis-aligned wires.
pub fn pin_for(ty: DataType) -> PinInfo {
    PinInfo::circle()
        .with_fill(pin_color(ty))
        .with_wire_style(WireStyle::AxisAligned { corner_radius: 6.0 })
}

/// A dim pin for an unconnected input.
pub fn dim_pin() -> PinInfo {
    PinInfo::circle()
        .with_fill(egui::Color32::from_rgb(120, 120, 120))
}

/// The header color for a node type.
pub fn header_color(node: &DemoNode) -> egui::Color32 {
    match node {
        DemoNode::Number(_) => egui::Color32::from_rgb(110, 60, 60),
        DemoNode::Text(_) => egui::Color32::from_rgb(50, 90, 50),
        DemoNode::Concat => egui::Color32::from_rgb(60, 60, 110),
        DemoNode::Sink => egui::Color32::from_rgb(50, 50, 70),
    }
}
```

Now the viewer delegates to these helpers, and the colors are defined in exactly one place:

```rust,no_run
impl SnarlViewer<DemoNode> for DemoViewer {
    fn show_output(
        &mut self, pin: &OutPin, ui: &mut egui::Ui, snarl: &mut Snarl<DemoNode>,
    ) -> impl SnarlPin + 'static {
        let node = &mut snarl[pin.id.node];
        let ty = node.output_type(pin.id.output).unwrap_or(DataType::Number);
        match node {
            DemoNode::Number(v) => { ui.add(egui::DragValue::new(v).speed(0.1)); }
            DemoNode::Text(s) => { ui.text_edit_singleline(s); }
            DemoNode::Concat => { ui.label("out"); }
            DemoNode::Sink => unreachable!(),
        }
        crate::snarl_theme::pin_for(ty)
    }

    fn header_frame(
        &mut self,
        _frame: egui::Frame,
        node: NodeId,
        _inputs: &[InPin],
        _outputs: &[OutPin],
        snarl: &Snarl<DemoNode>,
    ) -> egui::Frame {
        let node = &snarl[node];
        let color = crate::snarl_theme::header_color(node);
        egui::Frame::default()
            .fill(color)
            .corner_radius(4.0)
            .stroke(egui::Stroke::new(1.0, egui::Color32::BLACK))
    }
}
```

Because every pin's color comes from `pin_color`, the *wires* — which take their color from the pin fill — are automatically color-coded too. A red wire flowing into a green pin is an instant, glaring type mismatch, and your eye finds it without reading a single label.

## Per-Node-Type Colored Headers

We have already shown `header_frame` in [Chapter 9](./ch09-nodes-pins.md) and formalized the colors above. The pattern is a `match` on `&T` returning a per-variant `egui::Frame`. The compiler ensures we cover every variant (Rust Book [Chapter 6.2](https://doc.rust-lang.org/stable/book/ch06-02-match.html)); adding a new node type later produces a compile error until we choose its header color — a free consistency check.

For a richer look, vary not just the color but the rounding and stroke per type. A "dangerous" node (one with side effects, like an agent that calls out to a network) might get a thicker border:

```rust,no_run
fn header_frame(
    &mut self,
    _frame: egui::Frame,
    node: NodeId,
    _inputs: &[InPin],
    _outputs: &[OutPin],
    snarl: &Snarl<DemoNode>,
) -> egui::Frame {
    let node = &snarl[node];
    let color = crate::snarl_theme::header_color(node);
    egui::Frame::default()
        .fill(color)
        .corner_radius(4.0)
        .stroke(egui::Stroke::new(
            if matches!(node, DemoNode::Sink) { 2.0 } else { 1.0 },
            egui::Color32::BLACK,
        ))
}
```

## Background Patterns

By default, `SnarlStyle`'s background draws a grid — the classic "graph paper" look that helps the user gauge position and scale. You get this for free with `SnarlStyle::new()`. The grid color and spacing derive from the `bg_frame`'s fill and the widget's internal logic.

If you want a custom background — for example, a dotted pattern, a watermark, or a "spawn zone" tint — you override `SnarlViewer::draw_background`. The method receives a `&mut Ui` covering the whole canvas and the current `TSTransform` (the pan/zoom transform) so you can draw in *graph* coordinates:

```rust,no_run
use egui_snarl::{ui::{TSTransform, SnarlViewer}, Snarl};

impl SnarlViewer<DemoNode> for DemoViewer {
    fn draw_background(
        &mut self,
        transform: TSTransform,
        ui: &mut egui::Ui,
        _snarl: &mut Snarl<DemoNode>,
    ) {
        // Let the default grid draw first, then overlay a tint in a corner.
        // (The default grid is drawn by SnarlStyle's bg_frame; here we add to it.)
        let painter = ui.painter().clone();
        let rect = ui.max_rect();
        // Example: a subtle radial vignette.
        painter.rect_filled(
            rect,
            0.0,
            egui::Color32::from_black_alpha(0),
        );
        let _ = transform; // use to convert graph<->screen coords if needed
    }
}
```

The default grid is usually what you want; we mention `draw_background` and `current_transform` for completeness — they are the escape hatch for tools that need custom canvas decorations, like drawing a "playhead" line during evaluation in [Chapter 15](./ch15-live-execution.md).

## Applying the Style Once

Store the `SnarlStyle` on your `App` and apply it in `ui()`. Construct it once in `default()` so you never rebuild it per frame:

```rust,no_run
use eframe::egui;
use egui_snarl::SnarlStyle;

pub struct SnarlApp {
    snarl: Snarl<DemoNode>,
    viewer: DemoViewer,
    style: SnarlStyle,
}

impl Default for SnarlApp {
    fn default() -> Self {
        Self {
            snarl: Snarl::new(),
            viewer: DemoViewer::default(),
            style: dark_snarl_style(),
        }
    }
}

impl eframe::App for SnarlApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show_inside(ui, |ui| {
            egui_snarl::SnarlWidget::new()
                .id_salt(egui::Id::new("demo-snarl"))
                .style(self.style.clone())
                .show(&mut self.snarl, &mut self.viewer, ui);
        });
    }
}
```

If you want a live dark/light toggle for the *graph* (separate from egui's application-wide `Visuals`), store a `bool` and rebuild the style in `logic()` when it changes. This is the same "derive a style from a small set of toggles" pattern we used for app theming in [Chapter 6](./ch06-theming.md).

## A Theme Module for the Graph

Following [Chapter 6](./ch06-theming.md), encapsulate the graph's appearance in its own module so a redesign is a one-file change:

```rust,no_run
// src/snarl_theme.rs
use eframe::egui;
use egui_snarl::{ui::{PinInfo, PinPlacement, WireStyle}, NodeLayout, SnarlStyle};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DataType { Number, Text }

pub fn pin_color(ty: DataType) -> egui::Color32 { /* ... */ }
pub fn pin_for(ty: DataType) -> PinInfo { /* ... */ }
pub fn dim_pin() -> PinInfo { /* ... */ }
pub fn header_color(node: &DemoNode) -> egui::Color32 { /* ... */ }

pub fn dark_snarl_style() -> SnarlStyle {
    let node_frame = egui::Frame::default()
        .fill(egui::Color32::from_rgb(40, 42, 48))
        .corner_radius(6.0)
        .stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(70, 74, 82)))
        .inner_margin(egui::Margin::same(4.0));
    let bg_frame = egui::Frame::default()
        .fill(egui::Color32::from_rgb(24, 26, 30));

    SnarlStyle {
        node_layout: NodeLayout::coil(),
        pin_placement: PinPlacement::Edge,
        node_frame: Some(node_frame),
        bg_frame: Some(bg_frame),
        ..SnarlStyle::new()
    }
}
```

The viewer imports from this module rather than hardcoding colors. This is the Rust Book's [Chapter 7](https://doc.rust-lang.org/stable/book/ch07-02-defining-modules-to-control-scope-and-privacy.html) advice on modules made concrete: a `snarl_theme` module exposes a small public API (`pin_for`, `header_color`, `dark_snarl_style`) and hides the rest.

## A Complete Styled Example

Here is the assembled `ui()` for a fully styled graph — dark node frames, `Edge` pin placement, axis-aligned wires, color-coded pins, per-type headers, and the grid background:

```rust,no_run
use eframe::egui;
use egui_snarl::ui::SnarlWidget;

pub struct SnarlApp {
    snarl: egui_snarl::Snarl<DemoNode>,
    viewer: DemoViewer,
    style: egui_snarl::SnarlStyle,
}

impl eframe::App for SnarlApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::Panel::top("toolbar").show_inside(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label("Node Graph Editor");
                if ui.button("Reset Style").clicked() {
                    self.style = crate::snarl_theme::dark_snarl_style();
                }
            });
        });
        egui::CentralPanel::default().show_inside(ui, |ui| {
            SnarlWidget::new()
                .id_salt(egui::Id::new("demo-snarl"))
                .style(self.style.clone())
                .show(&mut self.snarl, &mut self.viewer, ui);
        });
    }
}
```

With the viewer from [Chapter 11](./ch11-interactions.md) returning `pin_for(ty)` from `show_input`/`show_output` and `header_color(node)` from `header_frame`, the result is a graph that looks like a professional shader-graph editor: dark nodes with colored headers, color-coded pins and wires with right-angled corners, and a subtle grid behind it all.

## Live Style Editing with `egui_probe` (Optional)

The `egui-snarl` demo itself uses the `egui_probe` crate to live-edit its `SnarlStyle` at runtime — a `Probe`-driven inspector that exposes every style field as an editable widget. This is a *debugging* tool, not a production feature, but it is invaluable when you are dialing in a look: you tweak `pin_size`, `corner_radius`, and colors in a running app and see the result instantly.

> **Note:** `egui_probe` is not enabled by default. To use it, add `egui-snarl = { version = "0.11", features = ["serde", "egui-probe"] }` to your `Cargo.toml` and add `egui_probe` as a dependency. Without the feature, `ui.probe(...)` will not resolve.

To try it, add `egui_probe` to your dev-dependencies and, behind a debug flag, render a probe panel:

```rust,no_run
// dev-dependency only; do not ship to end users.
use egui_probe::Probe;

impl eframe::App for SnarlApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::Panel::left("debug").show_inside(ui, |ui| {
            ui.heading("Style Probe");
            // Probe generates editable widgets for every public field.
            ui.probe(&mut self.style);
        });
        egui::CentralPanel::default().show_inside(ui, |ui| {
            egui_snarl::SnarlWidget::new()
                .id_salt(egui::Id::new("demo-snarl"))
                .style(self.style.clone())
                .show(&mut self.snarl, &mut self.viewer, ui);
        });
    }
}
```

`egui_probe`'s `Probe` trait uses reflection-style code generation to produce a UI for any struct that implements `Probe`. Once you have found values you like, hard-code them into your `dark_snarl_style()` function and remove the probe. This is exactly how the `egui-snarl` authors developed the defaults you inherited.

> **Note:** `egui_probe` is a debugging aid, not a stable styling API. Its API may change between versions. Do not depend on it for production UI; use it only to discover the style values you then bake into your `theme` module.

## Summary

In this chapter we built a polished graph style. We learned that `SnarlStyle` controls the graph's global appearance — node frame, background frame, pin layout, pin placement — and that `SnarlViewer::header_frame` overrides the header per node type. We factored all colors into a `snarl_theme` module, color-coded pins by data type so the wires themselves become a type-mismatch alarm, and switched wires to axis-aligned segments for a shader-graph look. We mentioned `egui_probe` as an optional live-tweaking tool for discovering style values.

With Chapters 8 through 12, we now have a complete, styled, interactive node-graph editor. In Part 4, we will give this graph *meaning*: [Chapter 13](./ch13-agent-nodes.md) defines agent nodes that call out to language models, [Chapter 14](./ch14-graph-evaluation.md) turns the graph into an evaluation engine, and [Chapter 15](./ch15-live-execution.md) streams results back into the node bodies as they run.
