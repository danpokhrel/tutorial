# Chapter 9: Building Nodes & Pins

In [Chapter 8](./ch08-egui-snarl.md) we built a working node graph with three node types, but we barely scratched the surface of what a node can display. Our `Sink` showed a connected value as a label, and our `Number` node showed a `DragValue` — but real graphs need richer pins, node bodies, colored headers, and the ability to edit values inline. In this chapter we unpack the `show_input`/`show_output` rendering pattern in full, learn the `PinInfo` toolkit, add node bodies and footers, and customize per-node-type headers. By the end you will be able to render nodes that show editable widgets when unconnected and live values when connected — the visual contract of every good node graph.

## The Pin Rendering Pattern

Every pin on every node is rendered by a call to either `show_input` or `show_output` on your viewer. The signatures are fixed by the `SnarlViewer` trait:

```rust,no_run
use egui_snarl::{Snarl, ui::{InPin, OutPin, SnarlPin}};

fn show_input(
    &mut self,
    pin: &InPin,
    ui: &mut egui::Ui,
    snarl: &mut Snarl<DemoNode>,
) -> impl SnarlPin + 'static;

fn show_output(
    &mut self,
    pin: &OutPin,
    ui: &mut egui::Ui,
    snarl: &mut Snarl<DemoNode>,
) -> impl SnarlPin + 'static;
```

Three things come into each call:

- **`pin`** — a handle to the pin being rendered. `InPin` has `.id: InPinId` and `.remotes: Vec<OutPinId>` (the output pins wired into this input). `OutPin` has `.id: OutPinId` and `.remotes: Vec<InPinId>` (the inputs this output feeds). The `remotes` vector is how you know whether a pin is connected and to what.
- **`ui`** — a `&mut egui::Ui` scoped to this pin's row. You build widgets into it just like any other `Ui`: `ui.label(...)`, `ui.add(DragValue::new(...))`, and so on. Whatever you build here becomes the pin's *label*, drawn next to the pin dot.
- **`snarl`** — a `&mut Snarl<T>`. This is what makes inline editing possible: you index `snarl[pin.id.node]` to get a `&mut` to the node's data and mutate it directly while rendering.

The return value, `PinInfo`, tells `egui-snarl` how to draw the *pin itself* — the little dot, square, or triangle on the node's border — and how wires attached to that pin should look. The body widgets you build into `ui` are separate from the pin shape.

> **Tip:** The separation between "pin label" (your `ui` widgets) and "pin shape" (the `PinInfo` you return) is the key to the whole rendering model. The label is *content* — it can be a `DragValue`, a `TextEdit`, a `ComboBox`, anything. The shape is *connection affordance* — its color and form tell the user what kind of data fits here.

## `PinInfo`: Shape, Fill, and Wire Style

`PinInfo` is a small builder-style struct. You start from a shape constructor and chain `.with_fill(color)` and `.with_wire_style(style)`:

```rust,no_run
use egui_snarl::ui::{PinInfo, WireStyle};

// A round red pin with default (bezier) wires.
let red = PinInfo::circle().with_fill(egui::Color32::from_rgb(220, 80, 80));

// A square green pin with axis-aligned (right-angled) wires.
let green = PinInfo::square()
    .with_fill(egui::Color32::from_rgb(80, 200, 80))
    .with_wire_style(WireStyle::AxisAligned { corner_radius: 6.0 });

// A triangle blue pin.
let blue = PinInfo::triangle().with_fill(egui::Color32::from_rgb(80, 120, 220));
```

The shape constructors are:

| Constructor | Shape |
|---|---|
| `PinInfo::circle()` | A filled circle (the most common choice). |
| `PinInfo::square()` | A filled square. |
| `PinInfo::triangle()` | A filled triangle. |

`.with_fill(color)` sets the fill color. `.with_wire_style(WireStyle::AxisAligned { corner_radius })` switches the wires for this pin from the default smooth bezier curve to right-angled segments with rounded corners of the given radius — useful for mimicking the look of professional shader-graph editors. We will go deeper on wire styling in [Chapter 12](./ch12-styling-graph.md).

A useful convention, which we adopt throughout this book, is to color-code pins by data type: red for numbers, green for strings, blue for boolean, and so on. The user learns the color scheme quickly and can scan a graph for type mismatches at a glance.

## Reading Connected Values: `remotes`

The single most important field on a pin handle is `remotes`. For an `InPin`, `remotes` is a `Vec<OutPinId>` — the output pins that are wired into this input, in the order they were connected. For an `OutPin`, `remotes` is a `Vec<InPinId>` — the inputs this output feeds.

To display the value a connected input receives, you look up the source node:

```rust,no_run
use egui_snarl::ui::{InPin, PinInfo, SnarlPin};
use egui_snarl::Snarl;

impl SnarlViewer<DemoNode> for DemoViewer {
    # (/* other methods */)

    fn show_input(
        &mut self,
        pin: &InPin,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<DemoNode>,
    ) -> impl SnarlPin + 'static {
        if let Some(remote) = pin.remotes.first() {
            // `remote` is an `OutPinId`; `remote.node` is the source node id.
            match &snarl[remote.node] {
                DemoNode::Number(v) => ui.label(format!("{v}")),
                DemoNode::Text(s) => ui.label(s),
                DemoNode::Sink => ui.label(""),
            };
            PinInfo::circle().with_fill(egui::Color32::from_rgb(220, 80, 80))
        } else {
            // Unconnected: show a placeholder and a dim pin.
            ui.label("—");
            PinInfo::circle().with_fill(egui::Color32::from_rgb(120, 120, 120))
        }
    }
}
```

Two things are worth pausing on.

First, `pin.remotes` is borrowed from `pin`, which is itself a borrow of the `Snarl`. Because `snarl[remote.node]` needs to borrow `snarl`, you can hit a borrow conflict if you try to hold the borrow from `remotes` while indexing `snarl`. The fix is to extract what you need *first* — here we take `remote` (a `Copy` `OutPinId`) and then drop the borrow of `remotes` before indexing. This is the collect-then-mutate pattern from [Chapter 5](./ch05-architecture.md), and it is the Rust Book's guidance on lifetimes ([Chapter 10.3](https://doc.rust-lang.org/stable/book/ch10-03-lifetime-syntax.html)) applied in practice: keep borrows short.

Second, `pin.remotes` can have more than one entry. An input pin accepts multiple wires by default — `remotes` is a `Vec`, not an `Option`. When there are several, you may want to show them all, or show only the first, or show a count. The `Sink` above shows only the first wired value, but a "merge" node might sum them:

```rust,no_run
let sum: f64 = pin
    .remotes
    .iter()
    .map(|remote| match &snarl[remote.node] {
        DemoNode::Number(v) => *v,
        _ => 0.0,
    })
    .sum();
ui.label(format!("Σ = {sum}"));
```

Here the borrow of `snarl` inside the `.map` closure is shared (`&Snarl`), which is fine because we only *read*. If you needed to *mutate* based on `remotes`, you would first collect the ids into an owned `Vec`, end the borrow of `pin`, then mutate — exactly the pattern we will use in [Chapter 10](./ch10-connections.md).

## Connected vs. Unconnected Pins

The visual contract of a good node graph is: **show an editable widget when a pin is unconnected, and show the live value when it is connected.** The user edits constants directly on source nodes; once a value flows in over a wire, the pin becomes read-only.

For output pins, this is usually automatic — the node *owns* the value, so you always show the editable widget. For input pins, you branch on `remotes.is_empty()`:

```rust,no_run
fn show_input(&mut self, pin: &InPin, ui: &mut egui::Ui, snarl: &mut Snarl<DemoNode>)
    -> impl SnarlPin + 'static
{
    if pin.remotes.is_empty() {
        // No wire: let the user type a value directly into this pin.
        // We mutate the node's own stored fallback value.
        let node = &mut snarl[pin.id.node];
        match node {
            DemoNode::Number(v) => {
                ui.add(egui::DragValue::new(v).speed(0.1));
            }
            DemoNode::Text(s) => {
                ui.text_edit_singleline(s);
            }
            DemoNode::Sink => {
                ui.label("(nothing connected)");
            }
        }
        PinInfo::circle().with_fill(egui::Color32::from_rgb(120, 120, 120))
    } else {
        // Wired: show the source value, read-only.
        if let Some(remote) = pin.remotes.first() {
            let src = &snarl[remote.node];
            match src {
                DemoNode::Number(v) => ui.label(format!("{v}")),
                DemoNode::Text(s) => ui.label(s),
                DemoNode::Sink => ui.label(""),
            };
        }
        PinInfo::circle().with_fill(egui::Color32::from_rgb(220, 80, 80))
    }
}
```

Notice the borrow choreography in the unconnected branch: `pin.id.node` is a `Copy` `NodeId`, so we read it from the (shared) `pin` borrow, then call `&mut snarl[...]` — this works because we have stopped touching `pin.remotes`. The Rust Book's [Chapter 4](https://doc.rust-lang.org/stable/book/ch04-02-references-and-borrowing.html) chapter on references is your friend here: a shared borrow can coexist with nothing mutable, but a mutable borrow stands alone.

## The `show_output` Pattern

Output pins are conceptually simpler because the node *owns* the value. You almost always show an editable widget — the user changes the value, the node stores it, and downstream nodes see the new value over the wire next frame:

```rust,no_run
fn show_output(&mut self, pin: &OutPin, ui: &mut egui::Ui, snarl: &mut Snarl<DemoNode>)
    -> impl SnarlPin + 'static
{
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
```

You *can* also read `pin.remotes` on an output pin to show where the value goes — for example, a tooltip "→ 2 inputs" — but for editable source values the node's own data is the source of truth.

## Node Bodies: `has_body` / `show_body`

So far, the only content on a node has been its pins. But many nodes want a *body*: content drawn between the input pins (left) and output pins (right). `egui-snarl` provides two provided methods for this:

```rust,no_run
impl SnarlViewer<DemoNode> for DemoViewer {
    /// Return true if this node should have a body region.
    fn has_body(&mut self, node: &DemoNode) -> bool {
        matches!(node, DemoNode::Sink)
    }

    /// Draw the body. Receives the node id so you can read/mutate its data.
    fn show_body(
        &mut self,
        node_id: egui_snarl::NodeId,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<DemoNode>,
    ) {
        if let DemoNode::Sink = &snarl[node_id] {
            ui.label("A sink displays its connected value.");
        }
    }
}
```

`has_body` defaults to `false`; override it to `true` and implement `show_body` to add the region. A common use is a live preview — for example, a node that renders a small color swatch computed from its inputs.

## Headers and Footers

Every node has a **header** by default — the bar at the top showing the node's title. The provided method `show_header` draws it; you almost never override it. What you *do* override is `header_frame`, which controls the `egui::Frame` (background, margin, rounding) of the header. We will use this in the next section to give each node type a colored bar.

A node can also have a **footer** — content drawn below the pins. Like the body, it is opt-in:

```rust,no_run
impl SnarlViewer<DemoNode> for DemoViewer {
    fn has_footer(&mut self, node: &DemoNode) -> bool {
        // Show a small status line on every node.
        true
    }

    fn show_footer(
        &mut self,
        node_id: egui_snarl::NodeId,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<DemoNode>,
    ) {
        let node = &snarl[node_id];
        let kind = match node {
            DemoNode::Number(_) => "number",
            DemoNode::Text(_) => "text",
            DemoNode::Sink => "sink",
        };
        ui.label(format!("[{kind}]"));
    }
}
```

Footers are a good place for metadata that does not belong in a pin: a node id, a "muted" badge, an error count. Keep them short — a footer widens the whole node.

## Custom Header Frames per Node Type

`header_frame` returns an `egui::Frame` used for the header of a given node. By matching on the node data, you give each node type a distinct color bar — the visual cue that makes a graph readable at a glance:

```rust,no_run
impl SnarlViewer<DemoNode> for DemoViewer {
    fn header_frame(&mut self, node: &DemoNode, _style: &egui_snarl::SnarlStyle) -> egui::Frame {
        let color = match node {
            DemoNode::Number(_) => egui::Color32::from_rgb(80, 50, 50),
            DemoNode::Text(_) => egui::Color32::from_rgb(40, 70, 40),
            DemoNode::Sink => egui::Color32::from_rgb(40, 40, 60),
        };
        egui::Frame::default()
            .fill(color)
            .corner_radius(4.0)
            .stroke(egui::Stroke::new(1.0, egui::Color32::BLACK))
    }
}
```

The signature gives you the node data (`&T`) and the active `SnarlStyle` (so you can respect global settings like corner radius). This is the pattern-matching-on-enums idea from the Rust Book's [Chapter 6.2](https://doc.rust-lang.org/stable/book/ch06-02-match.html): one `match` expression drives a per-variant decision, and the compiler guarantees we handled every variant. If we later add `DemoNode::Boolean`, the `match` will fail to compile until we pick a color for it — a free correctness check.

## A Complete Rich Node Example

Let us assemble a fuller viewer that uses everything so far: color-coded pins, connected-vs-unconnected branching, a body on the `Sink`, and colored headers. We extend the node enum with a `Concat` node (two text inputs, one text output) to show multi-pin rendering:

```rust,no_run
use eframe::egui;
use egui_snarl::{
    ui::{InPin, OutPin, PinInfo, SnarlPin},
    NodeId, Snarl, SnarlViewer,
};

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub enum DemoNode {
    Number(f64),
    Text(String),
    /// Concatenates two text inputs into one output.
    Concat,
    Sink,
}

#[derive(Default)]
pub struct DemoViewer;

impl SnarlViewer<DemoNode> for DemoViewer {
    fn title(&mut self, node: &DemoNode) -> String {
        match node {
            DemoNode::Number(_) => "Number".into(),
            DemoNode::Text(_) => "Text".into(),
            DemoNode::Concat => "Concat".into(),
            DemoNode::Sink => "Sink".into(),
        }
    }

    fn inputs(&mut self, node: &DemoNode) -> usize {
        match node {
            DemoNode::Number(_) | DemoNode::Text(_) => 0,
            DemoNode::Concat => 2, // two text inputs
            DemoNode::Sink => 1,
        }
    }

    fn outputs(&mut self, node: &DemoNode) -> usize {
        match node {
            DemoNode::Number(_) | DemoNode::Text(_) | DemoNode::Concat => 1,
            DemoNode::Sink => 0,
        }
    }

    fn has_body(&mut self, node: &DemoNode) -> bool {
        matches!(node, DemoNode::Concat | DemoNode::Sink)
    }

    fn show_body(&mut self, node_id: NodeId, ui: &mut egui::Ui, snarl: &mut Snarl<DemoNode>) {
        let node = &snarl[node_id];
        match node {
            DemoNode::Concat => {
                // Show a live preview of the concatenation.
                let (a, b) = read_concat_inputs(node_id, snarl);
                ui.label(format!("\"{a}\" + \"{b}\""));
            }
            DemoNode::Sink => {
                ui.label("displays its input");
            }
            _ => {}
        }
    }

    fn header_frame(
        &mut self,
        node: &DemoNode,
        _style: &egui_snarl::SnarlStyle,
    ) -> egui::Frame {
        let color = match node {
            DemoNode::Number(_) => egui::Color32::from_rgb(110, 60, 60),
            DemoNode::Text(_) => egui::Color32::from_rgb(50, 90, 50),
            DemoNode::Concat => egui::Color32::from_rgb(60, 60, 110),
            DemoNode::Sink => egui::Color32::from_rgb(50, 50, 70),
        };
        egui::Frame::default()
            .fill(color)
            .corner_radius(4.0)
            .stroke(egui::Stroke::new(1.0, egui::Color32::BLACK))
    }

    fn show_input(
        &mut self,
        pin: &InPin,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<DemoNode>,
    ) -> impl SnarlPin + 'static {
        // Save the source ids before borrowing snarl mutably.
        let remotes: Vec<egui_snarl::OutPinId> = pin.remotes.clone();

        if let Some(remote) = remotes.first() {
            // Connected: show the source value, read-only.
            match &snarl[remote.node] {
                DemoNode::Number(v) => ui.label(format!("{v}")),
                DemoNode::Text(s) => ui.label(s),
                DemoNode::Concat => ui.label("(concat)"),
                DemoNode::Sink => ui.label(""),
            };
            PinInfo::circle().with_fill(egui::Color32::from_rgb(220, 80, 80))
        } else {
            // Unconnected: for the Sink/Concat, show a placeholder.
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
            DemoNode::Concat => {
                // The output is computed; just label it.
                ui.label("out");
                PinInfo::circle().with_fill(egui::Color32::from_rgb(80, 200, 80))
            }
            DemoNode::Sink => unreachable!("Sink has no output pins"),
        }
    }
}

/// Helper: read the two text inputs of a Concat node as owned strings.
fn read_concat_inputs(node_id: NodeId, snarl: &Snarl<DemoNode>) -> (String, String) {
    let read = |input: usize| -> String {
        let in_pin = snarl.in_pin(egui_snarl::InPinId { node: node_id, input });
        if let Some(remote) = in_pin.remotes.first() {
            match &snarl[remote.node] {
                DemoNode::Text(s) => s.clone(),
                _ => String::new(),
            }
        } else {
            String::new()
        }
    };
    (read(0), read(1))
}
```

A few things in this example deserve comment.

`snarl.in_pin(InPinId { node, input })` returns an `InPin` handle — the same type `show_input` receives, but obtained on demand. This is how a *body* (which only gets a `NodeId`) reads connected values: it asks the `Snarl` for the pin handle, inspects `.remotes`, and indexes the source node. There is a symmetric `snarl.out_pin(OutPinId { ... }) -> OutPin`. We discussed the borrow discipline this requires in the "Reading Connected Values" section above: we `clone` the `remotes` ids first so the shared borrow of `snarl.in_pin(...)` ends before we index into `snarl`.

The `read_concat_inputs` helper is an example of pulling reusable logic out of the viewer — exactly the kind of factoring the Rust Book recommends in [Chapter 7](https://doc.rust-lang.org/stable/book/ch07-01-packages-and-crates.html) when projects grow. As your viewer grows, you will want helpers like this in their own module; we set up that module structure in [Chapter 5](./ch05-architecture.md).

## The Borrow Pattern in `show_input` / `show_output`

Because `show_input` and `show_output` receive `&mut Snarl<T>`, you can mutate node data *while rendering*. This is how inline editing works: there is no "edit buffer" — the `DragValue` directly mutates the `f64` inside `DemoNode::Number`, and the `TextEdit` directly mutates the `String` inside `DemoNode::Text`. Next frame, the new value is simply there.

This is powerful but demands care with borrow ordering. The recurring gotcha is `pin.remotes` and `snarl[node]` both borrowing the `Snarl`. The rule that always works: **extract `Copy` ids from the pin first, drop the borrow of the pin's `remotes`, then index `snarl`.** In the example above we `clone`d the `remotes` into an owned `Vec<OutPinId>` — a tiny allocation, but it makes the borrow trivially sound. If `remotes` were huge you could instead copy just the first id (`pin.remotes.first().copied()`) and end the borrow immediately.

This discipline is the Rust Book's [Chapter 4](https://doc.rust-lang.org/stable/book/ch04-02-references-and-borrowing.html) advice in miniature: a mutable borrow must be the *only* borrow of that data. When two parts of your code both need the `Snarl`, stagger the borrows so they never overlap.

## Summary

In this chapter we learned the full pin rendering model: `show_input` and `show_output` receive a pin handle, a `Ui`, and a `&mut Snarl`, and they return a `PinInfo` describing the pin's shape and wire style. We learned to read connected values through `pin.remotes`, to render editable widgets when unconnected and live values when connected, to add bodies and footers, and to color headers per node type. The borrow choreography — extract `Copy` ids, end the pin borrow, then index the `Snarl` — is the one pattern you must internalize.

Our graph now looks good, but we have not controlled *which* wires the user is allowed to draw. In [Chapter 10](./ch10-connections.md) we will override `connect` and `disconnect` to validate connections by data type, and learn the wire-styling and dropped-wire tools.
