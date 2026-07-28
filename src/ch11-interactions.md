# Chapter 11: Interactions & UX

Our graph validates connections and renders rich nodes, but the user still has no way to add or remove nodes without editing source code. In this chapter we wire up the full interaction surface of `egui-snarl`: context menus for the background (to spawn nodes), context menus for nodes (to delete them), dropped-wire menus (to create a pre-connected node from a dragged wire), hover popups, node selection, and keyboard shortcuts. This chapter brings together the input handling from [Chapter 7](./ch07-input-menus.md) and the pin/connection model from [Chapter 9](./ch09-nodes-pins.md) and [Chapter 10](./ch10-connections.md).

## The Menu Hooks on `SnarlViewer`

`egui-snarl` exposes five pairs of `has_*`/`show_*` hooks for context menus and popups. Each `has_*` method returns `bool` (do we want this menu at all?); each `show_*` method builds the menu's contents into a `&mut egui::Ui`:

| Hook pair | Trigger | Typical use |
|---|---|---|
| `has_graph_menu` / `show_graph_menu` | Right-click on empty canvas. | "Add Node" palette. |
| `has_node_menu` / `show_node_menu` | Right-click on a node. | Delete, duplicate, rename. |
| `has_dropped_wire_menu` / `show_dropped_wire_menu` | A wire is dragged to empty space and released. | Create a node pre-wired to the dropped pin. |
| `has_on_hover_popup` / `show_on_hover_popup` | Pointer lingers over a node. | Tooltip / description. |

All the `show_*` methods receive a `NodeId` (or, for the graph menu, a `Pos2`) and a `&mut Snarl<T>`, so they can both read and mutate the graph directly. This is the same inline-mutation pattern from [Chapter 9](./ch09-nodes-pins.md): no event queue, no deferred command — you mutate the `Snarl` right there.

## The Graph Menu: Spawning Nodes

`show_graph_menu` receives `pos: Pos2` — the screen-space point where the user right-clicked — plus the usual `ui` and `snarl`. The natural implementation builds an "Add Node" palette: one button per node type, and `insert_node(pos, node)` on click. Crucially, the new node appears *exactly where the user clicked*, because we pass `pos` straight through:

```rust,no_run
use egui_snarl::{Snarl, ui::SnarlViewer};

impl SnarlViewer<DemoNode> for DemoViewer {
    fn has_graph_menu(&mut self, _pos: egui::Pos2, _snarl: &mut Snarl<DemoNode>) -> bool {
        true // always offer the menu
    }

    fn show_graph_menu(
        &mut self,
        pos: egui::Pos2,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<DemoNode>,
    ) {
        ui.label("Add node");

        if ui.button("Number").clicked() {
            snarl.insert_node(pos, DemoNode::Number(0.0));
            ui.close();
        }
        if ui.button("Text").clicked() {
            snarl.insert_node(pos, DemoNode::Text(String::new()));
            ui.close();
        }
        if ui.button("Concat").clicked() {
            snarl.insert_node(pos, DemoNode::Concat);
            ui.close();
        }
        if ui.button("Sink").clicked() {
            snarl.insert_node(pos, DemoNode::Sink);
            ui.close();
        }
    }
}
```

`ui.close()` closes the popup after a click so the menu does not linger. `Snarl::insert_node(pos, node) -> NodeId` returns the new node's id; you usually ignore it here, but if you want to *pre-wire* the new node (as we do in the dropped-wire menu below), capture the id.

> **Tip:** Right-click spawns the node where you clicked. If you would rather offset slightly so the new node does not sit under the cursor (and thus immediately get a hover popup), add a small delta: `snarl.insert_node(pos + egui::vec2(10.0, 10.0), node)`.

## Building an "Add Node" Palette

For a larger graph with many node types, a flat list of buttons gets long. You can group them with `egui::CollapsingHeader` or split by category. A simple, readable approach is a small table of buttons:

```rust,no_run
fn show_graph_menu(&mut self, pos: egui::Pos2, ui: &mut egui::Ui, snarl: &mut Snarl<DemoNode>) {
    ui.heading("Add Node");
    ui.separator();
    egui::Grid::new("add-node-grid").num_columns(2).show(ui, |ui| {
        if ui.button("Number").clicked() {
            snarl.insert_node(pos, DemoNode::Number(0.0));
            ui.close();
        }
        if ui.button("Text").clicked() {
            snarl.insert_node(pos, DemoNode::Text(String::new()));
            ui.close();
        }
        if ui.button("Concat").clicked() {
            snarl.insert_node(pos, DemoNode::Concat);
            ui.close();
        }
        if ui.button("Sink").clicked() {
            snarl.insert_node(pos, DemoNode::Sink);
            ui.close();
        }
    });
}
```

The `Grid` from [Chapter 4](./ch04-layout-widgets.md) keeps the palette tidy. As your node count grows, factor the list into a `Vec<(name, constructor)>` and iterate — a closure that builds the node. The Rust Book's [Chapter 13](https://doc.rust-lang.org/stable/book/ch13-01-closures.html) covers closures, which are the natural fit for "a thing that makes a `DemoNode`."

## The Node Menu: Deleting Nodes

`show_node_menu` receives the node id of the right-clicked node. A minimal menu offers "Remove":

```rust,no_run
fn has_node_menu(&mut self, _node: &DemoNode) -> bool {
    true
}

fn show_node_menu(
    &mut self,
    node_id: egui_snarl::NodeId,
    ui: &mut egui::Ui,
    snarl: &mut Snarl<DemoNode>,
) {
    if ui.button("Remove node").clicked() {
        // remove_node returns the node data; wires are cleaned up automatically.
        let _removed = snarl.remove_node(node_id);
        ui.close();
    }
}
```

`Snarl::remove_node(node_id) -> T` removes the node and returns its data by ownership (Rust Book [Chapter 4.1](https://doc.rust-lang.org/stable/book/ch04-01-what-is-ownership.html)). Every wire that touched the node's pins is dropped automatically — downstream inputs now have one fewer entry in `remotes`. As we noted in [Chapter 10](./ch10-connections.md), your `show_input` must handle the now-empty `remotes` gracefully (showing "—" or a fallback editor).

> **Warning:** `NodeId`s are *recycled*. After `remove_node`, the same numeric id may be handed out to a new node later. Never store a `NodeId` long-term expecting it to keep referring to the same node; resolve ids to data fresh each frame.

## The Dropped Wire Menu

This is one of the nicest UX affordances in `egui-snarl`. When the user drags a wire from a pin and releases it on *empty canvas* (not on another pin), `egui-snarl` offers a menu. You can use it to create a node and pre-wire it to the dragged pin in one gesture — the familiar "insert reroute node" of professional editors.

The hook receives an `AnyPins` describing the source pins of the dropped wire. `AnyPins` is an enum with two variants:

```rust,no_run
pub enum AnyPins {
    Out(&[OutPinId]), // the user dragged from one or more output pins
    In(&[InPinId]),   // the user dragged from one or more input pins
}
```

You match on it to decide which node types are compatible and how to wire the new node. For example, dragging from a `Number` output should offer to spawn a `Sink` (which accepts numbers) pre-connected:

```rust,no_run
use egui_snarl::{ui::{AnyPins, SnarlViewer}, InPinId, NodeId, OutPinId, Snarl};

impl SnarlViewer<DemoNode> for DemoViewer {
    fn has_dropped_wire_menu(&mut self, _wires: &AnyPins, _snarl: &Snarl<DemoNode>) -> bool {
        true
    }

    fn show_dropped_wire_menu(
        &mut self,
        pos: egui::Pos2,
        wires: &AnyPins,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<DemoNode>,
    ) {
        match wires {
            AnyPins::Out(pins) => {
                // We dragged from output pin(s). Offer nodes that take an input.
                if let Some(src) = pins.first() {
                    // Read the source type BEFORE mutating, to decide which
                    // buttons to show. Shared borrow ends at the end of the
                    // expression; we copy the result out.
                    let src_type = snarl[src.node].output_type(src.output);
                    ui.label("Insert consumer");
                    if ui.button("Sink").clicked() {
                        let new = snarl.insert_node(pos, DemoNode::Sink);
                        snarl.connect(*src, InPinId { node: new, input: 0 });
                        ui.close();
                    }
                    // Only offer a Text-consuming node if the source is Text.
                    if src_type == Some(DataType::Text)
                        && ui.button("Concat (as input A)").clicked()
                    {
                        let new = snarl.insert_node(pos, DemoNode::Concat);
                        snarl.connect(*src, InPinId { node: new, input: 0 });
                        ui.close();
                    }
                }
            }
            AnyPins::In(pins) => {
                // We dragged from an input pin. Offer source nodes to feed it.
                if let Some(dst) = pins.first() {
                    ui.label("Insert source");
                    if ui.button("Number").clicked() {
                        let new = snarl.insert_node(pos, DemoNode::Number(0.0));
                        snarl.connect(OutPinId { node: new, output: 0 }, *dst);
                        ui.close();
                    }
                    if ui.button("Text").clicked() {
                        let new = snarl.insert_node(pos, DemoNode::Text(String::new()));
                        snarl.connect(OutPinId { node: new, output: 0 }, *dst);
                        ui.close();
                    }
                }
            }
        }
    }
}
```

This is *context-aware* node creation: the menu filters itself to compatible types based on the dropped wire. The `match` on `AnyPins` — an enum, as in the Rust Book's [Chapter 6.1](https://doc.rust-lang.org/stable/book/ch06-01-defining-an-enum.html) — cleanly separates the two directions. Note we read the source type *before* mutating, then use it to gate which buttons appear; once a button is clicked we mutate (insert + connect) and close the menu.

> **Tip:** Because `connect` goes through your *own* overridden `connect` (from [Chapter 10](./ch10-connections.md)), the pre-wired connection is automatically type-validated. If you offer a button for an incompatible type by mistake, the `connect` will simply return `false` and no wire appears — a free safety net.

## Node Selection

`egui-snarl` tracks which nodes are selected (click a node to select it; Shift-click or drag a box to multi-select). The selected ids are queryable via `egui_snarl::ui::get_selected_nodes(id, ctx)`, which returns a `Vec<NodeId>`:

```rust,no_run
use egui_snarl::ui;
use eframe::egui;

impl eframe::App for SnarlApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::Panel::right("selection-panel").show_inside(ui, |ui| {
            ui.heading("Selection");
            let selected = ui::get_selected_nodes(egui::Id::new("demo-snarl"), ui.ctx());
            if selected.is_empty() {
                ui.label("(nothing selected)");
            } else {
                for id in &selected {
                    let node = &self.snarl[*id];
                    ui.label(format!("Node {}: {}", id.0, node.title_str()));
                }
            }
        });

        egui::CentralPanel::default().show_inside(ui, |ui| {
            egui_snarl::SnarlWidget::new()
                .id_salt(egui::Id::new("demo-snarl"))
                .show(&mut self.snarl, &mut self.viewer, ui);
        });
    }
}

impl DemoNode {
    fn title_str(&self) -> &'static str {
        match self {
            DemoNode::Number(_) => "Number",
            DemoNode::Text(_) => "Text",
            DemoNode::Concat => "Concat",
            DemoNode::Sink => "Sink",
        }
    }
}
```

The `Id` passed to `get_selected_nodes` must match the one you gave `SnarlWidget::new().id(...)`. The returned `Vec<NodeId>` is a snapshot for this frame — you can read from it freely. Displaying the current selection in a side panel is a small touch that makes a big difference to usability, and it sets up the "properties" panel pattern from [Chapter 5](./ch05-architecture.md).

> **Note:** `get_selected_nodes` borrows the `Snarl`'s selection state from the `Context`, so it is cheap — no traversal of the graph. Call it every frame; do not cache it across frames.

## Hover Popups

`has_on_hover_popup` / `show_on_hover_popup` fire when the pointer lingers over a node. They are perfect for showing a description of what a node does, without cluttering the node itself:

```rust,no_run
impl SnarlViewer<DemoNode> for DemoViewer {
    fn has_on_hover_popup(&mut self, _node: &DemoNode) -> bool {
        true
    }

    fn show_on_hover_popup(
        &mut self,
        node_id: egui_snarl::NodeId,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<DemoNode>,
    ) {
        let node = &snarl[node_id];
        let desc = match node {
            DemoNode::Number(_) => "A constant number. Drag the value to edit it.",
            DemoNode::Text(_) => "A constant string. Type to edit it.",
            DemoNode::Concat => "Joins two text inputs into one output.",
            DemoNode::Sink => "Displays its connected input value.",
        };
        ui.label(desc);
    }
}
```

Keep popups short — they are not modal, they just appear and disappear with the hover. This is the same hover-tooltip idea as `Response::on_hover_text` from [Chapter 7](./ch07-input-menus.md), but here it is a full `Ui` you can build into, so you can show multi-line rich text or even a small live preview.

## Keyboard Shortcuts

`egui-snarl` does not bind keyboard shortcuts by default — you do, via the `egui::Context` input we covered in [Chapter 7](./ch07-input-menus.md). The most useful one is Delete to remove the currently selected nodes.

The cleanest place for this is at the top of your `ui` method, before you build any widgets. The `egui::Ui` gives you its `Context` via `ui.ctx()`, so you can poll input there and mutate the `Snarl` immediately:

```rust,no_run
impl eframe::App for SnarlApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // --- Keyboard shortcuts: run before rendering the widget. ---
        let ctx = ui.ctx().clone();
        let delete_pressed = ctx.input(|i| i.key_pressed(egui::Key::Delete));
        if delete_pressed {
            // Snapshot the selection first: remove_node recycles ids, and we
            // never want to iterate live selection state while mutating.
            let selected: Vec<_> =
                egui_snarl::ui::get_selected_nodes(egui::Id::new("demo-snarl"), &ctx);
            for id in selected {
                self.snarl.remove_node(id);
            }
        }

        // --- Side panel showing the current selection. ---
        egui::Panel::right("sel").show_inside(ui, |ui| {
            ui.heading("Selection");
            let selected = egui_snarl::ui::get_selected_nodes(
                egui::Id::new("demo-snarl"),
                ui.ctx(),
            );
            if selected.is_empty() {
                ui.label("(none)");
            }
            for id in &selected {
                ui.label(format!("Node {}", id.0));
            }
        });

        // --- The graph itself. ---
        egui::CentralPanel::default().show_inside(ui, |ui| {
            egui_snarl::SnarlWidget::new()
                .id_salt(egui::Id::new("demo-snarl"))
                .show(&mut self.snarl, &mut self.viewer, ui);
        });
    }
}
```

Notice the architecture from [Chapter 5](./ch05-architecture.md) at work: the keyboard handling runs at the top of the frame and mutates state (removes nodes), then the widget-building code below it reads the now-updated state. We clone the `Context` (`ui.ctx().clone()`) so the input closure and the subsequent `get_selected_nodes` call can both borrow it without fighting the `&mut self` borrow of `ui` — cloning an `egui::Context` is cheap, it is just an `Arc` handle. We collect the selected ids into a `Vec` *before* the removal loop because removing nodes can recycle ids — operating on a snapshot is safe.

> **Warning:** Do not iterate `selected` while calling `remove_node` if you obtained `selected` as a borrow of live selection state. Always capture into an owned `Vec` first. The borrow rules of [Chapter 4.2](https://doc.rust-lang.org/stable/book/ch04-02-references-and-borrowing.html) protect you here, but a snapshot makes the intent obvious.

## A Complete Interactions Example

Bringing it together, here is a viewer that offers the graph menu palette, the node remove menu, the dropped-wire menu, hover popups, and the `ui`-method delete shortcut — all in one place. We omit the methods we already showed in full in [Chapter 9](./ch09-nodes-pins.md) and [Chapter 10](./ch10-connections.md) for brevity:

```rust,no_run
use eframe::egui;
use egui_snarl::{
    ui::{AnyPins, get_selected_nodes, PinInfo, SnarlViewer},
    InPin, InPinId, NodeId, OutPin, OutPinId, Snarl,
};

#[derive(Default)]
pub struct DemoViewer;

impl SnarlViewer<DemoNode> for DemoViewer {
    # (/* title, inputs, outputs, show_input, show_output, connect, disconnect
          as in chapters 8–10 */)

    fn has_graph_menu(&mut self, _: egui::Pos2, _: &Snarl<DemoNode>) -> bool { true }

    fn show_graph_menu(&mut self, pos: egui::Pos2, ui: &mut egui::Ui, snarl: &mut Snarl<DemoNode>) {
        ui.heading("Add Node");
        ui.separator();
        for (label, node) in [
            ("Number", DemoNode::Number(0.0)),
            ("Text", DemoNode::Text(String::new())),
            ("Concat", DemoNode::Concat),
            ("Sink", DemoNode::Sink),
        ] {
            if ui.button(label).clicked() {
                snarl.insert_node(pos, node);
                ui.close();
            }
        }
    }

    fn has_node_menu(&mut self, _: &DemoNode) -> bool { true }

    fn show_node_menu(&mut self, id: NodeId, ui: &mut egui::Ui, snarl: &mut Snarl<DemoNode>) {
        ui.label(format!("Node {}", id.0));
        ui.separator();
        if ui.button("Remove").clicked() {
            snarl.remove_node(id);
            ui.close();
        }
    }

    fn has_dropped_wire_menu(&mut self, _: &AnyPins, _: &Snarl<DemoNode>) -> bool { true }

    fn show_dropped_wire_menu(
        &mut self, pos: egui::Pos2, wires: &AnyPins,
        ui: &mut egui::Ui, snarl: &mut Snarl<DemoNode>,
    ) {
        match wires {
            AnyPins::Out(pins) => {
                if let Some(src) = pins.first() {
                    if ui.button("New Sink (connected)").clicked() {
                        let n = snarl.insert_node(pos, DemoNode::Sink);
                        snarl.connect(*src, InPinId { node: n, input: 0 });
                        ui.close();
                    }
                }
            }
            AnyPins::In(pins) => {
                if let Some(dst) = pins.first() {
                    if ui.button("New Number (connected)").clicked() {
                        let n = snarl.insert_node(pos, DemoNode::Number(0.0));
                        snarl.connect(OutPinId { node: n, output: 0 }, *dst);
                        ui.close();
                    }
                }
            }
        }
    }

    fn has_on_hover_popup(&mut self, _: &DemoNode) -> bool { true }

    fn show_on_hover_popup(&mut self, id: NodeId, ui: &mut egui::Ui, snarl: &mut Snarl<DemoNode>) {
        let node = &snarl[id];
        let desc = match node {
            DemoNode::Number(_) => "A constant number.",
            DemoNode::Text(_) => "A constant string.",
            DemoNode::Concat => "Joins two text inputs.",
            DemoNode::Sink => "Displays its input.",
        };
        ui.label(desc);
    }
}

pub struct SnarlApp {
    snarl: Snarl<DemoNode>,
    viewer: DemoViewer,
}

impl eframe::App for SnarlApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // Delete-key shortcut: remove selected nodes.
        let ctx = ui.ctx().clone();
        if ctx.input(|i| i.key_pressed(egui::Key::Delete)) {
            let selected = get_selected_nodes(egui::Id::new("demo-snarl"), &ctx);
            for id in selected {
                self.snarl.remove_node(id);
            }
        }

        egui::Panel::right("sel").show_inside(ui, |ui| {
            ui.heading("Selection");
            let selected = get_selected_nodes(egui::Id::new("demo-snarl"), ui.ctx());
            if selected.is_empty() {
                ui.label("(none)");
            }
            for id in &selected {
                ui.label(format!("Node {}", id.0));
            }
        });
        egui::CentralPanel::default().show_inside(ui, |ui| {
            egui_snarl::SnarlWidget::new()
                .id_salt(egui::Id::new("demo-snarl"))
                .show(&mut self.snarl, &mut self.viewer, ui);
        });
    }
}
```

With this in place, the editor is fully interactive: right-click the background to add nodes, right-click a node to remove it, drag a wire to empty space to spawn a pre-connected node, hover a node for a description, and press Delete to remove the current selection.

## The Assembled App

Everything in this part — the panels of [Chapter 4](./ch04-layout-widgets.md), the menus and modal of [Chapter 7](./ch07-input-menus.md), and the snarl viewer of [Chapters 8–11](./ch09-nodes-pins.md) — comes together in one `App`. The reference implementation's `ui/app.rs` is exactly that assembly, so it is worth seeing whole. It owns the `Snarl<DemoNode>` and the `DemoViewer`, plus three ephemeral flags (`settings_open`, `quit_modal_open`, `status`); it renders a top menu bar, a left sidebar of live graph stats, a bottom status bar, and the central snarl canvas, then layers a settings window and a quit-confirmation modal on top.

The `App::new` wires the theme from [Chapter 6](./ch06-theming.md) and the image loaders, and seeds the graph from a small, headlessly-testable helper:

```rust,no_run
// src/ui/app.rs
use crate::theme::EditorTheme;
use crate::ui::viewer::{DemoNode, DemoViewer};
use eframe::egui;
use egui_snarl::{InPinId, OutPinId, Snarl, ui::SnarlWidget};

pub struct App {
    snarl: Snarl<DemoNode>,
    viewer: DemoViewer,
    settings_open: bool,
    quit_modal_open: bool,
    status: String,
}

/// The platform quit shortcut: Cmd+Q on macOS, Ctrl+Q elsewhere.
fn quit_shortcut() -> egui::KeyboardShortcut {
    egui::KeyboardShortcut::new(egui::Modifiers::COMMAND, egui::Key::Q)
}

/// Build the four-node demo graph the app starts with.
/// Extracted from `App::new` so it can be unit-tested headless —
/// `Snarl` is pure data and needs neither a GPU nor an egui `Context`.
fn seed_demo_graph() -> Snarl<DemoNode> {
    let mut snarl = Snarl::new();
    let n = snarl.insert_node(egui::pos2(-280.0, -40.0), DemoNode::Number(42.0));
    let t = snarl.insert_node(egui::pos2(-280.0, 60.0), DemoNode::Text("hello".into()));
    let c = snarl.insert_node(egui::pos2(-40.0, 0.0), DemoNode::Concat);
    let s = snarl.insert_node(egui::pos2(220.0, 0.0), DemoNode::Sink);
    // NB: keep the `connect` calls OUTSIDE `debug_assert!` — its argument is
    // not evaluated in release builds, which would silently drop the wires.
    let wired = snarl.connect(
        OutPinId { node: n, output: 0 },
        InPinId { node: c, input: 0 },
    ) && snarl.connect(
        OutPinId { node: t, output: 0 },
        InPinId { node: c, input: 1 },
    ) && snarl.connect(
        OutPinId { node: c, output: 0 },
        InPinId { node: s, input: 0 },
    );
    debug_assert!(wired, "seed graph connections must not be duplicates");
    snarl
}

impl App {
    pub fn new(
        cc: &eframe::CreationContext<'_>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        EditorTheme::dark().apply(&cc.egui_ctx);
        egui_extras::install_image_loaders(&cc.egui_ctx);

        Ok(Self {
            snarl: seed_demo_graph(),
            viewer: DemoViewer,
            settings_open: false,
            quit_modal_open: false,
            status: "Ready".into(),
        })
    }
}
```

`logic()` handles the quit shortcut and — importantly — intercepts the window's native close button so it routes through the same confirmation modal instead of quitting immediately:

```rust,no_run
impl eframe::App for App {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        ctx.input_mut(|i| {
            if i.consume_shortcut(&quit_shortcut()) {
                self.quit_modal_open = true;
            }
        });

        // The window's native close button must not bypass the confirmation
        // modal: cancel the close and route it through the same modal. If the
        // modal is already open, the request is allowed through (the user is
        // insisting).
        if ctx.input(|i| i.viewport().close_requested()) && !self.quit_modal_open {
            ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
            self.quit_modal_open = true;
        }
    }
    // ui() shown below…
}
```

`ui()` lays the panels out in the order [Chapter 4](./ch04-layout-widgets.md) prescribes — top, left, bottom, then central last — and uses egui 0.35's built-in `Modal` for the quit confirmation (no hand-rolled dimmer needed, unlike the [Chapter 7](./ch07-input-menus.md) example):

```rust,no_run
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // 1) Top menu bar FIRST.
        egui::Panel::top("menu_bar").show(ui, |ui| {
            egui::MenuBar::new().ui(ui, |ui| {
                ui.menu_button("File", |ui| {
                    if ui.button("Reset graph").clicked() {
                        self.snarl = Snarl::new();
                        self.status = "Graph cleared".into();
                        ui.close();
                    }
                    ui.separator();
                    let quit_btn = egui::Button::new("Quit")
                        .shortcut_text(ui.ctx().format_shortcut(&quit_shortcut()));
                    if ui.add(quit_btn).clicked() {
                        self.quit_modal_open = true;
                        ui.close();
                    }
                });
                ui.menu_button("View", |ui| {
                    ui.checkbox(&mut self.settings_open, "Settings");
                });
            });
        });

        // 2) Left sidebar NEXT.
        egui::Panel::left("sidebar")
            .resizable(true)
            .default_size(220.0)
            .min_size(160.0)
            .max_size(400.0)
            .show(ui, |ui| {
                ui.heading("Graph");
                ui.separator();
                ui.label(format!("Nodes: {}", self.snarl.nodes().count()));
                ui.label(format!("Wires: {}", self.snarl.wires().count()));
                ui.separator();
                ui.label("Drag node headers to move.");
                ui.label("Drag background to pan.");
                ui.label("Ctrl+scroll to zoom.");
                ui.label("Drag from a pin to wire.");
            });

        // 3) Bottom status bar: the last event message plus live graph stats.
        egui::Panel::bottom("status_bar")
            .default_size(24.0)
            .resizable(false)
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(format!(
                        "{} · {} nodes · {} wires",
                        self.status,
                        self.snarl.nodes().count(),
                        self.snarl.wires().count()
                    ));
                });
            });

        // 4) Central panel LAST — the node graph canvas.
        egui::CentralPanel::default().show(ui, |ui| {
            SnarlWidget::new()
                .id_salt(egui::Id::new("demo-snarl"))
                .show(&mut self.snarl, &mut self.viewer, ui);
        });

        // --- Settings floating window ---
        if self.settings_open {
            egui::Window::new("Settings")
                .open(&mut self.settings_open)
                .default_pos([140.0, 140.0])
                .resizable(true)
                .show(ui, |ui| {
                    ui.label("Theme: dark (custom)");
                    ui.label(format!("Status: {}", self.status));
                });
        }

        // --- Quit confirmation modal (using egui 0.35's built-in Modal) ---
        if self.quit_modal_open {
            let resp = egui::Modal::new(egui::Id::new("quit_modal")).show(ui.ctx(), |ui| {
                ui.set_min_width(280.0);
                ui.heading("Quit");
                ui.label("Quit the application?");
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    let cancel = ui.button("Cancel").clicked()
                        || ui.input(|i| i.key_pressed(egui::Key::Escape));
                    if cancel {
                        self.quit_modal_open = false;
                    }
                    let quit = ui.button("Quit").clicked()
                        || ui.input(|i| i.key_pressed(egui::Key::Enter));
                    if quit {
                        ui.ctx().send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                });
            });
            if resp.backdrop_response.clicked() {
                self.quit_modal_open = false;
            }
        }
    }
}
```

A couple of details worth calling out. The `App::new` signature takes `&eframe::CreationContext<'_>` and returns `Result<Self, Box<dyn std::error::Error + Send + Sync>>` — the same `Result`-returning `AppCreator` pattern from [Chapter 3](./ch03-first-window.md), so setup failures propagate cleanly. The seed graph is built in a standalone `seed_demo_graph()` function (not inline in `new`) precisely so it can be unit-tested without a `Context`:

```rust,no_run
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_graph_has_four_nodes_and_three_wires() {
        let snarl = seed_demo_graph();
        assert_eq!(snarl.nodes().count(), 4);
        assert_eq!(snarl.wires().count(), 3);
    }
}
```

> **Scope note.** This assembled `App` plus the `DemoViewer` from [Chapter 9](./ch09-nodes-pins.md) and [Chapter 11](./ch11-interactions.md) is the entirety of the reference implementation's interactive editor — it deliberately omits the type-validated `connect` ([Chapter 10](./ch10-connections.md)), the dropped-wire/hover/selection features shown earlier in this chapter, and the custom `SnarlStyle`/`header_frame` of [Chapter 12](./ch12-styling-graph.md). Those are taught as optional enhancements; the shipped demo stays lean. The agent-flow evaluation, streaming, and persistence of Part 4 are *not* in the reference implementation at all — see the introduction's note on scope.

## Summary

In this chapter we wired up the full interaction surface of `egui-snarl`. We built an "Add Node" palette in `show_graph_menu`, a remove action in `show_node_menu`, a context-aware dropped-wire menu that pre-connects new nodes, hover popups, and a side panel showing the current selection. We put the Delete keyboard shortcut at the top of the `ui` method, using the input API from [Chapter 7](./ch07-input-menus.md) and the collect-then-mutate pattern from [Chapter 5](./ch05-architecture.md). The graph is now fully usable.

It is, however, still using the default visual style. In [Chapter 12](./ch12-styling-graph.md) we will build a custom dark theme with color-coded pins, per-node-type colored headers, and a grid background — turning this functional editor into a polished one.
