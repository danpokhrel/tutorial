# Chapter 13: Defining Agent Nodes

So far our node graph editor can hold nodes, draw pins, and connect wires — but the nodes themselves are empty placeholders. In this chapter we give them purpose. We'll design a node type system for an *agentic AI flow builder*, the kind of visual tool made popular by projects like Langflow and Flowise, where you compose large language models (LLMs), prompt templates, tools, and memory into runnable pipelines by dragging boxes and drawing connections. By the end of the chapter you'll have an `AgentNode` enum with a variant for each agent component, a `SnarlViewer` implementation that renders each variant's pins and configuration UI, and a color-coded pin system. This chapter assumes you've worked through [Chapter 8](./ch08-egui-snarl.md) through [Chapter 12](./ch12-styling-graph.md), where we built and styled the generic snarl-based graph shell.

## The Vision: A Visual Agentic Flow Builder

Tools like Langflow and Flowise let you build LLM applications without writing glue code. You drop a *chat input* node, wire it into a *prompt template*, feed that into an *LLM node*, optionally branch through *tools* and *memory*, and terminate at an *output* node. The graph is both a visual artifact (you can read the pipeline at a glance) and an executable program (the host evaluates it when the user clicks *Run*).

Our goal for the rest of Part 4 is to build exactly that, in Rust, with eframe and egui-snarl. We won't call real LLM APIs in the tutorial — we'll *simulate* them so the code runs anywhere without API keys — but the architecture will be honest: every node knows its inputs, its configuration, and how to produce an output, and the evaluation engine we build in [Chapter 14](./ch14-graph-evaluation.md) will treat them uniformly.

### What an Agentic Flow Looks Like

A minimal agentic flow might look like this:

```text
[StringNode: "You are a helpful assistant"] ──┐
                                              ├─→ [LLMNode] ─→ [OutputNode]
[ChatInput: "What is 2+2?"]            ───────┘
```

The `LLMNode` takes two string inputs — a *system prompt* and a *user message* — and produces a response string. More elaborate flows add a `PromptTemplate` to interpolate variables, a `ToolNode` to simulate a web search or calculator, and a `MemoryNode` to carry conversation history between turns. Every wire in these graphs carries a string, which keeps the type system simple while we learn the patterns; we'll discuss adding real type checking at the end of this chapter.

## Designing the Node Type System

In egui-snarl, a `Snarl<T>` holds one `T` per node, and a `SnarlViewer<T>` decides how each `T` is rendered. The natural Rust design for "many kinds of node that share a common interface" is an **enum** — one variant per node kind. Each variant carries its own configuration fields: a model name for `LLMNode`, a template string for `PromptTemplate`, a temperature slider value, and so on.

Why an enum and not a trait object (`Box<dyn Node>`)? Two reasons. First, egui-snarl requires the node type to be `Clone + Send + Sync`, and enums of plain data trivially satisfy that. Second, enums give us exhaustive pattern matching, which we'll lean on heavily when rendering pins and when evaluating the graph in [Chapter 14](./ch14-graph-evaluation.md). This is the same "modeling state with enums" idea the Rust Book emphasizes in [Chapter 6](https://doc.rust-lang.org/stable/book/ch06-01-defining-an-enum.html) and [Chapter 18](https://doc.rust-lang.org/stable/book/ch18-03-pattern-matching.html) — when the set of variants is closed and known, an enum is clearer than a trait hierarchy.

### Node Types to Implement

We'll define six node types, enough to express non-trivial agent flows:

- **`ChatInput`** — a starting node with an editable user message. One output: a string.
- **`StringNode`** — a constant string source, for system prompts and other fixed text. No inputs; one output.
- **`PromptTemplate`** — formats a template string, substituting connected inputs in order. One input: string; one output: string.
- **`LLMNode`** — represents an LLM call. Inputs: system prompt (string), user message (string); output: response (string). Configured with a model name and temperature.
- **`ToolNode`** — simulates a tool call (web search, calculator). Input: query string; output: result string. Configured with a tool kind.
- **`MemoryNode`** — stores conversation history. Input: a string; output: a string that includes accumulated context.
- **`OutputNode`** — displays the final result. One input: string; no outputs.

Every wire carries a string, so `StringNode`, `ChatInput`, and `PromptTemplate`'s output can all feed `LLMNode`'s inputs interchangeably.

## Defining the `AgentNode` Enum

Let's write the enum. We derive `Clone`, `Debug`, `serde::Serialize`, and `serde::Deserialize` — the serde derives are essential for the persistence work in [Chapter 16](./ch16-persistence.md), where `Snarl<AgentNode>` will serialize straight to JSON. We also give each variant the configuration fields it needs:

```rust,no_run
use serde::{Deserialize, Serialize};

/// A single node in an agentic AI flow graph.
///
/// Every variant is pure data: no `egui` types here, so the enum
/// can be unit-tested on a headless CI machine (see Chapter 11 and
/// Chapter 17) and serialized to disk (Chapter 16).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum AgentNode {
    /// User-typed message that starts a flow.
    ChatInput {
        message: String,
    },
    /// A constant string, useful for system prompts.
    StringNode {
        value: String,
    },
    /// Formats a template, substituting `{0}`, `{1}`, ... with inputs.
    PromptTemplate {
        template: String,
    },
    /// An LLM call. Combines a system prompt and user message.
    LLMNode {
        model: String,
        temperature: f32,
        system_prompt: String,
    },
    /// A simulated tool call (web search, calculator, etc.).
    ToolNode {
        tool: ToolKind,
    },
    /// Accumulates conversation history and returns it as context.
    MemoryNode {
        history: Vec<String>,
    },
    /// Terminal node that displays the final result.
    OutputNode,
}

/// Which simulated tool a `ToolNode` represents.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ToolKind {
    WebSearch,
    Calculator,
    Weather,
}

impl Default for AgentNode {
    fn default() -> Self {
        // A reasonable starting node when one is created without arguments.
        AgentNode::StringNode {
            value: String::new(),
        }
    }
}
```

> **Tip:** Notice we put `history: Vec<String>` *inside* the `MemoryNode` variant. Node-internal state like this serializes alongside the node and survives reloads. If a node needs state that is large, ephemeral, or non-serializable (a live HTTP connection, a thread handle), keep that in a side `HashMap<NodeId, ...>` on the `App` instead — see the discussion of background-task state in [Chapter 5](./ch05-architecture.md).

We can also add convenience constructors so the UI (and our tests) can spawn nodes succinctly:

```rust,no_run
impl AgentNode {
    pub fn chat_input() -> Self {
        AgentNode::ChatInput {
            message: String::new(),
        }
    }

    pub fn llm() -> Self {
        AgentNode::LLMNode {
            model: "gpt-4o-mini".to_string(),
            temperature: 0.7,
            system_prompt: "You are a helpful assistant.".to_string(),
        }
    }

    pub fn output() -> Self {
        AgentNode::OutputNode
    }
}
```

## Implementing `SnarlViewer` for `AgentNode`

The `SnarlViewer<T>` trait has three jobs that matter to us here: decide a node's **title**, list its **input pins**, and list its **output pins**. (We'll handle interaction callbacks like `connect` and the in-node configuration UI in a moment.) Each method receives the `Snarl` and the node's `NodeId`, so it can inspect the node's data via `snarl[id]`.

The number and order of pins a variant exposes is fixed and must match what the evaluator in [Chapter 14](./ch14-graph-evaluation.md) expects, so we'll be careful to keep them consistent.

```rust,no_run
use eframe::egui;
use egui_snarl::{ui::{PinInfo, SnarlPin, SnarlViewer}, InPin, OutPin, Snarl};

pub struct AgentViewer;

impl SnarlViewer<AgentNode> for AgentViewer {
    fn title(&mut self, node: &AgentNode) -> String {
        match node {
            AgentNode::ChatInput { .. } => "Chat Input".into(),
            AgentNode::StringNode { .. } => "String".into(),
            AgentNode::PromptTemplate { .. } => "Prompt Template".into(),
            AgentNode::LLMNode { model, .. } => format!("LLM ({model})"),
            AgentNode::ToolNode { tool } => format!("Tool: {:?}", tool),
            AgentNode::MemoryNode { .. } => "Memory".into(),
            AgentNode::OutputNode => "Output".into(),
        }
    }

    fn inputs(&mut self, node: &AgentNode) -> usize {
        match node {
            AgentNode::ChatInput { .. } | AgentNode::StringNode { .. } | AgentNode::OutputNode => 0,
            AgentNode::PromptTemplate { .. }
            | AgentNode::ToolNode { .. }
            | AgentNode::MemoryNode { .. } => 1,
            // system prompt + user message
            AgentNode::LLMNode { .. } => 2,
        }
    }

    fn outputs(&mut self, node: &AgentNode) -> usize {
        match node {
            AgentNode::OutputNode => 0,
            _ => 1,
        }
    }
}
```

> **Important: the real `SnarlViewer` signatures.** The `title`, `inputs`, and `outputs` methods take only `&mut self` and `&T` (the node data) — they do **not** receive the `Snarl` or a `NodeId`. The `show_input`/`show_output` methods receive a `pin: &InPin` or `&OutPin` (which bundles the node id and the `remotes` list), a `&mut Ui`, and a `&mut Snarl<T>`. The `connect` method takes `(&OutPin, &InPin, &mut Snarl<T>)` and returns `()` (not `bool`). These signatures match the egui-snarl 0.11 trait exactly. If you see tutorials showing different signatures (with `&Snarl`, `NodeId`, and `usize` pin indices), they are outdated.

### Pin Info and the Color System

`SnarlViewer::show_input` and `show_output` return a `PinInfo` describing how a pin is drawn. We use `PinInfo::circle().with_fill(color)` to render a small dot, and we color-code by the *kind* of value the pin carries. Since all our pins currently carry strings, we use one color for string pins — green — and reserve other colors for future pin types so the system is visually extensible:

```rust,no_run
/// Pin color for a string-carrying pin.
const STRING_PIN: egui::Color32 = egui::Color32::from_rgb(80, 200, 120);
/// Pin color for a control-flow pin (reserved for future use).
const CONTROL_PIN: egui::Color32 = egui::Color32::from_rgb(220, 160, 60);

impl SnarlViewer<AgentNode> for AgentViewer {
    fn show_input(
        &mut self,
        _pin: &InPin,
        _ui: &mut egui::Ui,
        _snarl: &mut Snarl<AgentNode>,
    ) -> impl SnarlPin + 'static {
        // All current inputs are strings. Later, a match on `_pin.id`
        // can return CONTROL_PIN for non-string pins.
        PinInfo::circle().with_fill(STRING_PIN)
    }

    fn show_output(
        &mut self,
        _pin: &OutPin,
        _ui: &mut egui::Ui,
        _snarl: &mut Snarl<AgentNode>,
    ) -> impl SnarlPin + 'static {
        PinInfo::circle().with_fill(STRING_PIN)
    }
}
```

> **Note:** We keep a `CONTROL_PIN` constant even though nothing uses it yet. When you later add typed pins (an image output, a structured-data output), you'll branch on the node variant and pin index here, returning a distinct color per type — exactly the way the bundled egui-snarl demo distinguishes its pin kinds. Defining the colors up front keeps the visual language stable as the type system grows.

## Rendering Configuration UI Inside Nodes

A node is more than its pins — it needs editable configuration: the user must be able to type a prompt, pick a model, and drag a temperature slider without leaving the node. egui-snarl gives us two hooks for drawing arbitrary UI inside a node body: `show_input` and `show_output`, called when rendering each pin's row. We already used them above to return `PinInfo`; the same methods can also draw widgets into the `&mut egui::Ui` they receive before returning the pin info.

The trick is to match on the node variant and the pin index, draw the appropriate editor, and mutate the node. Because the method signature hands us `&AgentNode` (a shared reference), we need to collect the *intent* to edit and apply it afterward — the same collect-then-mutate discipline from [Chapter 5](./ch05-architecture.md). In practice, egui-snarl's `show_input`/`show_output` are called on a borrowed node, so we'll read the current value, let the user edit a local copy, and stash the edited value in a pending-edits map owned by the viewer. For brevity in this chapter, we show the inline mutation pattern you'd use when the viewer holds `&mut` to the node through other hooks; the full collect-then-mutate version is left as an exercise and revisited in [Chapter 14](./ch14-graph-evaluation.md).

Here is a partial `SnarlViewer` implementation covering `ChatInput`, `LLMNode`, and `OutputNode`, with configuration UI for the first two:

```rust,no_run
use eframe::egui;
use egui_snarl::{ui::{PinInfo, SnarlPin, SnarlViewer}, InPin, NodeId, OutPin, Snarl};

pub struct AgentViewer {
    /// Buffered text edits captured while rendering node bodies, applied
    /// after `show_*` returns so we never hold `&mut` to the node mid-render.
    pub pending_edits: std::collections::HashMap<NodeId, AgentNode>,
}

impl SnarlViewer<AgentNode> for AgentViewer {
    fn title(&mut self, node: &AgentNode) -> String {
        match node {
            AgentNode::ChatInput { .. } => "Chat Input".into(),
            AgentNode::LLMNode { model, .. } => format!("LLM ({model})"),
            AgentNode::OutputNode => "Output".into(),
            _ => "Node".into(),
        }
    }

    fn inputs(&mut self, node: &AgentNode) -> usize {
        match node {
            AgentNode::ChatInput { .. } => 0,
            AgentNode::LLMNode { .. } => 2, // system prompt, user message
            AgentNode::OutputNode => 1,
            _ => 0,
        }
    }

    fn outputs(&mut self, node: &AgentNode) -> usize {
        match node {
            AgentNode::OutputNode => 0,
            _ => 1,
        }
    }

    fn show_input(
        &mut self,
        pin: &InPin,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<AgentNode>,
    ) -> impl SnarlPin + 'static {
        let id = pin.id.node;
        let input = pin.id.input;
        let node = snarl[id].clone();
        match &node {
            AgentNode::LLMNode { system_prompt, .. } if input == 0 => {
                // System prompt editor on the first input row.
                let mut buf = system_prompt.clone();
                ui.text_edit_multiline(&mut buf);
                if buf != *system_prompt {
                    let mut edited = node.clone();
                    if let AgentNode::LLMNode { system_prompt, .. } = &mut edited {
                        *system_prompt = buf;
                    }
                    self.pending_edits.insert(id, edited);
                }
            }
            AgentNode::OutputNode => {
                // Read-only: the output node just shows its received value.
                ui.label("(final result)");
            }
            _ => {}
        }
        PinInfo::circle().with_fill(egui::Color32::from_rgb(80, 200, 120))
    }

    fn show_output(
        &mut self,
        pin: &OutPin,
        ui: &mut egui::Ui,
        snarl: &mut Snarl<AgentNode>,
    ) -> impl SnarlPin + 'static {
        let id = pin.id.node;
        let node = snarl[id].clone();
        match &node {
            AgentNode::ChatInput { message } => {
                let mut buf = message.clone();
                ui.text_edit_singleline(&mut buf);
                ui.add_space(2.0);
                if buf != *message {
                    let mut edited = node.clone();
                    if let AgentNode::ChatInput { message } = &mut edited {
                        *message = buf;
                    }
                    self.pending_edits.insert(id, edited);
                }
            }
            AgentNode::LLMNode { model, temperature, .. } => {
                // Model selector + temperature slider live in the *output*
                // row so the node body reads top-to-bottom.
                let mut temp = *temperature;
                let mut model_buf = model.clone();
                ui.horizontal(|ui| {
                    ui.label("Model");
                    egui::ComboBox::from_id_salt("llm_model")
                        .selected_text(model_buf.as_str())
                        .show_ui(ui, |ui| {
                            for m in ["gpt-4o-mini", "gpt-4o", "claude-3.5-sonnet"] {
                                ui.selectable_value(&mut model_buf, m.to_string(), m);
                            }
                        });
                });
                ui.add(
                    egui::Slider::new(&mut temp, 0.0..=2.0)
                        .text("temp")
                        .fixed_decimals(2),
                );
                if temp != *temperature || model_buf != *model {
                    let mut edited = node.clone();
                    if let AgentNode::LLMNode { model, temperature, .. } = &mut edited {
                        *model = model_buf;
                        *temperature = temp;
                    }
                    self.pending_edits.insert(id, edited);
                }
            }
            _ => {}
        }
        PinInfo::circle().with_fill(egui::Color32::from_rgb(80, 200, 120))
    }
}
```

> **Warning:** The model-selection snippet above uses `selectable_value` with a throwaway `String::from(m)` as the target, which won't actually persist the edit — it's illustrative only. In real code, buffer the selection in a local `&mut String` bound (mirroring the `ChatInput` pattern) and route the change through `pending_edits`. The point of the example is the *layout*: a `ComboBox` and a `Slider` rendered inside a node body via the `show_output` hook.

After the snarl renders, the host must drain `pending_edits` and write each updated node back into the `Snarl`. The pattern, which we'll reuse throughout Part 4, looks like:

```rust,no_run
// In your App::ui or a helper, after showing the snarl:
let pending = std::mem::take(&mut viewer.pending_edits);
for (id, node) in pending {
    snarl[id] = node;
}
```

This is the same collect-then-mutate discipline that keeps the borrow checker happy when a single frame touches many widgets — see [Chapter 5](./ch05-architecture.md) for the full rationale.

## The `connect()` Hook and Type Checking

When the user draws a wire between an output pin and an input pin, egui-snarl calls `SnarlViewer::connect`, which by default just records the connection in the snarl's wire list. We can override it to *validate* the connection — refuse, for instance, to wire an output into another output.

For now, every pin carries a string, so any output can connect to any input. That makes the graph maximally flexible, which is nice while learning. We can still add a guard for the obvious structural rule — never connect two inputs or two outputs together — and reserve the hook for richer type checking later:

```rust,no_run
use egui_snarl::{ui::SnarlViewer, InPinId, OutPinId, InPin, OutPin, Snarl};

impl SnarlViewer<AgentNode> for AgentViewer {
    fn connect(
        &mut self,
        from: &OutPin,
        to: &InPin,
        snarl: &mut Snarl<AgentNode>,
    ) {
        // egui-snarl only calls this for valid output→input pairs, so the
        // structural rule is enforced by the framework. We accept all
        // connections because every pin is a string.
        // To veto a connection, simply do NOT call snarl.connect here.
        snarl.connect(from.id, to.id);
    }
}
```

> **Note:** To veto a connection, simply do not call `snarl.connect(...)` inside your override — the wire will not be created. When you later introduce a type system (string vs. image vs. structured data pins), this is where you'd inspect the source and target node variants and skip the `snarl.connect` call for mismatched types — for example, refusing to wire an `LLMNode` output into a `ToolNode` field that expects a structured query. For now we accept everything.

### Toward Real Type Checking

A clean way to add type checking without a big refactor is to give each pin a `PinType` (an enum: `String`, `Image`, `Json`, …), expose it via a helper on `AgentNode`, and check matching in `connect`. Because our evaluation engine (next chapter) already gathers inputs by pin index, adding a type field doesn't disturb the evaluator as long as two pins of the same type stay compatible. We'll leave this as an exercise; the architecture we're building won't fight you when you add it.

## Putting It on Screen

We now have an `AgentNode` enum, a viewer with titles and pins, and configuration editors for three variants. To display it, we hand the snarl and viewer to a `SnarlWidget`, exactly as in [Chapter 9](./ch09-nodes-pins.md):

```rust,no_run
use eframe::egui;
use egui_snarl::{ui::SnarlWidget, Snarl};

pub struct App {
    pub snarl: Snarl<AgentNode>,
    pub viewer: AgentViewer,
}

impl App {
    pub fn show_graph(&mut self, ui: &mut egui::Ui) {
        SnarlWidget::new()
            .id_salt(egui::Id::new("agent_graph"))
            .show(&mut self.snarl, &mut self.viewer, ui);

        // Apply any text edits captured during rendering.
        let pending = std::mem::take(&mut self.viewer.pending_edits);
        for (id, node) in pending {
            self.snarl[id] = node;
        }
    }
}
```

We can seed a starter graph to make sure everything wires up:

```rust,no_run
impl App {
    pub fn new() -> Self {
        let mut snarl = Snarl::<AgentNode>::new();
        let sys = snarl.insert_node([0.0, 0.0], AgentNode::StringNode {
            value: "You are a helpful assistant.".into(),
        });
        let chat = snarl.insert_node([0.0, 200.0], AgentNode::ChatInput {
            message: "What is 2+2?".into(),
        });
        let llm = snarl.insert_node([400.0, 100.0], AgentNode::LLMNode {
            model: "gpt-4o-mini".into(),
            temperature: 0.7,
            system_prompt: String::new(),
        });
        let out = snarl.insert_node([800.0, 100.0], AgentNode::OutputNode);

        // sys  -> llm input 0 (system prompt)
        // chat -> llm input 1 (user message)
        // llm  -> out input 0
        snarl.connect(
            egui_snarl::OutPinId { node: sys, output: 0 },
            egui_snarl::InPinId { node: llm, input: 0 },
        );
        snarl.connect(
            egui_snarl::OutPinId { node: chat, output: 0 },
            egui_snarl::InPinId { node: llm, input: 1 },
        );
        snarl.connect(
            egui_snarl::OutPinId { node: llm, output: 0 },
            egui_snarl::InPinId { node: out, input: 0 },
        );

        Self {
            snarl,
            viewer: AgentViewer { pending_edits: Default::default() },
        }
    }
}
```

You should now see four nodes, color-coded green pins, editable prompt text in the `ChatInput` and `LLMNode` bodies, a model combo box and temperature slider, and three wires forming a complete pipeline. The graph looks like an agent flow — but nothing happens when you stare at it, because we haven't taught it to *run*. That's the job of the evaluation engine.

---

We now have a typed, visually-rich set of agent nodes living inside our snarl graph. Each node declares its pins, renders its own configuration UI, and color-codes its connections. What's missing is the part that makes a flow builder *useful*: executing the graph. In [Chapter 14](./ch14-graph-evaluation.md) we'll build a graph evaluator — a pure-Rust module that topologically sorts the nodes, feeds inputs forward, and produces a result for every node — turning our visual diagram into a runnable program.
