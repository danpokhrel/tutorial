# Chapter 14: Graph Evaluation

A flow builder with beautiful nodes and wires is, until something runs, just a drawing. In this chapter we make it *compute*. We'll build a graph evaluator that takes a `Snarl<AgentNode>` and produces an output value for every node, executing them in dependency order so that every node's inputs are ready by the time it runs. The evaluator will live in a pure-Rust module with no `egui` dependency, so it can be unit-tested on a headless CI machine exactly as we planned in [Chapter 5](./ch05-architecture.md) and practiced in [Chapter 11](./ch11-interactions.md). This chapter builds directly on the `AgentNode` enum from [Chapter 13](./ch13-agent-nodes.md).

## The Evaluation Problem

Given a directed graph of nodes where each node consumes some inputs and produces some outputs, *evaluate* means: produce a value for every node such that every node's inputs are the outputs of the nodes feeding into it. Concretely, for our agent flow:

- `StringNode` produces its constant string.
- `ChatInput` produces the message the user typed.
- `PromptTemplate` formats its template using connected inputs.
- `LLMNode` takes its two input strings, calls (or simulates) an LLM, and emits the response.
- `ToolNode` simulates a tool call on its input query.
- `MemoryNode` accumulates input into its history and emits the joined context.
- `OutputNode` consumes its input and stores it as the final result.

The catch is *ordering*. We cannot evaluate `LLMNode` before its system-prompt and user-message inputs are ready. So evaluation has two phases: figure out a valid order, then walk that order computing outputs.

### Topological Sorting

A *topological sort* of a directed acyclic graph (DAG) is a linear ordering of its nodes such that for every edge `u → v`, `u` comes before `v`. If the graph has a cycle, no topological order exists, and that is exactly the error condition we must detect — a cyclic flow cannot be evaluated because a node's input would depend on its own output.

Two classic algorithms produce a topological order:

- **Kahn's algorithm**: repeatedly remove nodes with no remaining incoming edges (in-degree zero), appending them to the output and decrementing their successors' in-degrees. If the output has fewer nodes than the graph, a cycle exists.
- **DFS-based**: run a post-order DFS, pushing nodes onto a stack; popping the stack yields a topological order. Detect back-edges to find cycles.

We'll use Kahn's algorithm because it gives us the cycle check for free and is easy to read.

## Building an Adjacency List from a `Snarl`

egui-snarl exposes connectivity through `snarl.wires()`, which yields `(OutPinId, InPinId)` pairs. Each such pair means "output of `OutPinId.node` feeds input of `InPinId.node`" — i.e. there is a dependency edge from the source node to the destination node. We can turn the wire iterator into an adjacency list and an in-degree map:

```rust,no_run
use egui_snarl::{NodeId, Snarl};
use std::collections::{HashMap, HashSet};

/// Build an adjacency list and in-degree map from a snarl's wires.
///
/// `outgoing[a]` is the set of nodes that depend on `a`'s outputs.
/// `indeg[b]` is how many of `b`'s inputs are fed by some upstream node.
fn build_adjacency(
    snarl: &Snarl<AgentNode>,
) -> (HashMap<NodeId, HashSet<NodeId>>, HashMap<NodeId, usize>) {
    let mut outgoing: HashMap<NodeId, HashSet<NodeId>> = HashMap::new();
    let mut indeg: HashMap<NodeId, usize> = HashMap::new();

    // Ensure every node appears, even if it has no edges.
    for id in snarl.node_ids() {
        outgoing.entry(id).or_default();
        indeg.entry(id).or_insert(0);
    }

    for (out_pin, in_pin) in snarl.wires() {
        let from = out_pin.node;
        let to = in_pin.node;
        if from == to {
            // A self-wire: treat as a cycle.
            continue;
        }
        if outgoing.entry(from).or_default().insert(to) {
            *indeg.entry(to).or_insert(0) += 1;
        }
    }

    (outgoing, indeg)
}
```

> **Note:** egui-snarl's `Snarl` exposes `node_ids()` to iterate node IDs. If your version does not, you can derive the ID list from `wires()` plus any bookkeeping you keep when inserting nodes; the adjacency-list code is otherwise unchanged.

The `insert` check on the `HashSet` deduplicates parallel edges — multiple wires from the same source node into the same destination node count once for in-degree purposes, because one upstream node being ready unblocks the dependency.

### Kahn's Algorithm

With the adjacency list in hand, Kahn's algorithm is a handful of lines:

```rust,no_run
use std::collections::VecDeque;

/// Returns a topological ordering of the snarl's nodes, or an error
/// describing a cycle if one exists.
fn topo_sort(
    snarl: &Snarl<AgentNode>,
) -> Result<Vec<NodeId>, EvalError> {
    let (outgoing, mut indeg) = build_adjacency(snarl);

    let mut queue: VecDeque<NodeId> = indeg
        .iter()
        .filter(|(_, &d)| d == 0)
        .map(|(&n, _)| n)
        .collect();

    let mut order = Vec::with_capacity(indeg.len());
    while let Some(n) = queue.pop_front() {
        order.push(n);
        if let Some(succs) = outgoing.get(&n) {
            for &s in succs {
                let d = indeg.entry(s).or_insert(0);
                *d -= 1;
                if *d == 0 {
                    queue.push_back(s);
                }
            }
        }
    }

    if order.len() == indeg.len() {
        Ok(order)
    } else {
        Err(EvalError::Cycle {
            involved: indeg.keys().copied().collect(),
        })
    }
}
```

If `order.len()` is less than the number of nodes, the unscheduled nodes form one or more cycles, and we report a `Cycle` error. We return the involved node set so the UI can highlight them — more on that in [Chapter 15](./ch15-live-execution.md).

## The Evaluation Context

Once we have an order, we walk it, gathering each node's inputs from the *results* of nodes already evaluated. The natural container is a map from `NodeId` to the node's *primary output string*. Since all our pins carry strings, a node produces exactly one output value (or, for `OutputNode`, none). We use a `HashMap<NodeId, String>`:

```rust,no_run
use std::collections::HashMap;

/// The result of evaluating a graph: one output string per node that
/// produced one. Terminal nodes (OutputNode) record their received
/// value under a well-known key instead.
#[derive(Clone, Debug, Default)]
pub struct EvalResults {
    pub values: HashMap<NodeId, String>,
    /// Logs accumulated during evaluation, for the console panel.
    pub logs: Vec<String>,
}
```

> **Tip:** We keep `logs` on the results struct so the UI can display a trace without holding a separate side-channel. In [Chapter 15](./ch15-live-execution.md) we'll stream these logs to a console panel as evaluation progresses.

### Gathering a Node's Inputs

To evaluate a node we need the strings feeding each of its input pins. Each input pin has a `remotes: Vec<OutPinId>` listing the output pins connected to it (see the API reference in [Chapter 8](./ch08-egui-snarl.md)). We resolve each remote to its source node's already-computed output:

```rust,no_run
use egui_snarl::{InPinId, NodeId, OutPinId, Snarl};

/// Resolve the inputs for `node`, one `String` per input pin, in order.
/// Missing connections yield `None`; the caller decides how to handle that.
fn gather_inputs(
    snarl: &Snarl<AgentNode>,
    node: NodeId,
    results: &EvalResults,
) -> Vec<Option<String>> {
    let input_count = input_pin_count(&snarl[node]);
    let mut inputs = Vec::with_capacity(input_count);

    for i in 0..input_count {
        let pin = snarl.in_pin(InPinId { node, input: i });
        // `pin.remotes` is the list of outputs wired into this input.
        let value = pin.remotes.first().and_then(|out: &OutPinId| {
            results.values.get(&out.node).cloned()
        });
        inputs.push(value);
    }
    inputs
}

/// How many input pins a node has — must match the `SnarlViewer::inputs`
/// impl from Chapter 13.
fn input_pin_count(node: &AgentNode) -> usize {
    match node {
        AgentNode::ChatInput { .. } | AgentNode::StringNode { .. } => 0,
        AgentNode::PromptTemplate { .. }
        | AgentNode::ToolNode { .. }
        | AgentNode::MemoryNode { .. } => 1,
        AgentNode::LLMNode { .. } => 2,
        AgentNode::OutputNode => 1,
    }
}
```

For multiple outputs wired into one input we take only the first — a simple policy. A stricter implementation could error or concatenate; we note this as a place to enforce stricter semantics later.

## Evaluating Each Node Type

With inputs gathered, evaluating a node is a `match` on the variant — exactly the exhaustive pattern matching the Rust Book champions in [Chapter 6](https://doc.rust-lang.org/stable/book/ch06-00-enums.html). Each arm reads its inputs (substituting defaults when missing) and produces an output string.

```rust,no_run
/// Evaluate a single node, given its resolved inputs. Returns its
/// output string, or `None` for terminal nodes.
fn eval_node(
    node: &AgentNode,
    inputs: Vec<Option<String>>,
    results: &mut EvalResults,
) -> Option<String> {
    match node {
        AgentNode::StringNode { value } => Some(value.clone()),

        AgentNode::ChatInput { message } => Some(message.clone()),

        AgentNode::PromptTemplate { template } => {
            // Substitute {0}, {1}, ... with connected inputs in order.
            let mut out = template.clone();
            for (i, inp) in inputs.iter().enumerate() {
                let val = inp.clone().unwrap_or_default();
                out = out.replace(&format!("{{{i}}}"), &val);
            }
            results.logs.push(format!("PromptTemplate → {out}"));
            Some(out)
        }

        AgentNode::LLMNode { model, temperature, system_prompt } => {
            let system = inputs.get(0).cloned().flatten().unwrap_or_else(|| system_prompt.clone());
            let user = inputs.get(1).cloned().flatten().unwrap_or_default();
            let response = simulate_llm(model, *temperature, &system, &user);
            results.logs.push(format!("LLMNode {model} → {response}"));
            Some(response)
        }

        AgentNode::ToolNode { tool } => {
            let query = inputs.get(0).cloned().flatten().unwrap_or_default();
            let result = simulate_tool(tool, &query);
            results.logs.push(format!("Tool {:?}({query}) → {result}", tool));
            Some(result)
        }

        AgentNode::MemoryNode { history } => {
            // In a pure evaluator we can't mutate the node here, so we
            // append to a working copy carried by the caller instead.
            // For the tutorial, emit the existing context as the output.
            Some(history.join("\n"))
        }

        AgentNode::OutputNode => {
            // Terminal: record the value but produce no output pin.
            None
        }
    }
}
```

### Simulated LLM and Tool Execution

For the tutorial we never call a real API — we simulate responses so the code runs anywhere. The simulation is intentionally trivial, which keeps the evaluator deterministic and easy to snapshot-test (see [Chapter 17](./ch17-production.md)). In [Chapter 18](./ch18-conclusion.md) we point at how to swap in real API calls.

```rust,no_run
fn simulate_llm(model: &str, temperature: f32, system: &str, user: &str) -> String {
    // A deterministic, obviously-fake response. Real code would call
    // an API here; see Chapter 18 for pointers to ehttp/reqwest.
    let _ = (model, temperature, system);
    format!("[simulated {model}] You said: {user}")
}

fn simulate_tool(tool: &ToolKind, query: &str) -> String {
    match tool {
        ToolKind::WebSearch => format!("Top result for '{query}': https://example.com/results?q={query}"),
        ToolKind::Calculator => match query.trim().parse::<f64>() {
            Ok(n) => format!("{n}"),
            Err(_) => format!("Not a number: {query}"),
        },
        ToolKind::Weather => format!("Weather for {query}: 21°C, sunny (simulated)"),
    }
}

/// Resolve an `LLMNode`'s two inputs from `results` and produce its full
/// (simulated) response in one shot. This is the convenience wrapper the
/// streaming UI in [Chapter 15](./ch15-live-execution.md) calls to get the
/// complete string before revealing it token-by-token.
fn simulate_llm_response(
    snarl: &Snarl<AgentNode>,
    node_id: NodeId,
    results: &EvalResults,
) -> String {
    let AgentNode::LLMNode { model, temperature, system_prompt } = &snarl[node_id] else {
        return String::new();
    };
    let system = snarl
        .in_pin(InPinId { node: node_id, input: 0 })
        .remotes
        .first()
        .and_then(|out| results.values.get(&out.node))
        .cloned()
        .unwrap_or_else(|| system_prompt.clone());
    let user = snarl
        .in_pin(InPinId { node: node_id, input: 1 })
        .remotes
        .first()
        .and_then(|out| results.values.get(&out.node))
        .cloned()
        .unwrap_or_default();
    simulate_llm(model, *temperature, &system, &user)
}
```

> **Note:** We deliberately mark `temperature` as used (via `_`) in the simulated LLM. In a real implementation, temperature would seed sampling randomness; for deterministic tests you'd want it fixed or stubbed. Keeping the simulation pure is what makes the evaluator unit-testable, which is the whole point of the architecture from [Chapter 5](./ch05-architecture.md).

### A convenience wrapper: `evaluate_node`

`eval_node` above takes a *node* and its already-gathered *inputs* — that is the shape the `GraphEvaluator` loop uses internally. But the UI in [Chapter 15](./ch15-live-execution.md) and the tests in [Chapter 17](./ch17-production.md) want a simpler, single-call entry point: "given the snarl, a node id, and the results computed so far, what is this node's output string?" We expose that as a thin public wrapper that gathers the inputs and delegates to `eval_node`:

```rust,no_run
/// Evaluate one node given the snarl and the results computed so far.
/// Returns the node's output string (empty for terminal `OutputNode`).
/// This is the entry point the streaming UI and the unit tests call.
pub fn evaluate_node(
    snarl: &Snarl<AgentNode>,
    node_id: NodeId,
    results: &EvalResults,
) -> String {
    let node = &snarl[node_id];
    if matches!(node, AgentNode::OutputNode) {
        // Terminal: its received value is already in `results`.
        return results.values.get(&node_id).cloned().unwrap_or_default();
    }
    let inputs = gather_inputs(snarl, node_id, results);
    // `eval_node` borrows `results` mutably only to push log lines; for the
    // read-only wrapper we hand it a throwaway clone so the shared borrow
    // passed in by the caller stays intact.
    let mut tmp = EvalResults { values: results.values.clone(), logs: Vec::new() };
    eval_node(node, inputs, &mut tmp).unwrap_or_default()
}
```

> **Tip:** The wrapper clones `results.values` so it can hand `eval_node` a `&mut EvalResults` (which it uses only to append log lines) without mutating the caller's snapshot. For the streaming UI this is exactly right: it reads a frozen snapshot per step.

## The `GraphEvaluator` Struct

Let's assemble these pieces behind a single `GraphEvaluator` type with an `evaluate()` method that takes `&Snarl<AgentNode>` and returns results (or an error). It also carries an optional working `MemoryNode` history buffer so the `MemoryNode` can accumulate across evaluations in the same session:

```rust,no_run
use egui_snarl::{NodeId, Snarl};

/// A pure-Rust evaluator for agent flow graphs. Holds no `egui` types.
pub struct GraphEvaluator {
    /// Working memory for `MemoryNode`s, keyed by node id, so history
    /// persists across `evaluate` calls in the same session.
    memory: HashMap<NodeId, Vec<String>>,
}

impl GraphEvaluator {
    pub fn new() -> Self {
        Self { memory: HashMap::new() }
    }

    pub fn evaluate(&mut self, snarl: &Snarl<AgentNode>) -> Result<EvalResults, EvalError> {
        let order = topo_sort(snarl)?;
        let mut results = EvalResults::default();

        for id in order {
            let node = &snarl[id];
            // Memory nodes need session-persistent history, so handle them
            // specially: append the incoming value to the working buffer.
            if let AgentNode::MemoryNode { history } = node {
                let buf = self.memory.entry(id).or_default();
                // `history` (the node's serialized field) seeds the buffer
                // on first evaluation; afterwards the buffer is authoritative.
                if buf.is_empty() {
                    buf.extend(history.iter().cloned());
                }
            }

            let inputs = gather_inputs(snarl, id, &results);

            let output = if let AgentNode::MemoryNode { .. } = node {
                let buf = self.memory.entry(id).or_default();
                if let Some(v) = inputs.into_iter().next().and_then(|o| o) {
                    buf.push(v);
                }
                Some(buf.join("\n"))
            } else if let AgentNode::OutputNode = node {
                let final_value = inputs.into_iter().next().and_then(|o| o)
                    .unwrap_or_else(|| "<no input>".into());
                results.logs.push(format!("Output: {final_value}"));
                results.values.insert(id, final_value.clone());
                None
            } else {
                eval_node(node, inputs, &mut results)
            };

            if let Some(out) = output {
                results.values.insert(id, out);
            }
        }

        Ok(results)
    }
}
```

The `OutputNode` is special-cased so its received value lands in `results.values` under its own `NodeId` — that's how the UI can later show "final answer" without a separate field.

### Error Handling in Evaluation

We define a small error enum, following the recoverable-errors guidance from Rust Book [Chapter 9](https://doc.rust-lang.org/stable/book/ch09-00-error-handling.html). We'll expand this enum in [Chapter 17](./ch17-production.md) when we add production error types:

```rust,no_run
use std::fmt;

#[derive(Clone, Debug)]
pub enum EvalError {
    /// The graph contains a cycle; `involved` lists the suspect nodes.
    Cycle { involved: Vec<NodeId> },
    /// A node was missing a required input.
    MissingInput { node: NodeId, input: usize },
    /// A pin's value had an unexpected type (reserved for later typed pins).
    TypeMismatch { node: NodeId, pin: usize, expected: &'static str },
}

impl fmt::Display for EvalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EvalError::Cycle { involved } => write!(
                f, "graph has a cycle involving {} node(s)", involved.len()
            ),
            EvalError::MissingInput { node, input } => write!(
                f, "node {:?} is missing input pin {}", node, input
            ),
            EvalError::TypeMismatch { node, pin, expected } => write!(
                f, "node {:?} pin {} expected {}", node, pin, expected
            ),
        }
    }
}

impl std::error::Error for EvalError {}
```

The two policies worth stating explicitly:

- **Missing inputs** use sensible defaults rather than aborting: a `PromptTemplate` with an unconnected `{0}` substitutes the empty string; an `LLMNode` with no system prompt falls back to its configured `system_prompt` field. This keeps the graph runnable while the user is mid-edit, which is much friendlier than refusing to run. We still *log* the missing input so it shows in the console.
- **Cycles** are fatal — there's no useful default. We return `Cycle` and let the UI surface it.

## Running Evaluation from the UI

Evaluation is pure, so triggering it from the UI is a one-liner — we collect a "run" intent from a button in `ui()` and act on it in `logic()` (or immediately, since it's fast), storing results in app state:

```rust,no_run
use eframe::egui;

pub struct App {
    pub snarl: egui_snarl::Snarl<AgentNode>,
    pub evaluator: GraphEvaluator,
    pub results: Option<Result<EvalResults, EvalError>>,
    /// Set true by the Run button; drained in logic().
    pub run_requested: bool,
}

impl eframe::App for App {
    fn logic(&mut self, _ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if self.run_requested {
            self.run_requested = false;
            self.results = Some(self.evaluator.evaluate(&self.snarl));
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        ui.horizontal(|ui| {
            if ui.button("▶ Run Flow").clicked() {
                self.run_requested = true;
            }
        });
        // ...show the graph and any results...
    }
}
```

> **Tip:** Because evaluation is fast for a tutorial-sized graph, doing it synchronously in `logic()` is fine. For graphs that talk to real APIs, you'd move evaluation off the UI thread — that's the whole subject of [Chapter 15](./ch15-live-execution.md).

## Displaying Evaluated Values on Pins

Once `self.results` holds an `Ok(EvalResults)`, we can show computed values back in the node bodies, mirroring how the bundled egui-snarl demo displays computed output. We extend the viewer's `show_output` to peek at the results and render the value:

```rust,no_run
use std::collections::HashMap;
use egui_snarl::{ui::{PinInfo, SnarlPin, SnarlViewer}, NodeId, OutPin, Snarl};

pub struct AgentViewer {
    pub pending_edits: HashMap<NodeId, AgentNode>,
    /// Snapshot of the latest evaluation results, for inline display.
    pub results: Option<EvalResults>,
}

impl SnarlViewer<AgentNode> for AgentViewer {
    fn show_output(
        &mut self,
        pin: &OutPin,
        ui: &mut egui::Ui,
        _snarl: &mut Snarl<AgentNode>,
    ) -> impl SnarlPin + 'static {
        let id = pin.id.node;
        // ...existing configuration UI elided (see Chapter 13)...

        // If we have a computed value for this node, show it.
        if let Some(results) = &self.results {
            if let Some(val) = results.values.get(&id) {
                ui.label(
                    egui::RichText::new(val)
                        .color(egui::Color32::from_rgb(180, 220, 180))
                        .small(),
                );
            }
        }
        PinInfo::circle().with_fill(egui::Color32::from_rgb(80, 200, 120))
    }
}
```

And the host copies the results snapshot onto the viewer each frame before showing the snarl:

```rust,no_run
impl App {
    fn show_graph(&mut self, ui: &mut egui::Ui) {
        self.viewer.results = self.results.as_ref().ok().cloned();
        egui_snarl::ui::SnarlWidget::new()
            .id_salt(egui::Id::new("agent_graph"))
            .show(&mut self.snarl, &mut self.viewer, ui);
        // apply pending edits, as in Chapter 13
        let pending = std::mem::take(&mut self.viewer.pending_edits);
        for (id, node) in pending {
            self.snarl[id] = node;
        }
    }
}
```

The console logs from `EvalResults::logs` can be rendered in a `Panel::bottom`:

```rust,no_run
egui::Panel::bottom("console").show(ui, |ui| {
    ui.heading("Evaluation log");
    egui::ScrollArea::vertical().show(ui, |ui| {
        if let Some(Ok(results)) = &self.results {
            for line in &results.logs {
                ui.label(line);
            }
        }
    });
});
```

## Keeping the Evaluator Pure

It is worth re-stating why the evaluator module imports nothing from `egui`. Because it depends only on `egui_snarl::{Snarl, NodeId, ...}` (which themselves are plain data types) and `AgentNode` (a pure-data enum), the entire evaluator can be compiled and tested without a window. A headless CI job can construct a `Snarl<AgentNode>` in code, run `evaluate`, and assert on the resulting strings — exactly the testability we argued for in [Chapter 5](./ch05-architecture.md) and exercised in [Chapter 11](./ch11-interactions.md). We'll write those exact tests in [Chapter 17](./ch17-production.md).

> **Module organization.** The functions in this chapter — `topo_sort`, `build_adjacency`, `gather_inputs`, `eval_node` (internal), `evaluate_node` (public wrapper), `simulate_llm`, `simulate_tool`, `simulate_llm_response`, `GraphEvaluator`, `EvalResults`, `EvalError` — should all live in a single `src/eval.rs` file, declared from `main.rs` with `mod eval;` (following the structure from [Chapter 2](./ch02-project-setup.md) and [Chapter 5](./ch05-architecture.md)). [Chapter 15](./ch15-live-execution.md) and [Chapter 17](./ch17-production.md) call `crate::eval::topo_sort`, `crate::eval::evaluate_node`, and `crate::eval::simulate_llm_response`, so keep those exact public names. The key point: all evaluation logic lives in one module with no `egui` dependency, keeping it testable on a headless CI machine.

> **Re-evaluation and `MemoryNode`.** The `GraphEvaluator` carries a `memory: HashMap<NodeId, Vec<String>>` working buffer that persists across `evaluate()` calls. On the first evaluation, the buffer is seeded from the node's serialized `history` field. On subsequent evaluations, the buffer is authoritative — if the user edits the `history` field in the UI between evaluations, the working buffer will not pick up the change. To keep them in sync, either (a) clear the evaluator's `memory` buffer whenever the user edits a `MemoryNode` (detect the edit in `pending_edits`), or (b) re-seed the buffer from the node field at the start of each `evaluate()` call. Option (b) is simpler but loses accumulated context across re-evaluations; option (a) is more correct but requires tracking which nodes were edited.

---

We can now evaluate a static graph in one shot, see results on the pins, and read a trace in the console. But the evaluation is instantaneous — the user clicks *Run* and everything is done before the next frame. That's correct, but it doesn't *feel* like an agent working. In [Chapter 15](./ch15-live-execution.md) we'll turn evaluation into a live, step-by-step process: nodes light up as they run, LLM output streams token-by-token, and a progress bar tracks the walk through the graph.
