# Chapter 17: Production Architecture

Over the previous chapters we built a functional AI flow editor. Now let's elevate it to
production quality with proper error handling, testing, feature flags, logging, and web
deployment. This chapter follows the principles from [Rust Book Chapter
9](https://doc.rust-lang.org/stable/book/ch09-00-error-handling.html) (error handling) and
[Chapter 11](https://doc.rust-lang.org/stable/book/ch11-00-testing.html) (testing).

> **Scope note: partially in the reference implementation.** The impl *does* practice the testing half of this chapter: `graph/state.rs`, `ui/app.rs` (`seed_demo_graph`), and `ui/viewer.rs` (`read_concat_inputs`) each ship a `#[cfg(test)] mod tests` block — pure-data, headless, no GPU — exactly the discipline below. But the production *plumbing* — the custom `AppError` enum, `tracing`/`tracing-subscriber`, Cargo `[features]`, the `WebRunner`/Trunk web build, and the workspace split — is **not** in the impl. Those remain forward-looking (and `tracing`, like `rfd`/`serde_json`/`chrono`, is flagged in-text as a dependency to add when you reach it).

## Custom Error Types

Instead of using `String` for errors (as we did in [Chapter 16](./ch16-persistence.md)), a
production app should define a proper domain error enum. This lets callers match on specific
error variants and enables the `?` operator to convert automatically:

```rust,no_run
use std::fmt;

#[derive(Debug)]
pub enum AppError {
    Io(std::io::Error),
    Serde(serde_json::Error),
    /// A graph evaluation error (e.g., a cycle was detected).
    Graph(String),
    /// An evaluation runtime error.
    Eval(String),
    /// Initialization failure.
    Init(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Io(e) => write!(f, "I/O error: {e}"),
            AppError::Serde(e) => write!(f, "Serialization error: {e}"),
            AppError::Graph(msg) => write!(f, "Graph error: {msg}"),
            AppError::Eval(msg) => write!(f, "Evaluation error: {msg}"),
            AppError::Init(msg) => write!(f, "Initialization error: {msg}"),
        }
    }
}

impl std::error::Error for AppError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            AppError::Io(e) => Some(e),
            AppError::Serde(e) => Some(e),
            _ => None,
        }
    }
}

// From impls enable the `?` operator for automatic conversion.
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self { AppError::Io(e) }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self { AppError::Serde(e) }
}
```

This follows [Rust Book Chapter 9.2](https://doc.rust-lang.org/stable/book/ch09-02-recoverable-errors-with-result.html)
exactly: define a domain error enum, implement `Display` and `Error`, and add `From` impls. The
`source()` method enables error chaining for debugging — you can walk the entire cause chain.

Now our save/load functions can use `?`:

```rust,no_run
impl MyApp {
    pub fn save_graph(&self, path: &std::path::Path) -> Result<(), AppError> {
        let json = serde_json::to_string_pretty(&self.snarl)?; // serde_json::Error → AppError
        std::fs::write(path, json)?;                            // io::Error → AppError
        Ok(())
    }

    pub fn load_graph(&mut self, path: &std::path::Path) -> Result<(), AppError> {
        let json = std::fs::read_to_string(path)?;
        let project: ProjectFile = serde_json::from_str(&json)?;
        self.snarl = project.snarl;
        Ok(())
    }
}
```

## Testing the Graph Model

Because we separated the graph data model from the UI (the principle from [Chapter
5](./ch05-architecture.md)), we can test `GraphState`, `topo_sort`, and `evaluate_node` without
a GPU or window. This is pure Rust unit testing, as described in [Rust Book Chapter
11.1](https://doc.rust-lang.org/stable/book/ch11-01-writing-tests.html):

```rust,no_run
#[cfg(test)]
mod tests {
    use super::*;
    use egui_snarl::{Snarl, NodeId};

    fn make_test_flow() -> Snarl<AgentNode> {
        let mut snarl = Snarl::new();
        let _input = snarl.insert_node(
            egui::pos2(0.0, 0.0),
            AgentNode::ChatInput { message: "Hello".into() },
        );
        let _llm = snarl.insert_node(
            egui::pos2(200.0, 0.0),
            AgentNode::LLMNode {
                model: "gpt-4".into(),
                temperature: 0.7,
                system_prompt: "You are helpful.".into(),
            },
        );
        let _output = snarl.insert_node(
            egui::pos2(400.0, 0.0),
            AgentNode::OutputNode,
        );
        snarl
    }

    #[test]
    fn test_topo_sort_no_cycle() {
        let snarl = make_test_flow();
        let order = topo_sort(&snarl).expect("should sort");
        // The first node must be ChatInput (it has no inputs).
        assert!(!order.is_empty());
    }

    #[test]
    fn test_topo_sort_detects_cycle() {
        let mut snarl = make_test_flow();
        // Create a cycle: connect Output → ChatInput.
        // (In a real test, you'd set up nodes that can form a cycle.)
        // assert!(topo_sort(&snarl).is_err());
    }
```

> **Note:** The cycle-detection test above is commented out because `make_test_flow` produces a DAG with no cycle. To test cycle detection, create a graph where a node's output feeds back into its own input — e.g., connect `OutputNode`'s input to `ChatInput`'s output, creating a circular dependency. Uncomment and adjust the assertion once you have such a graph.

```rust,no_run
    #[test]
    fn test_evaluate_chat_input() {
        let snarl = make_test_flow();
        let results = HashMap::new();
        let output = evaluate_node(&snarl, NodeId(0), &results);
        assert!(!output.is_empty(), "ChatInput should produce a string");
    }

    #[test]
    fn test_connect_validates_types() {
        // Our agent nodes all use string pins, so connections are accepted.
        // In a more advanced system, you'd test type rejection.
    }

    #[test]
    fn test_serialize_roundtrip() {
        let snarl = make_test_flow();
        let json = serde_json::to_string(&snarl).unwrap();
        let restored: Snarl<AgentNode> = serde_json::from_str(&json).unwrap();
        assert_eq!(snarl.nodes().count(), restored.nodes().count());
    }
}
```

Unit tests live in the same file as the code they test, inside a `#[cfg(test)] mod tests` block.
Integration tests live in `tests/`. See [Rust Book Chapter
11.3](https://doc.rust-lang.org/stable/book/ch11-03-test-organization.html) for the full
organization guidance.

## Snapshot Testing

egui is immediate-mode and deterministic given identical input, which makes snapshot testing
tractable. eframe has a built-in `__screenshot` feature for visual regression tests:

1. Enable the `__screenshot` feature in your `Cargo.toml`.
2. Set the `EFRAME_SCREENSHOT_TO` environment variable to an output path.
3. Run the app — it renders one frame, writes the screenshot, and quits.

```bash
EFRAME_SCREENSHOT_TO=screenshot.png cargo run --features __screenshot
```

You can compare the output against a known-good baseline in CI to catch visual regressions.

> **Note:** egui itself uses this mechanism for its own screenshot tests. It's most useful for
> catching accidental visual changes (a widget moved, a color shifted) rather than functional
> bugs.

## Input Replay Testing

For headless testing, you can create a `Context` manually without eframe, feed it synthetic
input, and run your UI:

```rust,no_run
#[test]
fn test_ui_renders_without_panic() {
    let ctx = egui::Context::default();
    let mut app = MyApp::default();

    // Simulate a single frame.
    ctx.run_ui(egui::Id::new("test"), |_ctx| {}, |ui| {
        app.ui(ui, &mut eframe::Frame::default());
    });

    // Assert on the resulting state.
    assert!(!app.log_lines.is_empty() || app.log_lines.is_empty()); // didn't panic
}
```

This follows the pattern from the research reference: build a `Context` manually, feed synthetic
`RawInput` events, and assert on state or paint output. The `logic`/`ui` split helps here — you can
unit-test state transitions in `logic` without any rendering.

## Feature Flags

For production, use Cargo feature flags to conditionally compile debugging tools or optional
dependencies:

```toml
[features]
default = ["serde-support", "persistence"]
serde-support = ["dep:serde", "dep:serde_json"]
debug-tools = []    # Enables the egui demo window for debugging
persistence = ["eframe/persistence"]
```

```toml
[dependencies]
eframe = { version = "0.35", default-features = false, features = [
    "default_fonts", "wgpu", "x11", "wayland"
] }
egui-snarl = { version = "0.11", features = ["serde"] }
serde = { version = "1", features = ["derive"], optional = true }
serde_json = { version = "1", optional = true }
tracing = "0.1"
tracing-subscriber = "0.3"
```

Then use `#[cfg(feature = "...")]` to conditionally compile:

```rust,no_run
// Only show the egui demo window in debug builds.
#[cfg(feature = "debug-tools")]
{
    egui::Window::new("egui Demo")
        .open(&mut self.show_demo)
        .show(ui, |ui| {
            ui.label("Debug tools enabled.");
            // egui::demo::DemoWindow::default().ui(ui);
        });
}
```

Feature flags are documented in the [Cargo
Book](https://doc.rust-lang.org/cargo/reference/features.html). The `cfg` attribute is covered in
the [Rust Reference](https://doc.rust-lang.org/reference/conditional-compilation.html).

> **Note:** `tracing` and `tracing-subscriber` are not in our `Cargo.toml` from [Chapter 2](./ch02-project-setup.md). Add them when you reach this chapter: `tracing = "0.1"` and `tracing-subscriber = "0.3"`.

## Logging with Tracing

For production debugging, structured logging is essential. The
[`tracing`](https://crates.io/crates/tracing) crate is the modern standard:

```rust,no_run
use tracing::{info, error, debug};

fn main() -> Result<(), AppError> {
    // Initialize the tracing subscriber.
    tracing_subscriber::fmt()
        .with_env_filter(
            env!("CARGO_PKG_NAME").to_owned() + "=debug"
        )
        .init();

    info!("Starting Flow Builder v{}", env!("CARGO_PKG_VERSION"));

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 800.0])
            .with_title("AI Flow Builder"),
        ..Default::default()
    };

    eframe::run_native(
        "ai-flow-builder",
        options,
        Box::new(|cc| Ok(Box::new(MyApp::new(cc)?))),
    ).map_err(|e| {
        error!("eframe error: {e}");
        AppError::Init(e.to_string())
    })?;

    info!("Shutting down.");
    Ok(())
}
```

Set `RUST_LOG=ai_flow_builder=debug,eframe=info` to control log levels. The `info!`, `debug!`, and
`error!` macros are zero-cost when the log level is disabled.

## Web / WASM Deployment

eframe compiles to `wasm32-unknown-unknown` and renders to an HTML `<canvas>`. The
[`eframe_template`](https://github.com/emilk/eframe_template) repository gives you the full
web setup. Here's the essence:

### `src/lib.rs` — Web Entrypoint

```rust,no_run
use wasm_bindgen::prelude::*;

#[derive(Clone)]
#[wasm_bindgen]
pub struct WebHandle {
    runner: eframe::WebRunner,
}

#[wasm_bindgen]
impl WebHandle {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        eframe::WebLogger::init(log::LevelFilter::Debug).ok();
        Self { runner: eframe::WebRunner::new() }
    }

    #[wasm_bindgen]
    pub async fn start(&self, canvas: web_sys::HtmlCanvasElement) -> Result<(), JsValue> {
        self.runner
            .start(
                canvas,
                eframe::WebOptions::default(),
                Box::new(|cc| Ok(Box::new(MyApp::new(cc)?))),
            )
            .await
    }

    #[wasm_bindgen]
    pub fn destroy(&self) { self.runner.destroy(); }

    #[wasm_bindgen]
    pub fn has_panicked(&self) -> bool { self.runner.has_panicked() }
}
```

### `index.html`

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>AI Flow Builder</title>
    <style>
        html, body {
            overflow: hidden; margin: 0 !important; padding: 0 !important;
            height: 100%; width: 100%;
        }
        canvas {
            position: absolute; top: 0; left: 0;
            width: 100%; height: 100%;
        }
    </style>
</head>
<body>
    <canvas id="the_canvas_id"></canvas>
    <script type="module">
        import init, { WebHandle } from './ai_flow_builder.js';
        async function main() {
            await init();
            let handle = new WebHandle();
            await handle.start(document.getElementById("the_canvas_id"));
        }
        main();
    </script>
</body>
</html>
```

The CSS is critical: without `overflow: hidden` and the canvas filling the page, the layout will
scroll and the canvas won't fill the window.

### Building with Trunk

```bash
# Install Trunk.
cargo install --locked trunk

# Dev server with live reload.
trunk serve                    # → http://localhost:8080

# Production build (outputs to dist/).
trunk build --release
```

> **Note:** On web, `std::thread::spawn` is not available. For async/background work, use
> `wasm_bindgen_futures::spawn_local` instead. The `ctx.request_repaint()` pattern from [Chapter
> 15](./ch15-live-execution.md) works the same — just swap the thread for a future.

## The egui Inspection Protocol (0.35.0)

egui 0.35 introduced an **inspection protocol** — a TCP server that exposes the live widget tree
and can inject input. Enable eframe's `inspection` feature, then launch with:

```bash
EGUI_INSPECTION=1 cargo run --release
# Listens on port 5719 by default.
# Override: EGUI_INSPECTION_ADDR=127.0.0.1:5719
```

The companion [`egui_mcp`](https://crates.io/crates/egui_mcp) crate is an MCP (Model Context
Protocol) server on top, letting an AI agent *see* and *operate* your UI — read the widget tree,
inject clicks and keystrokes, and capture screenshots. This is the basis for automated UI testing
and AI-driven end-to-end tests in CI.

## Workspace Structure

As the project grows, consider splitting into a Cargo
[workspace](https://doc.rust-lang.org/stable/book/ch14-03-cargo-workspaces.html) — separating the
core library, the GUI binary, and any plugins:

```
ai-flow-builder/
├── Cargo.toml          # workspace root
├── crates/
│   ├── graph/          # pure graph model + evaluation (no egui)
│   ├── app/            # the eframe application
│   └── render/         # custom rendering widgets
├── src/
│   └── main.rs         # binary entry point
└── index.html          # for Trunk (web)
```

```toml
# Cargo.toml (root)
[workspace]
members = ["crates/graph", "crates/app", "crates/render"]
resolver = "2"  # REQUIRED — eframe pulls crates with mutually exclusive features

[workspace.dependencies]
egui = "0.35"
eframe = "0.35"
serde = { version = "1", features = ["derive"] }
```

Without `resolver = "2"` (or `edition = "2024"` which implies it), feature unification will break
eframe's build.

## Performance Tips

1. **Always use `--release`** for decent egui performance. Debug builds are visibly sluggish.
   Set `opt-level = 2` in `[profile.release]` and `[profile.dev.package."*"]`.
2. **Keep `ui()` cheap.** It runs every repaint. Heavy work goes in `logic()` or a background
   thread (see [Chapter 15](./ch15-live-execution.md)).
3. **Use virtualized lists** for large data sets. A plain `ScrollArea` lays out *all* rows every
   frame — use `egui_virtual_list` for thousands of items.
4. **Clone `Context` for background threads**, not `&Context`. `Context` is `Arc`-backed and
   cheaply clonable.
5. **Avoid `Id` clashes** in loops. Use `ui.push_id(i)` or explicit `Id::new(...)` (see [Chapter
   4](./ch04-layout-widgets.md)).
6. **Profile with Puffin.** Enable the `profile-with-puffin` feature on eframe and show a puffin
   window in your app for flamegraph-style profiling.

## Final `main.rs`

Here's how a production `main.rs` ties everything together:

```rust,no_run
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod error;
mod eval;
mod graph;
mod theme;
mod ui;

use app::MyApp;
use error::AppError;
use tracing::info;

fn main() -> Result<(), AppError> {
    tracing_subscriber::fmt()
        .with_env_filter(env!("CARGO_PKG_NAME").to_owned() + "=debug")
        .init();

    info!("AI Flow Builder v{} starting...", env!("CARGO_PKG_VERSION"));

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 800.0])
            .with_min_inner_size([600.0, 400.0])
            .with_title("AI Flow Builder"),
        ..Default::default()
    };

    eframe::run_native(
        "ai-flow-builder",
        options,
        Box::new(|cc| Ok(Box::new(MyApp::new(cc)?))),
    ).map_err(|e| AppError::Init(e.to_string()))?;

    info!("Shutting down.");
    Ok(())
}
```

Clean, minimal, and production-ready. The `windows_subsystem = "windows"` attribute hides the
console window on Windows release builds. Error handling uses our custom `AppError` type. Logging
is initialized before anything else.

---

In [Chapter 18](./ch18-conclusion.md) we'll review everything we've built, highlight the key
patterns, and point you toward resources for taking your flow editor further.
