# Chapter 5: Structuring Your Application

Up to now we have kept every piece of state, every widget, and every bit of logic inside a single `App` struct and a single `ui()` method. That works for a handful of widgets, but it does not scale. In this chapter we'll learn how to split a growing egui application into a clean data model, a rendering layer, and a state-owning app shell — the same kind of separation you saw in the Rust Book when modules were introduced in [Chapter 7](https://doc.rust-lang.org/stable/book/ch07-00-managing-growing-projects-with-packages-crates-and-modules.html). By the end you'll have an architecture that keeps your pure data model free of any GUI dependency, so it can be unit-tested on a headless CI machine without a GPU or a window.

## Why Move Beyond a Single `ui()` Method?

A node-graph editor is a useful example because it mixes three concerns that each want their own home:

- **Persistent data** — the nodes, pins, and links that make up the graph. This data outlives any single frame and is often serialized to disk.
- **Background work** — loading a graph from a file, rendering a preview image, computing a simulation step. These run off the UI thread and deliver results back asynchronously.
- **Ephemeral UI state** — which panel is open, which node is hovered, whether a drag is in progress. This is meaningless without a window and should not live next to the graph data.

If all three live as fields on one giant struct and all logic lives in `ui()`, you end up with a 600-line method that borrows `&mut self` ten different ways in a single frame and fights the borrow checker at every turn. The fix is not cleverer borrowing — it is better structure.

## The `App` Struct as State Owner

In eframe the `App` trait is the entry point the runtime calls every frame. The trait requires:

```rust,no_run
use eframe::egui;

impl eframe::App for MyApp {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        // Read state and build widgets here.
    }
}
```

You may also override `logic()` for work that should happen before any widgets are built — polling async tasks, advancing animations, ticking timers:

```rust,no_run
impl eframe::App for MyApp {
    fn logic(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        // Poll background tasks, advance animations, update timers.
        self.poll_background_tasks(ctx);
        self.advance_animations(ctx);
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        // Build the UI from current state.
        self.draw_graph(ui);
        self.draw_panels(ui);
    }
}
```

The key rule of thumb: **`logic()` mutates state; `ui()` reads state and builds widgets.** If you find yourself mutating persistent data inside `ui()`, ask whether that mutation belongs in `logic()` instead. Interaction *intents* (a button was clicked) are collected in `ui()` and applied in `logic()` on the next frame — more on this below.

The `App` struct owns everything:

```rust,no_run
use std::sync::{Arc, Mutex};

pub struct MyApp {
    /// The graph — persistent, serializable, no egui dependency.
    pub graph: GraphState,
    /// Ephemeral UI flags — never serialized.
    pub ui_state: UiState,
    /// Background task results waiting to be folded into `graph`.
    pub pending: Arc<Mutex<Vec<BackgroundResult>>>,
    /// User configuration.
    pub config: Config,
}
```

## Module Structure

Following the guidance in Rust Book [Chapter 7](https://doc.rust-lang.org/stable/book/ch07-02-modules-and-use-to-control-scope-and-privacy.html), we organize the crate into modules by concern. A layout that works well for a medium-sized egui app looks like this:

```text
src/
├── main.rs              // entry point, eframe launch
├── app.rs               // the App struct and logic()/ui() orchestration
├── theme.rs             // visual style, colors, fonts
├── graph/
│   ├── mod.rs           // re-exports
│   ├── model.rs         // NodeId, Pin, Node, Link — pure data
│   └── state.rs         // GraphState — ID allocation, mutations
└── ui/
    ├── mod.rs           // re-exports
    ├── graph_view.rs    // renders the graph canvas
    └── panels.rs        // side panels, toolbar
```

The important boundary is between `graph/` and `ui/`:

- `graph/` depends on `serde` and nothing else GUI-related. It compiles and tests on a machine with no display.
- `ui/` depends on `egui` and on `graph/`. It turns `GraphState` into pixels.

This is the same "separate the library from the binary" idea described in Rust Book [Chapter 7](https://doc.rust-lang.org/stable/book/ch07-01-packages-and-crates-for-making-libraries-and-executables.html) and it pays off the moment you want to write property tests against your graph model.

## The Graph Data Model

Let's define the core types. These are plain Rust structs with `serde` derives — no `egui` anywhere.

```rust,no_run
// src/graph/model.rs
use serde::{Deserialize, Serialize};

/// A newtype around `u64` identifying a node.
///
/// This is the "newtype idiom" from Rust Book
/// [Ch. 19.3](https://doc.rust-lang.org/stable/book/ch19-03-advanced-traits.html#using-the-newtype-pattern-to-implement-external-traits).
/// Wrapping the raw integer gives us a distinct type the compiler can
/// check, so you can never accidentally pass a `LinkId` where a `NodeId`
/// is expected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodeId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LinkId(pub u64);

/// An input or output socket on a node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pin {
    pub id: u64,
    pub name: String,
    pub kind: PinKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PinKind {
    Input,
    Output,
}

/// A node in the graph — pure data. Position is stored here because it
/// is part of the saved document, but it is the *only* UI-ish field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub title: String,
    pub pins: Vec<Pin>,
    pub position: [f64; 2],
}

/// A connection between an output pin and an input pin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    pub id: LinkId,
    pub from_node: NodeId,
    pub from_pin: u64,
    pub to_node: NodeId,
    pub to_pin: u64,
}
```

> **Tip:** Keep `position` in the model only if you consider layout part of the document. If layout is purely cosmetic, move it into a side-table in `UiState` keyed by `NodeId`. That keeps the document format stable when users rearrange nodes.

### `GraphState` and ID Allocation

`GraphState` owns the nodes, links, and the counters that mint new IDs. IDs are **monotonically incrementing and never recycled**. Recycling IDs is a classic source of bugs: a stale link that referenced a deleted node suddenly points at a brand-new, unrelated node. By never recycling, a dangling `NodeId` is harmless — it simply refers to nothing.

```rust,no_run
// src/graph/state.rs
use super::model::{LinkId, Link, Node, NodeId};
use std::collections::HashMap;

#[derive(Debug, Default)]
pub struct GraphState {
    pub nodes: HashMap<NodeId, Node>,
    pub links: HashMap<LinkId, Link>,
    next_node_id: u64,
    next_link_id: u64,
}

impl GraphState {
    pub fn add_node(&mut self, title: impl Into<String>, position: [f64; 2]) -> NodeId {
        let id = NodeId(self.next_node_id);
        self.next_node_id += 1;
        self.nodes.insert(
            id,
            Node {
                id,
                title: title.into(),
                pins: Vec::new(),
                position,
            },
        );
        id
    }

    pub fn add_link(
        &mut self,
        from_node: NodeId,
        from_pin: u64,
        to_node: NodeId,
        to_pin: u64,
    ) -> LinkId {
        let id = LinkId(self.next_link_id);
        self.next_link_id += 1;
        self.links.insert(
            id,
            Link {
                id,
                from_node,
                from_pin,
                to_node,
                to_pin,
            },
        );
        id
    }

    pub fn remove_node(&mut self, id: NodeId) {
        self.nodes.remove(&id);
        // Remove links that referenced this node. IDs are not recycled,
        // so any surviving references are simply gone.
        self.links
            .retain(|_, l| l.from_node != id && l.to_node != id);
    }
}
```

Because `GraphState` has no `egui` dependency, you can write a normal `#[test]` against it:

```rust,no_run
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removing_a_node_drops_its_links() {
        let mut g = GraphState::default();
        let a = g.add_node("A", [0.0, 0.0]);
        let b = g.add_node("B", [100.0, 0.0]);
        let _link = g.add_link(a, 0, b, 0);
        assert_eq!(g.links.len(), 1);
        g.remove_node(a);
        assert!(g.links.is_empty());
    }
}
```

That test runs anywhere Rust runs — no GPU, no window, no display server.

## The `logic()` vs `ui()` Split in Practice

egui is *immediate mode*: every frame you rebuild the entire UI from current state. The `logic()` / `ui()` split maps cleanly onto two phases:

1. **`logic()` runs first.** Advance animations, poll background tasks, apply queued intents. This is where `&mut self` mutations of *persistent* data belong.
2. **`ui()` runs second.** Read state, build widgets, collect new intents (button clicks, drag deltas) for next frame's `logic()`.

```rust,no_run
// src/app.rs
use eframe::egui;
use std::sync::{Arc, Mutex};

pub struct MyApp {
    pub graph: GraphState,
    pub ui_state: UiState,
    pub pending: Arc<Mutex<Vec<BackgroundResult>>>,
}

/// An intent collected from the UI, to be applied in `logic()`.
pub enum Intent {
    DeleteNode(NodeId),
    AddLink(NodeId, u64, NodeId, u64),
}

impl eframe::App for MyApp {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // 1. Fold in background results.
        let mut pending = self.pending.lock().unwrap();
        for result in pending.drain(..) {
            self.apply_background_result(result);
        }
        drop(pending);

        // 2. Apply intents collected last frame.
        for intent in self.ui_state.intents.drain(..) {
            match intent {
                Intent::DeleteNode(id) => self.graph.remove_node(id),
                Intent::AddLink(a, ap, b, bp) => {
                    self.graph.add_link(a, ap, b, bp);
                }
            }
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // Read-only access to graph; collect intents for next frame.
        self.draw_graph(ui);
        self.draw_panels(ui);
    }
}
```

The `intents` buffer decouples "the user clicked delete" from "delete the node." That decoupling is what lets `ui()` stay mostly immutable and keeps the borrow checker happy.

## Async & Background Work

Long-running work — reading a large file, decoding an image, running a simulation — must not happen on the UI thread or the frame rate collapses. The pattern is:

1. **Spawn** the work on another thread.
2. The worker stores its result in a shared `Arc<Mutex<...>>`.
3. The worker calls `ctx.request_repaint()` so egui wakes up to consume the result.
4. **Poll** the shared buffer in `logic()` and fold results into your state.

Because egui repaints on demand, a background thread finishing its work does not by itself cause a frame. The worker must explicitly request one.

```rust,no_run
use eframe::egui;
use std::sync::{Arc, Mutex};
use std::thread;

pub enum BackgroundResult {
    FileLoaded { name: String, bytes: Vec<u8> },
}

impl MyApp {
    /// Spawn a background file read. The result lands in `self.pending`
    /// and a repaint is requested when it arrives.
    pub fn load_file_async(
        &self,
        path: std::path::PathBuf,
        ctx: egui::Context,
        pending: Arc<Mutex<Vec<BackgroundResult>>>,
    ) {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        thread::spawn(move || {
            // Simulate slow I/O.
            let bytes = std::fs::read(&path).unwrap_or_default();
            let result = BackgroundResult::FileLoaded { name, bytes };
            {
                let mut buf = pending.lock().unwrap();
                buf.push(result);
            }
            // Wake the UI so logic() can drain the buffer this frame.
            ctx.request_repaint();
        });
    }

    fn apply_background_result(&mut self, result: BackgroundResult) {
        match result {
            BackgroundResult::FileLoaded { name, bytes: _ } => {
                // Parse bytes into the graph, update state, etc.
                self.ui_state.status = format!("Loaded {name}");
            }
        }
    }
}
```

> **Note:** `ctx: egui::Context` is cheaply cloneable and safe to send to another thread — it is wrapped in an `Arc` internally. Cloning it and moving the clone into a thread is the intended way to request repaints from background work. This mirrors the "shared state with `Arc<Mutex<T>>`" pattern from Rust Book [Chapter 16](https://doc.rust-lang.org/stable/book/ch16-03-shared-state.html).

For web targets you would use `wasm_bindgen`-friendly async instead of `std::thread`, but the `Arc<Mutex<Vec<_>>>` + `request_repaint()` shape is identical.

## The Collect-Then-Mutate Pattern

The single most useful borrowing technique in egui is **collect, then mutate**. You take an immutable (or carefully scoped) borrow to gather what the user did, end that borrow, and *then* take `&mut self` to apply the changes.

Consider a list of nodes where each can be deleted by a button:

```rust,no_run
impl MyApp {
    fn draw_node_list(&mut self, ui: &mut egui::Ui) {
        // Collect the IDs of nodes whose delete button was clicked.
        let to_delete: Vec<NodeId> = self
            .graph
            .nodes
            .values()
            .filter_map(|node| {
                let mut should_delete = false;
                ui.horizontal(|ui| {
                    ui.label(&node.title);
                    if ui.button("Delete").clicked() {
                        should_delete = true;
                    }
                });
                should_delete.then_some(node.id)
            })
            .collect();

        // Now the immutable borrow of `self.graph.nodes` has ended
        // (it died with `to_delete`'s creation). We can mutate freely.
        for id in to_delete {
            self.graph.remove_node(id);
        }
    }
}
```

The borrow checker is satisfied because `to_delete` owns *copies* of the `NodeId` values (the newtype wraps a `Copy` type). By the time we call `remove_node`, no borrow of `self.graph` is outstanding.

If you instead tried to mutate inside the iterator — `if clicked { self.graph.remove_node(node.id) }` — you would get the classic "cannot borrow `self.graph` as mutable because it is also borrowed as immutable" error described in Rust Book [Chapter 4](https://doc.rust-lang.org/stable/book/ch04-02-references-and-borrowing.html). The collect-then-mutate pattern is the standard remedy.

## Separating UI State from App State

Keep a separate struct for ephemeral, non-serialized UI flags:

```rust,no_run
// src/ui/mod.rs
use crate::graph::model::NodeId;

#[derive(Debug, Default)]
pub struct UiState {
    /// Intents collected this frame, drained in next frame's logic().
    pub intents: Vec<crate::app::Intent>,
    /// Which node, if any, is currently being dragged.
    pub dragged_node: Option<NodeId>,
    /// The currently hovered node, for highlighting.
    pub hovered_node: Option<NodeId>,
    /// Whether the settings panel is open.
    pub settings_open: bool,
    /// A transient status message.
    pub status: String,
}
```

`UiState` is never written to disk; it resets every time the app starts. `GraphState` and `Config`, by contrast, are serialized with `serde`. Keeping them apart means a `#[derive(Serialize)]` on `MyApp` is trivially safe — you simply skip the `ui_state` field with `#[serde(skip)]`:

```rust,no_run
#[derive(serde::Serialize, serde::Deserialize)]
pub struct MyApp {
    pub graph: GraphState,
    pub config: Config,
    #[serde(skip)]
    pub ui_state: UiState,
    #[serde(skip)]
    pub pending: std::sync::Arc<std::sync::Mutex<Vec<BackgroundResult>>>,
}
```

## The Borrow Checker and egui

Holding `&mut self` inside `ui()` lets you reborrow individual fields, which is the key to ergonomic egui code. The two patterns that resolve almost every conflict:

1. **Scoped closures.** `ui.horizontal(|ui| { ... })` takes a closure that borrows `ui` for its duration; when it returns, the borrow ends and you can touch `self` again. This is the closure-capturing behavior from Rust Book [Chapter 13](https://doc.rust-lang.org/stable/book/ch13-01-closures.html).
2. **Collect-then-mutate.** Gather copies of what you need, let the borrow end, then mutate — as shown above.

When a method needs to both read and write `self`, split it: take an immutable borrow in one method that returns data, and a mutable borrow in another that applies it.

```rust,no_run
impl MyApp {
    /// Immutable: figure out what the user wants to drag.
    fn collect_drag(&self, ui: &mut egui::Ui) -> Option<(NodeId, [f64; 2])> {
        self.graph.nodes.values().find_map(|node| {
            let resp = ui.add(egui::Label::new(&node.title));
            if resp.dragged() {
                Some((node.id, resp.drag_delta().into()))
            } else {
                None
            }
        })
    }

    /// Mutable: apply the drag.
    fn apply_drag(&mut self, id: NodeId, delta: [f64; 2]) {
        if let Some(node) = self.graph.nodes.get_mut(&id) {
            node.position[0] += delta[0];
            node.position[1] += delta[1];
        }
    }
}
```

Called back-to-back, these never conflict:

```rust,no_run
if let Some((id, delta)) = self.collect_drag(ui) {
    self.apply_drag(id, delta);
}
```

---

With our application now cleanly split into a testable data model, a rendering layer, and a state-owning shell, the next concern is making it look good. In [Chapter 6](./ch06-theming.md) we'll cover theming — visuals, style, fonts, and custom color palettes — so your application can have a cohesive look instead of egui's defaults.
