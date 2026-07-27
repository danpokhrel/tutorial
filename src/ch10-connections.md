# Chapter 10: Connections & Wires

In [Chapter 9](./ch09-nodes-pins.md) we built rich, editable nodes — but every wire in our graph so far was created in code with `snarl.connect`. In a real editor, the user draws wires by dragging from pin to pin, and we must *validate* those connections: a number output should not feed a text input. In this chapter we override the `SnarlViewer` connection methods to add type checking, learn how disconnection and pin-drop work, and style wires per pin. This chapter assumes you have read [Chapter 8](./ch08-egui-snarl.md) and [Chapter 9](./ch09-nodes-pins.md); we will also lean on the enum pattern matching from the Rust Book's [Chapter 6.2](https://doc.rust-lang.org/stable/book/ch06-02-match.html).

## How Wires Work in egui-snarl

A wire is a connection from one `OutPinId` to one `InPinId`. The user creates a wire interactively by *dragging from a pin and releasing on another pin*. `egui-snarl` handles the drag detection and the visual rendering of the in-progress wire; at the moment of release it calls into your viewer to ask whether the connection should be allowed.

Three methods on `SnarlViewer` govern connections:

| Method | When it is called | Default behavior |
|---|---|---|
| `connect(&mut self, from: &OutPin, to: &InPin, snarl: &mut Snarl<T>)` | User drops a wire from output `from` onto input `to`. | Calls `snarl.connect(from.id, to.id)`. |
| `disconnect(&mut self, from: &OutPin, to: &InPin, snarl: &mut Snarl<T>)` | A wire is removed (e.g., user drags a connected wire away). | Calls `snarl.disconnect(from.id, to.id)`. |
| `drop_outputs` / `drop_inputs` | Right-click on a pin → "drop all wires". | Clears all wires on that pin. |

Crucially, these methods receive *pin handles* (`&OutPin`, `&InPin`), not just ids. The handles carry `.remotes`, so your validation logic can inspect what is already connected. The `&mut Snarl<T>` is passed so you can perform the actual mutation.

> **Note:** The default `connect` is *permissive* — it accepts any wire between any two pins. That is fine for a demo, but a production graph almost always wants type checking. Override `connect` to add it.

## Overriding `connect` for Type Validation

The pattern is: inspect the source node and the destination node by type, decide whether the connection is valid, and only then call `snarl.connect`. Return `bool` — `egui-snarl` uses it (and whether `snarl.connect` returned `true`) to decide whether the visual wire should snap into place.

Let us define a notion of "data type" for each pin, derived from the node variant. We extend our `DemoNode` enum from [Chapter 9](./ch09-nodes-pins.md) with a helper that maps each output pin to a data type:

```rust,no_run
use serde::{Deserialize, Serialize};

/// The kind of data flowing over a wire.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
pub enum DataType {
    Number,
    Text,
}

#[derive(Serialize, Deserialize, Clone)]
pub enum DemoNode {
    Number(f64),
    Text(String),
    Concat,
    Sink,
}

impl DemoNode {
    /// What data type a given *output* pin produces.
    pub fn output_type(&self, output: usize) -> Option<DataType> {
        match self {
            DemoNode::Number(_) => (output == 0).then_some(DataType::Number),
            DemoNode::Text(_) => (output == 0).then_some(DataType::Text),
            DemoNode::Concat => (output == 0).then_some(DataType::Text),
            DemoNode::Sink => None,
        }
    }

    /// What data type a given *input* pin expects.
    pub fn input_type(&self, input: usize) -> Option<DataType> {
        match self {
            DemoNode::Number(_) | DemoNode::Text(_) => None,
            // Both Concat inputs expect Text.
            DemoNode::Concat => (input < 2).then_some(DataType::Text),
            // The single Sink input accepts anything.
            DemoNode::Sink => (input == 0).then_some(DataType::Number).or(
                (input == 0).then_some(DataType::Text),
            ),
        }
    }
}
```

The `Sink` case shows a subtlety: a "sink any type" pin has no single expected type. We model that by returning `None` for "untyped" and checking compatibility specially. A cleaner design uses an `Option<DataType>` where `None` means "accepts anything"; we do that here for inputs:

```rust,no_run
impl DemoNode {
    /// `None` means "accepts any type".
    pub fn expected_input(&self, input: usize) -> Option<DataType> {
        match self {
            DemoNode::Concat => Some(DataType::Text),
            DemoNode::Sink => None, // accepts anything
            _ => None,
        }
    }
}
```

Now the `connect` override. The rule: a wire is allowed if the destination expects either nothing (any) or exactly the source's type:

```rust,no_run
use egui_snarl::{ui::{InPin, OutPin}, Snarl, SnarlViewer};

impl SnarlViewer<DemoNode> for DemoViewer {
    fn connect(
        &mut self,
        from: &OutPin,
        to: &InPin,
        snarl: &mut Snarl<DemoNode>,
    ) -> bool {
        // Read source and destination node types BEFORE mutating.
        let src = &snarl[from.id.node];
        let dst = &snarl[to.id.node];

        let Some(src_type) = src.output_type(from.id.output) else {
            return false; // source has no such output
        };

        match dst.expected_input(to.id.input) {
            None => {
                // Destination accepts any type.
                snarl.connect(from.id, to.id)
            }
            Some(expected) if expected == src_type => {
                snarl.connect(from.id, to.id)
            }
            Some(_) => {
                // Type mismatch: reject, do not create the wire.
                false
            }
        }
    }
}
```

Two design points.

First, **read before mutate.** We take shared borrows of `snarl[from.id.node]` and `snarl[to.id.node]` to read the types, *then* call `snarl.connect(...)`, which takes `&mut`. The shared borrows must end before the mutable call — the compiler enforces this because the shared borrows go out of scope at the end of the `let` bindings' last use. This is the same stagger-the-borrows discipline from [Chapter 9](./ch09-nodes-pins.md), and it is the Rust Book's [Chapter 4.2](https://doc.rust-lang.org/stable/book/ch04-02-references-and-borrowing.html) made concrete.

Second, **return the result of `snarl.connect`.** The underlying `Snarl::connect(from, to) -> bool` returns `true` when a new connection is created and `false` when one already existed (a duplicate). Returning it directly lets the widget know whether a wire actually appeared.

> **Tip:** If you want to *replace* an existing wire on a single-input pin rather than reject a duplicate, call `snarl.drop_inputs(to.id)` before `snarl.connect(...)` in your override. This implements "one wire per input" semantics — common in shader graphs where an input takes exactly one value.

## Disconnecting Wires

`disconnect` is the inverse of `connect`. The default implementation calls `snarl.disconnect(from.id, to.id)` and that is usually all you want. You override it when removing a wire should trigger a *side effect* — for example, clearing a cached evaluation, or marking a node "dirty" so it re-evaluates next frame:

```rust,no_run
impl SnarlViewer<DemoNode> for DemoViewer {
    fn disconnect(
        &mut self,
        from: &OutPin,
        to: &InPin,
        snarl: &mut Snarl<DemoNode>,
    ) {
        // Perform the actual disconnection.
        snarl.disconnect(from.id, to.id);

        // Side effect: any node whose input changed may need re-evaluation.
        // In Part 4 we will mark `to.id.node` dirty here.
        self.mark_dirty(to.id.node);
    }
}

impl DemoViewer {
    fn mark_dirty(&mut self, _node: egui_snarl::NodeId) {
        // e.g. push onto a Vec<NodeId> of dirty nodes.
    }
}
```

`disconnect` does not return a `bool` — it is a notification, not a gate. You cannot *prevent* a disconnection (the user can always drag a wire away), but you can react to it.

## `drop_outputs` and `drop_inputs`

Right-clicking a pin offers (by default) a menu item to drop all wires on that pin. `drop_outputs(pin: &OutPin, snarl)` clears every wire leaving an output; `drop_inputs(pin: &InPin, snarl)` clears every wire arriving at an input. The defaults call `snarl.drop_outputs(pin.id)` and `snarl.drop_inputs(pin.id)` respectively.

Like `disconnect`, you override these to add side effects when a whole pin is cleared. A common reason: if an output had several downstream consumers and you drop them all, you want to mark each consumer dirty:

```rust,no_run
impl SnarlViewer<DemoNode> for DemoViewer {
    fn drop_outputs(&mut self, pin: &egui_snarl::ui::OutPin, snarl: &mut Snarl<DemoNode>) {
        // Collect the affected downstream node ids first.
        let affected: Vec<_> = pin.remotes.iter().map(|r| r.node).collect();
        snarl.drop_outputs(pin.id);
        for node in affected {
            self.mark_dirty(node);
        }
    }

    fn drop_inputs(&mut self, pin: &egui_snarl::ui::InPin, snarl: &mut Snarl<DemoNode>) {
        snarl.drop_inputs(pin.id);
        self.mark_dirty(pin.id.node);
    }
}
```

Notice we again follow the collect-then-mutate pattern from [Chapter 5](./ch05-architecture.md): we copy the `remotes` ids into an owned `Vec` *before* calling `snarl.drop_outputs`, because that call mutates the `Snarl` and would invalidate a live borrow of `pin.remotes`.

## Multi-Connections

By default, an input pin accepts multiple wires. `InPin.remotes` is a `Vec<OutPinId>`, and the default `connect` simply appends. Whether that is desirable depends on your graph's semantics:

- A **merge/sum** node wants multiple wires on one input.
- A **function argument** node wants exactly one wire per input.

For the "exactly one" case, drop existing wires in your `connect` override before connecting the new one (the tip above). For the "many allowed" case, leave the default. `egui-snarl` itself has no notion of "single vs multi" — it is entirely your `connect`'s decision.

## Wire Styling

Wires are drawn by `egui-snarl`, but you influence their appearance through `PinInfo`. Recall from [Chapter 9](./ch09-nodes-pins.md) that `show_input`/`show_output` return a `PinInfo`. The `.with_wire_style(...)` modifier on `PinInfo` sets how wires *attached to that pin* are drawn:

```rust,no_run
use egui_snarl::ui::{PinInfo, WireStyle};

// Smooth bezier (the default if you omit with_wire_style).
let smooth = PinInfo::circle().with_fill(egui::Color32::from_rgb(220, 80, 80));

// Right-angled wires with rounded corners.
let angular = PinInfo::circle()
    .with_fill(egui::Color32::from_rgb(80, 200, 80))
    .with_wire_style(WireStyle::AxisAligned { corner_radius: 8.0 });
```

`WireStyle::AxisAligned { corner_radius }` produces wires that run horizontally from the pin, turn at a right angle, and run to the other pin — the look popularized by Unreal's material editor. The default (no `.with_wire_style`) is a smooth bezier. Mixing styles on the same graph is possible but usually looks inconsistent; pick one convention and apply it to every pin. We will set a global default via `SnarlStyle` in [Chapter 12](./ch12-styling-graph.md).

Wire *color* follows the pin's fill color. This is why color-coding pins by data type is so effective: the wires themselves become color-coded, and a red wire flowing into a green pin is an immediate, glaring type mismatch.

## Custom Wire Widgets: `has_wire_widget` / `show_wire_widget`

For advanced cases — animated wires, wires with a direction arrow, wires that display a flowing dot — `egui-snarl` lets you take over rendering of an individual wire segment entirely. Override `has_wire_widget` to return `true` for wires you want to customize, and implement `show_wire_widget` to draw into the `ui` positioned along the wire:

```rust,no_run
use egui_snarl::ui::{InPin, OutPin, WireId};

impl SnarlViewer<DemoNode> for DemoViewer {
    fn has_wire_widget(&mut self, _from: &OutPin, _to: &InPin) -> bool {
        // Only add widgets to number wires, for example.
        true
    }

    fn show_wire_widget(
        &mut self,
        _id: WireId,
        ui: &mut egui::Ui,
        _snarl: &mut Snarl<DemoNode>,
    ) {
        // Draw a small label or a moving dot here.
        ui.label("·");
    }
}
```

This is rarely needed; we mention it for completeness. The default wire rendering is attractive and performant. We will not use custom wire widgets in this book's main example, but they are handy for tools that visualize data *flow* during evaluation in [Chapter 15](./ch15-live-execution.md).

## A Complete Validation Example

Putting the pieces together, here is a `connect` that validates string→string, number→number, and rejects incompatible types, using the `expected_input`/`output_type` helpers from earlier in the chapter:

```rust,no_run
use egui_snarl::{ui::{InPin, OutPin}, Snarl, SnarlViewer};

impl SnarlViewer<DemoNode> for DemoViewer {
    fn connect(
        &mut self,
        from: &OutPin,
        to: &InPin,
        snarl: &mut Snarl<DemoNode>,
    ) -> bool {
        // Borrow the two nodes immutably to read their types.
        let (src_type, dst_expected) = {
            let src = &snarl[from.id.node];
            let dst = &snarl[to.id.node];
            (src.output_type(from.id.output), dst.expected_input(to.id.input))
        };
        // The shared borrows end here; we may now mutate.

        let Some(src_type) = src_type else { return false };

        let compatible = match dst_expected {
            None => true, // destination accepts any type
            Some(expected) => expected == src_type,
        };

        if !compatible {
            return false; // reject; no wire is created
        }

        // For single-value inputs, replace any existing wire.
        if matches!(dst_expected, Some(_)) {
            snarl.drop_inputs(to.id);
        }
        snarl.connect(from.id, to.id)
    }

    fn disconnect(
        &mut self,
        from: &OutPin,
        to: &InPin,
        snarl: &mut Snarl<DemoNode>,
    ) {
        snarl.disconnect(from.id, to.id);
        self.mark_dirty(to.id.node);
    }
}
```

With this in place, dragging from a `Number` output onto a `Concat` input (which expects `Text`) will simply fail to create a wire — the dragged wire snaps back. Dragging from a `Text` output onto the `Sink` (which accepts anything) succeeds. The user gets immediate, silent feedback about type compatibility, exactly as in a shader graph.

> **Note:** There is no built-in "red flash" or error toast on a rejected connection. If you want feedback, you can set a transient message field on your viewer inside the `!compatible` branch and render it as a toast next frame — the state-collection pattern from [Chapter 5](./ch05-architecture.md).

## Cleaning Up When Nodes Are Removed

When a node is removed (we will wire up `remove_node` via a context menu in [Chapter 11](./ch11-interactions.md)), `egui-snarl` automatically drops every wire that touched the node's pins. You do not need to disconnect manually. However, *downstream nodes that were reading from the removed node* may now display stale data or an empty `remotes` vec — your `show_input` must handle `pin.remotes.is_empty()` gracefully, as we did in [Chapter 9](./ch09-nodes-pins.md) by showing "—".

If you cache evaluations (as we will in Part 4), hook `disconnect` and the removal path to mark consumers dirty. The `Snarl::remove_node(node_id) -> T` method removes a node and returns its data; wires are cleaned up internally:

```rust,no_run
let removed: DemoNode = snarl.remove_node(node_id);
// Wires that touched this node are gone; downstream remotes are updated.
```

Because removal returns the node data by value, you can inspect it (e.g., to log it or to offer an "undo") before dropping it. This is ownership in action — the `Snarl` *owned* the `DemoNode`, and on removal it moves that ownership out to you (Rust Book [Chapter 4.1](https://doc.rust-lang.org/stable/book/ch04-01-what-is-ownership.html)).

## Summary

In this chapter we took control of the graph's connections. We overrode `connect` to validate wires by data type — accepting string→string and number→number, rejecting mismatches — and learned that `disconnect` and `drop_outputs`/`drop_inputs` are notification hooks for side effects like marking nodes dirty. We saw that multi-connection is the default and that "exactly one wire per input" is a one-line override, and we styled wires per pin through `PinInfo::with_wire_style`. The collect-then-mutate borrow discipline kept the type-checking code sound.

Our graph now enforces a sensible type system, but the only way to add nodes is still in code. In [Chapter 11](./ch11-interactions.md) we will add context menus — right-click the background to spawn nodes, right-click a node to delete it, and drag a wire to empty space to create a connected node automatically.
