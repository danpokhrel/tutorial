# Chapter 15: Live Execution & Streaming

In [Chapter 14](./ch14-graph-evaluation.md) we built a graph evaluation engine that computes the
output of every node in topological order. But it ran all at once — the user clicks "Evaluate" and
gets the final result. Real agentic AI flow builders like Langflow and Flowise make execution feel
*alive*: you watch each node light up in turn, you see LLM output stream token by token, and you
can stop mid-run. In this chapter we bring that real-time experience to our flow editor.

## From One-Shot to Streaming

The key insight is that **egui's repaint model is on-demand**. When the window is idle, no CPU is
wasted. When we want to show progress, we need to drive repaints ourselves with
`ctx.request_repaint()`. This gives us a natural mechanism for stepping through evaluation:

1. The user clicks "Run Flow".
2. We enter a `Running` state and evaluate **one node** per `logic()` call.
3. After each node, we call `ctx.request_repaint()` so the UI updates to show progress.
4. When all nodes are done, we transition to `Done`.

This keeps `ui()` cheap — it only reads the current evaluation state and renders it. The actual
work happens in `logic()`, which is exactly the separation the 0.34 `logic`/`ui` split was
designed for.

> **Note:** `logic()` runs once before each `ui()` call, and additionally when the UI is hidden but
> a repaint was requested. This means our stepping loop continues even if the user minimizes the
> window — a nice property for long-running flows.

## The Evaluation State Machine

Let's define an enum to track where we are in the evaluation lifecycle. Rust enums (covered in
[Rust Book Chapter 6](https://doc.rust-lang.org/stable/book/ch06-00-enums.html)) are perfect for
modeling a finite state machine:

```rust,no_run
use egui_snarl::NodeId;

/// Tracks the state of a live graph evaluation.
pub enum EvalState {
    /// No evaluation is running.
    Idle,
    /// Evaluation is in progress. `remaining` is the list of nodes
    /// still to evaluate, in topological order. `step` is how many
    /// we have completed so far (for the progress bar).
    Running {
        order: Vec<NodeId>,
        remaining: Vec<NodeId>,
        step: usize,
        results: std::collections::HashMap<NodeId, String>,
    },
    /// Evaluation completed successfully.
    Done {
        results: std::collections::HashMap<NodeId, String>,
    },
    /// Evaluation failed (e.g., a cycle was detected).
    Error(String),
}
```

Each variant carries the data it needs. `Running` holds the topological order, the remaining nodes,
the current step count, and a map of evaluated results. This is the same collect-then-mutate
philosophy from [Chapter 5](./ch05-architecture.md) — the state is owned by `App`, mutated in
`logic()`, and read in `ui()`.

## Starting the Evaluation

When the user clicks "Run Flow", we compute the topological order and enter the `Running` state:

```rust,no_run
use crate::eval::topo_sort;

impl MyApp {
    fn start_eval(&mut self) {
        match topo_sort(&self.snarl) {
            Ok(order) => {
                self.eval = EvalState::Running {
                    order: order.clone(),
                    remaining: order,
                    step: 0,
                    results: Default::default(),
                };
            }
            Err(e) => {
                self.eval = EvalState::Error(format!("Cannot evaluate: {e}"));
            }
        }
    }
}
```

If the graph has a cycle, `topo_sort` returns an error and we display it immediately. This follows
[Rust Book Chapter 9](https://doc.rust-lang.org/stable/book/ch09-02-recoverable-errors-with-result.html) —
recoverable errors are returned as `Result`, not panics.

## Stepping in `logic()`

The heart of the streaming evaluation lives in `logic()`. Each call evaluates **one** node from the
`remaining` list, stores its result, and requests a repaint:

```rust,no_run
impl eframe::App for MyApp {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Take ownership of the current eval state so we can replace it.
        let eval = std::mem::replace(&mut self.eval, EvalState::Idle);

        match eval {
            EvalState::Running {
                mut order,
                mut remaining,
                mut step,
                mut results,
            } => {
                if let Some(&node_id) = remaining.first() {
                    // Evaluate this one node.
                    let result = crate::eval::evaluate_node(
                        &self.snarl,
                        node_id,
                        &results,
                    );
                    results.insert(node_id, result);
                    remaining.remove(0);
                    step += 1;

                    // Update the log panel.
                    self.log_lines.push(format!(
                        "[{}/{}] Evaluated node {:?}",
                        step,
                        order.len(),
                        node_id
                    ));

                    if remaining.is_empty() {
                        // All done!
                        self.eval = EvalState::Done { results };
                    } else {
                        // Keep going — request a repaint to continue.
                        self.eval = EvalState::Running {
                            order,
                            remaining,
                            step,
                            results,
                        };
                        ctx.request_repaint();
                    }
                }
            }
            // Idle, Done, or Error — nothing to do in logic().
            other => self.eval = other,
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // ... render panels, graph, and console ...
    }
}
```

The critical line is `ctx.request_repaint()`. Without it, egui would not call `logic()` again —
the evaluation would freeze after the first node. By requesting a repaint, we tell egui "something
changed, run another frame," which triggers another `logic()` call, which evaluates the next node,
and so on until `remaining` is empty.

> **Warning:** Never do heavy computation in `ui()`. It can be called many times per second and
> will make the app feel sluggish. All evaluation work belongs in `logic()` (or a background
> thread). See [Chapter 5](./ch05-architecture.md) for the full discussion.
>
> **What counts as "heavy"?** As a rule of thumb: anything that takes more than a few milliseconds per call. Reading from a `HashMap`, formatting a string, or building a handful of widgets is fine. Parsing JSON, sorting large vectors, or calling network APIs is not. Our graph evaluator (stepping one node per `logic()` call) is deliberately lightweight — each step is a single `match` on a node variant plus a string operation. If your evaluator does real I/O (LLM API calls), move it to a background thread as shown later in this chapter.

## Rendering Progress in `ui()`

In the UI, we read the evaluation state to show a progress bar and highlight the currently-running
node:

```rust,no_run
fn render_status_bar(ui: &mut egui::Ui, eval: &EvalState) {
    match eval {
        EvalState::Idle => {
            ui.label("Idle — click Run to evaluate the flow.");
        }
        EvalState::Running { order, step, .. } => {
            let progress = *step as f32 / order.len().max(1) as f32;
            ui.add(egui::ProgressBar::new(progress)
                .desired_width(200.0)
                .text(format!("Evaluating {}/{}", step, order.len())));
        }
        EvalState::Done { .. } => {
            ui.colored_label(egui::Color32::from_green(0x3f), "✓ Evaluation complete.");
        }
        EvalState::Error(msg) => {
            ui.colored_label(egui::Color32::from_red(0xb0), format!("Error: {msg}"));
        }
    }
}
```

We can also highlight the currently-evaluating node in the graph by checking whether a node ID
matches the first element of `remaining`:

```rust,no_run
// In the SnarlViewer's header_frame override:
fn header_frame(
    &mut self,
    frame: egui::Frame,
    node: NodeId,
    _inputs: &[InPin],
    _outputs: &[OutPin],
    _snarl: &Snarl<AgentNode>,
) -> egui::Frame {
    // If this is the currently-evaluating node, highlight it.
    if let EvalState::Running { remaining, .. } = &self.eval_state {
        if remaining.first() == Some(&&node) {
            return frame
                .fill(egui::Color32::from_rgb(60, 80, 120))
                .stroke(egui::Stroke::new(2.0, egui::Color32::from_rgb(100, 150, 255)));
        }
    }
    frame
}
```

This gives the user visual feedback — the currently-evaluating node lights up with a blue border,
then returns to normal as the evaluation moves on.

## The Run and Stop Buttons

We need UI controls to start and cancel evaluation. Let's add them to a toolbar:

```rust,no_run
fn render_toolbar(ui: &mut egui::Ui, app: &mut MyApp) {
    ui.horizontal(|ui| {
        let is_running = matches!(app.eval, EvalState::Running { .. });

        ui.add_enabled_ui(!is_running, |ui| {
            if ui.button("▶ Run Flow").clicked() {
                app.start_eval();
            }
        });

        ui.add_enabled_ui(is_running, |ui| {
            if ui.button("⏹ Stop").clicked() {
                app.eval = EvalState::Idle;
                app.log_lines.push("Evaluation stopped by user.".into());
            }
        });

        if ui.button("Clear Results").clicked() {
            app.eval = EvalState::Idle;
            app.log_lines.clear();
        }
    });
}
```

The `add_enabled_ui` method (from [Chapter 4](./ch04-layout-widgets.md)) disables the Run button
while a run is in progress and disables Stop when idle. This prevents the user from starting two
evaluations simultaneously.

## A Console Panel

Real flow builders show a log of what happened during execution. Let's add a bottom panel that
displays the log lines:

```rust,no_run
// In the App::ui method, add the bottom panel BEFORE the central panel:
egui::Panel::bottom("console")
    .default_height(160.0)
    .resizable(true)
    .show(ui, |ui| {
        ui.heading("Execution Log");
        ui.separator();
        egui::ScrollArea::vertical().show(ui, |ui| {
            for line in &app.log_lines {
                ui.label(line);
            }
        });
    });
```

Remember from [Chapter 4](./ch04-layout-widgets.md): panels must be added in the right order.
`Panel::bottom` should come before `CentralPanel` so the central panel shrinks to fill the
remaining space.

## Simulating Token-by-Token Streaming

For LLM nodes, real agentic AI tools stream the response token by token. We can simulate this by
splitting the LLM's output into chunks and revealing them progressively across multiple `logic()`
calls:

```rust,no_run
EvalState::Running {
    mut order,
    mut remaining,
    mut step,
    mut results,
} => {
    if let Some(&node_id) = remaining.first() {
        // Get the node data.
        let node = &self.snarl[node_id];

        // For LLM nodes, simulate streaming: if we already have a partial
        // result, append the next "token"; otherwise start generating.
        let current = results.get(&node_id).cloned().unwrap_or_default();

        if let AgentNode::LLMNode { .. } = node {
            let full_response = crate::eval::simulate_llm_response(&self.snarl, node_id, &results);
            let tokens: Vec<&str> = full_response.split_whitespace().collect();
            let current_tokens = current.split_whitespace().count();

            if current_tokens < tokens.len() {
                // Reveal one more token.
                let next = tokens[..current_tokens + 1].join(" ");
                results.insert(node_id, next);
                // Don't advance — come back next frame for the next token.
                // Request repaint to continue streaming.
                self.eval = EvalState::Running { order, remaining, step, results };
                ctx.request_repaint();
                return;
            }
            // All tokens revealed — move to the next node.
        }

        // For non-LLM nodes, evaluate immediately.
        let result = crate::eval::evaluate_node(&self.snarl, node_id, &results);
        results.insert(node_id, result);
        remaining.remove(0);
        step += 1;
        // ... update log, check if done ...
    }
}
```

This pattern — keeping a node in `remaining` until its streaming is complete, then removing it —
gives us realistic-looking output without any real API calls. In a production app, you would replace
the simulated streaming with a real HTTP request to an LLM API using `ehttp` or `reqwest`, as
discussed in [Chapter 18](./ch18-conclusion.md).

## Background Thread Evaluation

For genuinely long-running work (real API calls, heavy computation), you should move evaluation to
a background thread. The pattern from [Chapter 5](./ch05-architecture.md) applies:

```rust,no_run
use std::sync::{Arc, Mutex};
use std::sync::mpsc::{channel, Receiver};

struct MyApp {
    // Results arrive from the background thread through this channel.
    eval_rx: Option<Receiver<(NodeId, String)>>,
    // Shared state for the background thread to read graph data.
    graph_snapshot: Arc<Mutex<Vec<(NodeId, AgentNode)>>>,
}

impl MyApp {
    fn start_background_eval(&mut self, ctx: &egui::Context) {
        let (tx, rx) = channel();
        self.eval_rx = Some(rx);

        // Snapshot the graph for the background thread (Snarl is not Send
        // if it contains non-Send data, so we extract what we need).
        let snapshot = Arc::new(Mutex::new(
            self.snarl.nodes_ids_data().collect::<Vec<_>>()
        ));
        self.graph_snapshot = snapshot.clone();

        let ctx = ctx.clone(); // Context is Arc-backed, cheaply clonable.
        std::thread::spawn(move || {
            let graph = snapshot.lock().unwrap();
            let order = crate::eval::topo_sort_from_snapshot(&graph).unwrap();
            drop(graph); // Release the lock before evaluating.

            let mut results = std::collections::HashMap::new();
            for &node_id in &order {
                let result = crate::eval::evaluate_snapshot(&snapshot, node_id, &results);
                results.insert(node_id, result.clone());
                // Send the result to the UI thread.
                let _ = tx.send((node_id, result));
                // Wake the UI to show the new result.
                ctx.request_repaint();
            }
        });
    }
}
```

Then in `logic()`, we drain the channel:

```rust,no_run
fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
    if let Some(rx) = &self.eval_rx {
        while let Ok((node_id, result)) = rx.try_recv() {
            self.eval_results.insert(node_id, result);
            self.log_lines.push(format!("Evaluated node {node_id:?}"));
        }
    }
}
```

The `while let Ok(...)` loop drains all available results each frame. If the channel is empty, it
returns immediately — no blocking. The background thread calls `ctx.request_repaint()` each time
it sends a result, so the UI wakes up to process it.

> **Tip:** On web (WASM), `std::thread` is not available. Use
> `wasm_bindgen_futures::spawn_local` instead, and `ctx.request_repaint()` when the async task
> completes. The channel-based pattern works the same — just swap the thread for a future. See
> [Chapter 17](./ch17-production.md) for the full web setup.

## Keeping `ui()` Cheap

This is the most important rule of streaming egui apps: **`ui()` must be fast**. It can be called
many times per second, and if it blocks, the entire app freezes. All the patterns in this chapter
follow this principle:

- Evaluation happens in `logic()` (one step per call) or a background thread.
- `ui()` only *reads* the current state and renders it.
- The `request_repaint()` calls ensure `logic()` keeps being called until the evaluation is done.
- The console panel uses a `ScrollArea` so it doesn't re-lay-out all log lines if there are
  thousands (though for truly massive logs, consider a virtualized list from
  [Chapter 4](./ch04-layout-widgets.md)).

> **Tip:** For the streaming-LLM-tokens loop, `ctx.request_repaint_after(Duration::from_millis(50))` is more appropriate than `ctx.request_repaint()`. The small delay makes each token visible to the user rather than rendering them all in a rapid burst of frames. The `request_repaint_after` method schedules a single repaint after the given duration — perfect for pacing visible output.

## Putting It Together

Here's the complete `App::ui` method with all the panels wired up:

```rust,no_run
fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
    // 1. Top panel: toolbar with Run/Stop/Clear buttons.
    egui::Panel::top("toolbar").show(ui, |ui| {
        crate::ui::render_toolbar(ui, self);
    });

    // 2. Bottom panel: execution log (resizable).
    egui::Panel::bottom("console")
        .default_height(140.0)
        .resizable(true)
        .show(ui, |ui| {
            ui.heading("Execution Log");
            ui.separator();
            egui::ScrollArea::vertical().show(ui, |ui| {
                for line in &self.log_lines {
                    ui.label(line);
                }
            });
        });

    // 3. Left panel: status and results.
    egui::Panel::left("status")
        .default_width(240.0)
        .resizable(true)
        .show(ui, |ui| {
            crate::ui::render_status_bar(ui, &self.eval);
            ui.separator();
            ui.heading("Results");
            egui::ScrollArea::vertical().show(ui, |ui| {
                let results = match &self.eval {
                    EvalState::Done { results } | EvalState::Running { results, .. } => results,
                    _ => &self.eval_results,
                };
                for (&id, value) in results {
                    ui.label(format!("{id:?}: {value}"));
                }
            });
        });

    // 4. Central panel: the node graph.
    egui::CentralPanel::default().show(ui, |ui| {
        SnarlWidget::new()
            .id_salt(egui::Id::new("flow-snarl"))
            .style(self.snarl_style)
            .show(&mut self.snarl, &mut self.viewer, ui);
    });
}
```

The panel ordering follows the rules from [Chapter 4](./ch04-layout-widgets.md): top and bottom
panels first, then side panel, then central panel last so it fills the remaining space.

---

We now have a live, streaming evaluation engine that shows progress in real time. The final piece
of production functionality is persistence — saving and loading the graph so the user's work
survives across sessions. In [Chapter 16](./ch16-persistence.md) we'll cover eframe's built-in
persistence, manual save/load with serde, and native file dialogs.
The final piece
of production functionality is persistence — saving and loading the graph so the user's work
survives across sessions. In [Chapter 16](./ch16-persistence.md) we'll cover eframe's built-in
persistence, manual save/load with serde, and native file dialogs.
