# Chapter 8: Introducing egui-snarl

So far we have built conventional egui applications — windows, panels, menus, dialogs. Now we turn to a different kind of widget: the *node graph*. A node graph is a canvas where the user places boxes (nodes), connects them with wires, and edits data visually. This is the foundation of visual scripting, shader graphs, material editors, and — as we will see in Part 4 — agentic AI flows. In this chapter we introduce the `egui-snarl` crate, learn its core concepts, and build a minimal working graph editor. This chapter assumes you have read [Chapter 5](./ch05-architecture.md) on structuring your app and [Chapter 7](./ch07-input-menus.md) on input and menus.

## What Is a Node Graph?

A node graph is a two-dimensional canvas on which the user manipulates *nodes* and *wires*. Each node is a small panel that holds some data — a number, a string, a function — and exposes *pins*: input endpoints on the left and output endpoints on the right. The user draws *wires* from an output pin to an input pin to feed data from one node into another. The result is a directed graph that the program can evaluate.

You have seen node graphs if you have ever used a shader editor (like Blender's shader nodes), a visual scripting system (like Unreal's Blueprints), or a compositing tool (like Nuke). They are powerful because they let the user express *structure* — what connects to what — visually, while keeping *values* editable in place.

The `egui-snarl` crate, written by Alex Krepa, gives egui a reusable node-graph widget. It handles the hard parts — dragging nodes, panning and zooming the canvas, drawing wires, hit-testing pins — and leaves the *content* of each node up to you.

> **Note:** `egui-snarl` 0.11.0 officially targets egui 0.34, but it works cleanly with egui 0.35.0, the version this book uses. If you encounter a breaking change in a future egui release, check the crate's repository for an updated release.

## Core Concepts

`egui-snarl` is built around four concepts. Understanding how they relate is the key to everything that follows.

- **`Snarl<T>`** — the container that owns all nodes, their positions, and their wires. It is generic over a *node data type* `T`, which is usually an enum representing your different kinds of node. `Snarl<T>` is plain data: it knows nothing about rendering. This separation mirrors the data/UI split we established in [Chapter 5](./ch05-architecture.md).
- **Node** — a single node is a piece of `T` data plus a screen-space position (`Pos2`). You never manipulate a "node struct" directly; instead you talk to the `Snarl` through a `NodeId`, and you read the node's data by indexing: `snarl[node_id]`.
- **Pins** — the input and output endpoints of a node. A pin is identified by an `InPinId { node: NodeId, input: usize }` or `OutPinId { node: NodeId, output: usize }`. The `input`/`output` index is the *ordinal* of the pin on its node — pin 0, pin 1, and so on. How many pins a node has is decided by your viewer (more on this below).
- **Wires** — a connection from an `OutPinId` to an `InPinId`. A single input pin can receive multiple wires (its `remotes` is a `Vec`), and a single output pin can fan out to many inputs.

The container is generic and the rendering is pluggable, so `egui-snarl` never needs to know what your nodes *mean*. It only needs to know how many pins each node has and how to draw them — and that is the job of the `SnarlViewer` trait.

## The `SnarlViewer<T>` Trait

`SnarlViewer<T>` is a trait you implement on your own struct to drive the UI for each node. The trait is generic over the same `T` as the `Snarl`, so a single viewer knows how to render every node type in your graph. This is the central design idea of `egui-snarl`: **the graph data (`Snarl<T>`) and the rendering logic (`SnarlViewer<T>`) are separate objects.**

This is the same separation of concerns the Rust Book calls out when introducing traits in [Chapter 10](https://doc.rust-lang.org/stable/book/ch10-02-traits.html): a trait defines shared behavior that can be implemented for many types, decoupling *what* a type can do from *how* a specific type does it. Here, `SnarlViewer` is the abstraction, and your concrete struct is one implementation of it.

The trait has five required methods:

```rust,no_run
use egui_snarl::{Snarl, InPin, OutPin, ui::{SnarlPin, SnarlViewer}};

impl<T> SnarlViewer<T> for MyViewer {
    /// The title shown in the node's header.
    fn title(&mut self, node: &T) -> String;
    /// How many input pins this node has.
    fn inputs(&mut self, node: &T) -> usize;
    /// How many output pins this node has.
    fn outputs(&mut self, node: &T) -> usize;
    /// Render one input pin. Returns a `PinInfo` describing how the pin is drawn.
    fn show_input(
        &mut self,
        pin: &InPin,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<T>,
    ) -> impl SnarlPin + 'static;
    /// Render one output pin. Returns a `PinInfo` describing how the pin is drawn.
    fn show_output(
        &mut self,
        pin: &OutPin,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<T>,
    ) -> impl SnarlPin + 'static;
}
```

The trait also provides a large set of *provided* methods with sensible defaults — `connect`, `disconnect`, `show_header`, `has_body`/`show_body`, `has_footer`/`show_footer`, context-menu hooks, and more — which we will explore in later chapters.

> **Warning:** `SnarlViewer` is **not** `dyn`-compatible. The `show_input` and `show_output` methods return `impl SnarlPin + 'static`, which uses `impl Trait` in return position. A trait object (`Box<dyn SnarlViewer<T>>`) cannot be constructed. You must implement the trait on a *concrete struct*, not behind a trait object. This is a Rust limitation discussed alongside trait objects in [Chapter 18](https://doc.rust-lang.org/stable/book/ch18-04-advanced-types.html) of the Rust Book.

## Why the Viewer Trait?

You might wonder why `egui-snarl` does not simply give you a `Node` struct with fields you fill in. The reason is flexibility. By moving rendering into a trait, `egui-snarl` lets you:

- Store *pure data* in `Snarl<T>` — no widgets, no `egui::Ui`, no colors. Your graph can be serialized, sent across a thread boundary, or unit-tested without a GPU. This is the data/UI split from [Chapter 5](./ch05-architecture.md) in action.
- Swap the *look* of the graph without touching the data. A "compact" viewer and a "verbose" viewer can render the same `Snarl<T>`.
- Keep the borrow checker happy. Because the viewer owns no persistent state — it just receives `&mut Snarl<T>` per call — you never end up holding overlapping borrows of the graph during rendering.

## Adding egui-snarl to Your Project

Add the crate to your `Cargo.toml`. We enable the `serde` feature from the start because we will want to serialize graphs in [Chapter 16](./ch16-persistence.md):

```toml
[dependencies]
eframe = "0.35.0"
egui-snarl = { version = "0.11.0", features = ["serde"] }
serde = { version = "1.0", features = ["derive"] }

[package]
edition = "2024"
rust-version = "1.92.0"
```

The `serde` feature implements `Serialize`/`Deserialize` for `Snarl<T>` and its supporting types (as long as your `T` is also `Serialize`/`Deserialize`). If you skip the feature, the graph still works — you just cannot persist it to disk.

> **Note:** `egui-snarl` 0.11.0 declares `egui = "0.34"` as a dependency, but because egui's public API is stable across the 0.34 → 0.35 boundary for the surface area `egui-snarl` uses, the two coexist without conflict. Cargo resolves them to compatible versions as long as your `eframe` 0.35.0 pulls in `egui` 0.35.0.

## Defining a Node Enum

The node data type `T` is almost always an enum — one variant per kind of node. This is a direct application of Rust's enums as described in the Rust Book's [Chapter 6](https://doc.rust-lang.org/stable/book/ch06-01-defining-an-enum.html): an enum lets you say "this value is one of these several things, each of which may carry different data."

Let us define a small set of demo nodes: a `Number` node that holds an `f64`, a `Text` node that holds a `String`, and a `Sink` node that displays whatever is connected to it:

```rust,no_run
use serde::{Deserialize, Serialize};

/// Every node in our graph is one of these variants.
#[derive(Serialize, Deserialize)]
pub enum DemoNode {
    /// A constant number the user can edit.
    Number(f64),
    /// A constant string the user can edit.
    Text(String),
    /// A display node: shows the value wired into it.
    Sink,
}
```

Each variant carries the *editable state* of that node kind. A `Number` node remembers its value; a `Sink` node has no state of its own because it only displays what it receives. Notice we derive `Serialize` and `Deserialize` — that is the whole reason we enabled the `serde` feature. We will lean on ownership and borrowing (Rust Book [Chapter 4](https://doc.rust-lang.org/stable/book/ch04-00-understanding-ownership.html)) heavily: nodes own their `String`s, and the viewer borrows them during rendering rather than copying.

## Creating the App

Now we build the `App` struct. It owns two things: the `Snarl<DemoNode>` (our persistent graph data) and a `DemoViewer` (the rendering logic, which holds no persistent state — it is a zero-sized marker in this minimal example, but in real apps it may hold transient state like a pending drag). We follow the architecture from [Chapter 5](./ch05-architecture.md): the `App` owns everything, and `ui()` reads state and builds widgets.

```rust,no_run
use eframe::egui;
use egui_snarl::{Snarl, ui::SnarlViewer};

/// The viewer. Holds no persistent state in this minimal example.
#[derive(Default)]
pub struct DemoViewer;

pub struct SnarlApp {
    snarl: Snarl<DemoNode>,
    viewer: DemoViewer,
}

impl Default for SnarlApp {
    fn default() -> Self {
        let mut snarl = Snarl::new();
        // Seed the graph with a couple of nodes so it is not empty.
        let n = snarl.insert_node(egui::pos2(-120.0, -40.0), DemoNode::Number(42.0));
        let s = snarl.insert_node(egui::pos2(120.0, -40.0), DemoNode::Sink);
        // Connect the number node's output 0 to the sink's input 0.
        snarl.connect(
            egui_snarl::OutPinId { node: n, output: 0 },
            egui_snarl::InPinId { node: s, input: 0 },
        );
        Self {
            snarl,
            viewer: DemoViewer::default(),
        }
    }
}
```

`Snarl::new()` creates an empty container. `snarl.insert_node(pos, node)` returns a `NodeId` — an opaque, stable identifier you use to refer to the node later. `snarl.connect(from, to)` wires an output pin to an input pin and returns `true` if the connection was created.

> **Tip:** `NodeId` is a `Copy` type (a wrapper around a `usize` index), so you can pass it around freely without borrowing. The same is true of `InPinId` and `OutPinId`. Keep in mind, though, that a `NodeId` only remains valid as long as the node exists — if you `remove_node`, the id is recycled.

## Showing the Graph

Rendering the graph is a single chain of builder calls inside `CentralPanel`. The `SnarlWidget` is the widget `egui-snarl` provides; it takes a stable `egui::Id` (required so the widget can keep track of drags and selection state across frames), an optional `SnarlStyle`, and finally borrows your `Snarl` and your viewer:

```rust,no_run
use eframe::egui;
use egui_snarl::ui::SnarlWidget;

impl eframe::App for SnarlApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        eframe::egui::CentralPanel::default().show_inside(ui, |ui| {
            SnarlWidget::new()
                .id_salt(egui::Id::new("demo-snarl"))
                .show(&mut self.snarl, &mut self.viewer, ui);
        });
    }
}
```

That is the entire render path. The widget handles panning (drag the background), zooming (Ctrl + scroll), dragging nodes (drag a node header), and drawing wires (drag from a pin). Your only job is to answer the trait's questions: *what is this node's title? how many pins does it have? how should each pin be drawn?*

The stable `Id` is essential. egui requires that stateful widgets have an `Id` so their interaction state survives across frames; we discussed the role of `Id` in [Chapter 4](./ch04-layout-widgets.md). If you forget it, the widget will panic at runtime.

## Implementing the Required Viewer Methods

Now we fill in the five required methods. This is where the node content lives.

### `title`, `inputs`, `outputs`

These three are straightforward. They take `&T` (the node data) and return static information about the node:

```rust,no_run
use egui_snarl::ui::SnarlViewer;

impl SnarlViewer<DemoNode> for DemoViewer {
    fn title(&mut self, node: &DemoNode) -> String {
        match node {
            DemoNode::Number(_) => "Number".to_string(),
            DemoNode::Text(_) => "Text".to_string(),
            DemoNode::Sink => "Sink".to_string(),
        }
    }

    fn inputs(&mut self, node: &DemoNode) -> usize {
        match node {
            DemoNode::Number(_) => 0, // a source has no inputs
            DemoNode::Text(_) => 0,
            DemoNode::Sink => 1,      // the sink takes one input
        }
    }

    fn outputs(&mut self, node: &DemoNode) -> usize {
        match node {
            DemoNode::Number(_) => 1, // a number provides one output
            DemoNode::Text(_) => 1,
            DemoNode::Sink => 0,      // the sink provides nothing
        }
    }

    // show_input and show_output follow below.
    # (/* … */)
}
```

Notice how `match` on the enum — covered in the Rust Book's [Chapter 6.2](https://doc.rust-lang.org/stable/book/ch06-02-match.html) — drives every decision: the title, the pin count, and (below) the rendering. The number of pins is a *function of the variant*, not a stored field. This is a strength of the enum approach: you cannot accidentally give a `Sink` an output pin, because the `match` arm for `Sink` returns `0` and there is no field to get out of sync.

### `show_input` and `show_output`

These two methods render a single pin. They receive a pin handle (`&InPin` or `&OutPin`), a `&mut egui::Ui` scoped to that pin's row, and a `&mut Snarl<T>` so you can read or mutate node data inline. They return a `PinInfo`, which describes how the pin itself (the little dot on the node border) is drawn.

Let us start with the output side, which is simpler — when nothing is connected, we show an editable widget for the node's value:

```rust,no_run
use egui_snarl::{ui::{PinInfo, SnarlPin}, InPin, OutPin};

impl SnarlViewer<DemoNode> for DemoViewer {
    # (/* title, inputs, outputs as above */)

    fn show_output(
        &mut self,
        pin: &OutPin,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<DemoNode>,
    ) -> impl SnarlPin + 'static {
        // Index into the node data for this pin's node.
        let node = &mut snarl[pin.id.node];
        match node {
            DemoNode::Number(value) => {
                // Editable widget when nothing is wired.
                ui.add(egui::DragValue::new(value).speed(0.1));
                PinInfo::circle().with_fill(egui::Color32::from_rgb(220, 80, 80))
            }
            DemoNode::Text(s) => {
                ui.text_edit_singleline(s);
                PinInfo::circle().with_fill(egui::Color32::from_rgb(80, 200, 80))
            }
            DemoNode::Sink => {
                // Sink has no outputs; this method is never called for it.
                unreachable!("Sink has no output pins")
            }
        }
    }

    fn show_input(
        &mut self,
        pin: &InPin,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<DemoNode>,
    ) -> impl SnarlPin + 'static {
        // Only the Sink has an input pin (index 0).
        let node = &mut snarl[pin.id.node];
        if let DemoNode::Sink = node {
            // If something is wired in, show the source value; otherwise show "—".
            if let Some(remote) = pin.remotes.first() {
                let src = &snarl[remote.node];
                match src {
                    DemoNode::Number(v) => {
                        ui.label(format!("{v}"));
                    }
                    DemoNode::Text(s) => {
                        ui.label(s);
                    }
                    DemoNode::Sink => {}
                }
                PinInfo::circle().with_fill(egui::Color32::from_rgb(220, 80, 80))
            } else {
                ui.label("—");
                PinInfo::circle().with_fill(egui::Color32::from_rgb(120, 120, 120))
            }
        } else {
            unreachable!("only Sink has input pins")
        }
    }
}
```

Let us unpack the two ideas this code introduces, because they recur throughout the rest of the book.

**The borrow pattern.** `show_input` and `show_output` receive `&mut Snarl<T>`. Inside, we index with `snarl[pin.id.node]` — this uses the `IndexMut` impl that `Snarl` provides — to get a `&mut DemoNode` for the node the pin belongs to. We then edit the node *inline*: dragging the `DragValue` mutates `DemoNode::Number`'s `f64` directly; typing in the text box mutates `DemoNode::Text`'s `String`. There is no copy, no commit step, no separate "edit buffer." This is ownership and borrowing (Rust Book [Chapter 4](https://doc.rust-lang.org/stable/book/ch04-00-understanding-ownership.html)) working in our favor: the borrow is short-lived (only for the duration of this method call), so the graph remains free for the next pin's render.

**Reading connected values via `remotes`.** The `InPin` has a `remotes: Vec<OutPinId>` — the output pins that are wired into this input. To display the value a `Sink` receives, we look at `pin.remotes.first()`, take the source `OutPinId`, and index into `snarl[remote.node]` to read the source node's data. `OutPin` has the mirror field: `remotes: Vec<InPinId>`, the inputs this output feeds. We will explore this fully in [Chapter 9](./ch09-nodes-pins.md).

`PinInfo::circle().with_fill(color)` returns a `PinInfo` describing a round pin filled with the given color. There are also `.square()` and `.triangle()` shapes, and a `.with_wire_style(...)` modifier we will meet in [Chapter 12](./ch12-styling-graph.md). Color-coding pins by data type is a cheap and effective bit of visual design: red for numbers, green for text, and so on.

## A Minimal Working Example

Putting it all together, here is the complete, runnable-looking file. Save it as `src/main.rs` and run `cargo run`:

```rust,no_run
use eframe::egui;
use egui_snarl::{
    ui::{PinInfo, SnarlPin, SnarlViewer, SnarlWidget},
    InPin, InPinId, OutPin, OutPinId, Snarl,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub enum DemoNode {
    Number(f64),
    Text(String),
    Sink,
}

#[derive(Default)]
pub struct DemoViewer;

impl SnarlViewer<DemoNode> for DemoViewer {
    fn title(&mut self, node: &DemoNode) -> String {
        match node {
            DemoNode::Number(_) => "Number".to_string(),
            DemoNode::Text(_) => "Text".to_string(),
            DemoNode::Sink => "Sink".to_string(),
        }
    }

    fn inputs(&mut self, node: &DemoNode) -> usize {
        match node {
            DemoNode::Number(_) | DemoNode::Text(_) => 0,
            DemoNode::Sink => 1,
        }
    }

    fn outputs(&mut self, node: &DemoNode) -> usize {
        match node {
            DemoNode::Number(_) | DemoNode::Text(_) => 1,
            DemoNode::Sink => 0,
        }
    }

    fn show_input(
        &mut self,
        pin: &InPin,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<DemoNode>,
    ) -> impl SnarlPin + 'static {
        if let Some(remote) = pin.remotes.first() {
            match &snarl[remote.node] {
                DemoNode::Number(v) => ui.label(format!("{v}")),
                DemoNode::Text(s) => ui.label(s),
                DemoNode::Sink => ui.label(""),
            };
            PinInfo::circle().with_fill(egui::Color32::from_rgb(220, 80, 80))
        } else {
            ui.label("—");
            PinInfo::circle().with_fill(egui::Color32::from_rgb(120, 120, 120))
        }
    }

    fn show_output(
        &mut self,
        pin: &OutPin,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<DemoNode>,
    ) -> impl SnarlPin + 'static {
        let node = &mut snarl[pin.id.node];
        match node {
            DemoNode::Number(value) => {
                ui.add(egui::DragValue::new(value).speed(0.1));
                PinInfo::circle().with_fill(egui::Color32::from_rgb(220, 80, 80))
            }
            DemoNode::Text(s) => {
                ui.text_edit_singleline(s);
                PinInfo::circle().with_fill(egui::Color32::from_rgb(80, 200, 80))
            }
            DemoNode::Sink => unreachable!("Sink has no output pins"),
        }
    }
}

pub struct SnarlApp {
    snarl: Snarl<DemoNode>,
    viewer: DemoViewer,
}

impl Default for SnarlApp {
    fn default() -> Self {
        let mut snarl = Snarl::new();
        let n = snarl.insert_node(egui::pos2(-120.0, -40.0), DemoNode::Number(42.0));
        let s = snarl.insert_node(egui::pos2(120.0, -40.0), DemoNode::Sink);
        snarl.connect(
            OutPinId { node: n, output: 0 },
            InPinId { node: s, input: 0 },
        );
        Self {
            snarl,
            viewer: DemoViewer::default(),
        }
    }
}

impl eframe::App for SnarlApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show_inside(ui, |ui| {
            SnarlWidget::new()
                .id_salt(egui::Id::new("demo-snarl"))
                .show(&mut self.snarl, &mut self.viewer, ui);
        });
    }
}

fn main() -> eframe::Result {
    let options = eframe::NativeOptions::default();
    eframe::run_native(
        "egui-snarl demo",
        options,
        Box::new(|_cc| Ok(Box::<SnarlApp>::default())),
    )
}
```

## Running the Demo

Build and run the project. You should see a canvas with two nodes — a red `Number` node showing `42.0` on the left and a `Sink` node on the right — already wired together. The wire is drawn automatically because we called `snarl.connect` in `default()`. Try the following interactions:

- **Drag a node** by its header to move it around the canvas.
- **Pan the canvas** by dragging the background.
- **Zoom** with Ctrl + scroll wheel.
- **Edit the number** by dragging the `DragValue`. The `Sink` updates immediately because `show_input` reads the source node live, every frame.
- **Break the wire** by right-clicking a pin and choosing to drop it (we will customize these menus in [Chapter 11](./ch11-interactions.md)).

Notice that editing the `Number` node instantly changes what the `Sink` displays. There is no evaluation step, no "apply" button — the viewer simply reads the connected value every frame. In a real graph we will want an explicit *evaluation* pass (Part 4), but for live editing of constants, this read-on-render approach is exactly right.

> **Tip:** If your graph renders but interactions do not work (you cannot drag nodes or draw wires), the most common cause is a missing or duplicated `Id`. Each `SnarlWidget` on screen must have a unique `egui::Id`. Two widgets sharing an id will corrupt each other's interaction state.

## The Viewer Is Not Dyn-Compatible

One last structural point, because it will shape how you organize your code. Because `show_input` and `show_output` return `impl SnarlPin + 'static`, the `SnarlViewer` trait cannot be made into a trait object:

```rust,no_run
// This does NOT compile:
let viewer: Box<dyn egui_snarl::SnarlViewer<DemoNode>> = /* ... */;
```

The compiler error points at the `impl Trait` return types and explains that the trait is not object-safe. This is a fundamental limitation of `impl Trait` in return position, as the Rust Book discusses when covering advanced types in [Chapter 18](https://doc.rust-lang.org/stable/book/ch18-04-advanced-types.html). The practical consequence: implement `SnarlViewer` on a *concrete struct* — `DemoViewer` here — and store that struct by value on your `App`. You cannot hide the viewer behind `Box<dyn>`, and you cannot put different viewer types in a `Vec`. If you need multiple "skins" for the same graph, you have two options: a single viewer that branches internally, or generics over the viewer type.

## Summary

In this chapter we met `egui-snarl` and built our first working node graph. We learned that `Snarl<T>` is a data container, that the `SnarlViewer<T>` trait is the rendering layer, and that the two are deliberately separate so the graph stays pure data. We defined a node enum, implemented the five required trait methods, and rendered a live graph inside `CentralPanel`. The key patterns — indexing `snarl[node_id]` to read or edit node data, and reading `pin.remotes` to display connected values — will recur in every following chapter.

We kept our nodes simple: an editable `Number`, an editable `Text`, and a read-only `Sink`. In [Chapter 9](./ch09-nodes-pins.md) we will dig into the pin rendering pattern in depth — how to draw connected and unconnected pins differently, how to build node bodies and headers, and how to give each node type its own look.
