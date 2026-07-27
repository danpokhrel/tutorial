# Chapter 16: State Persistence

In [Chapter 15](./ch15-live-execution.md) we built a live, streaming evaluation engine. Now we
need the other half of a production editor: the ability to save the user's work and restore it
later. In this chapter we'll cover two layers of persistence — eframe's built-in app-state
persistence and our own manual save/load to JSON files with native file dialogs.

## Two Layers of Persistence

Our flow editor has two distinct kinds of state that need persisting:

1. **Graph data** — the nodes, connections, and configuration that define the user's flow. This
   is the *valuable* state — it represents the user's work and must survive across sessions.
2. **App/UI state** — window position, panel sizes, scroll positions, egui's `Memory`. This is
   *convenience* state — it's nice to restore but not critical.

eframe handles (2) automatically when the `persistence` feature is enabled. We handle (1)
ourselves with serde and file dialogs.

## eframe Built-In Persistence

eframe's persistence is opt-in via the `persistence` feature (enabled by default in our
`Cargo.toml` from [Chapter 2](./ch02-project-setup.md)). When enabled, eframe periodically calls
`App::save()` and restores state in `App::new()`:

```rust,no_run
use eframe;

#[derive(serde::Serialize, serde::Deserialize)]
struct MyApp {
    snarl: egui_snarl::Snarl<AgentNode>,
    snarl_style: egui_snarl::SnarlStyle,
    log_lines: Vec<String>,
    // Note: EvalState is not serialized — it's ephemeral.
}

impl MyApp {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        // Restore from storage if available.
        if let Some(storage = cc.storage {
            return eframe::get_value(storage, eframe::APP_KEY)
                .unwrap_or_default();
        }
        Self::default()
    }
}

impl eframe::App for MyApp {
    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        // Serialize the entire App struct to eframe's RON-based storage.
        eframe::set_value(storage, eframe::APP_KEY, self);
    }
}
```

eframe's `Storage` is a string-to-string map serialized as RON (Rust Object Notation). On native,
it's stored as a file under `eframe::storage_dir()` (the OS data directory, keyed by the app id
passed to `run_native`). On web, it's stored in the browser's Local Storage.

> **Note:** `eframe::APP_KEY` is the standard key for app-level state. You can also use custom
> keys for separate pieces of state (e.g., `"graph"` and `"settings"`). The `get_value` and
> `set_value` helpers are serde convenience wrappers around `Storage::get_string` /
> `Storage::set_string`.

The `save` method is called on shutdown and periodically (every `auto_save_interval()`, which
defaults to 30 seconds). You can override `auto_save_interval` to change the frequency:

```rust,no_run
fn auto_save_interval(&self) -> std::time::Duration {
    std::time::Duration::from_secs(60) // save every minute
}
```

> **Warning:** For `App::save` to work, your `App` struct (and everything inside it) must derive
> `serde::Serialize` and `serde::Deserialize`. The `Snarl<T>` type derives these when the `serde`
> feature is enabled on `egui-snarl` and `T: Serialize + Deserialize`. This is why our `Cargo.toml`
> from [Chapter 2](./ch02-project-setup.md) enables the `serde` feature on `egui-snarl`.

## Manual Save/Load to JSON Files

> **Note:** `serde_json` is not in our `Cargo.toml` from [Chapter 2](./ch02-project-setup.md). Add `serde_json = "1"` to your `[dependencies]` before using the save/load code in this chapter.

eframe's built-in persistence is great for auto-save, but users also want explicit "Save As" and
"Open" file operations. For this, we serialize the `Snarl` to a JSON file using
[`serde_json`](https://crates.io/crates/serde_json):

```rust,no_run
use serde::{Serialize, Deserialize};

/// A project file containing the graph and metadata.
#[derive(Serialize, Deserialize)]
pub struct ProjectFile {
    /// The serialized node graph (nodes, positions, wires).
    pub snarl: egui_snarl::Snarl<AgentNode>,
    /// The version of this file format.
    pub version: String,
    /// Optional metadata.
    pub created: String,
}

impl MyApp {
    /// Save the graph to a JSON file.
    pub fn save_graph(&self, path: &std::path::Path) -> Result<(), String> {
        let project = ProjectFile {
            snarl: self.snarl.clone(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            created: chrono::Local::now().to_rfc3339(),
        };
        let json = serde_json::to_string_pretty(&project)
            .map_err(|e| format!("Serialization error: {e}"))?;
        std::fs::write(path, json)
            .map_err(|e| format!("File write error: {e}"))?;
        Ok(())
    }

    /// Load a graph from a JSON file.
    pub fn load_graph(&mut self, path: &std::path::Path) -> Result<(), String> {
        let json = std::fs::read_to_string(path)
            .map_err(|e| format!("File read error: {e}"))?;
        let project: ProjectFile = serde_json::from_str(&json)
            .map_err(|e| format!("Deserialization error: {e}"))?;
        self.snarl = project.snarl;
        self.eval = EvalState::Idle;
        self.log_lines.clear();
        self.log_lines.push(format!("Loaded graph from {}", path.display()));
        Ok(())
    }
}
```

> **Note:** `chrono` is not in our `Cargo.toml` from [Chapter 2](./ch02-project-setup.md). Add `chrono = "0.4"` to your `[dependencies]` before using it. Alternatively, if you do not need human-readable timestamps, use `std::time::SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)` to get a Unix epoch duration that requires no extra dependency.

We use `Result<(), String>` for human-readable errors and `map_err` to convert `io::Error` and
`serde_json::Error` into our string error type. This follows [Rust Book Chapter
9.2](https://doc.rust-lang.org/stable/book/ch09-02-recoverable-errors-with-result.html) —
recoverable errors returned as `Result`, not panics.

The `ProjectFile` struct wraps the `Snarl` with version metadata. This is important for forward
compatibility: if you change the node format in a future version, you can check the `version`
field and migrate old files.

## Native File Dialogs with `rfd`

The [`rfd`](https://crates.io/crates/rfd) (Rusty File Dialog) crate provides native OS file
dialogs on desktop and async fallbacks on web:

```rust,no_run
use rfd::FileDialog;

impl MyApp {
    /// Show a save dialog and save the graph.
    pub fn save_graph_dialog(&mut self) {
        if let Some(path) = FileDialog::new()
            .add_filter("JSON Flow", &["json"])
            .set_file_name("my-flow.json")
            .save_file()
        {
            if let Err(e) = self.save_graph(&path) {
                self.log_lines.push(format!("Save error: {e}"));
            } else {
                self.log_lines.push(format!("Saved to {}", path.display()));
            }
        }
    }

    /// Show an open dialog and load a graph.
    pub fn open_graph_dialog(&mut self) {
        if let Some(path) = FileDialog::new()
            .add_filter("JSON Flow", &["json"])
            .pick_file()
        {
            if let Err(e) = self.load_graph(&path) {
                self.log_lines.push(format!("Load error: {e}"));
            }
        }
    }
}
```

On native, `rfd::FileDialog::save_file()` and `pick_file()` are blocking calls that show the OS
dialog. On web, `rfd` has async variants (`save_file_async()`, `pick_file_async()`) that use
`wasm-bindgen-futures` under the hood.

> **Tip:** For an in-window, egui-styled file browser (no OS dialog), the
> [`egui_file`](https://crates.io/crates/egui_file) crate is an alternative. It renders a file
> picker as an egui window, which can be more consistent with your app's look and feel.

## The Pending Action Pattern

File dialogs can be async (especially on web), and they shouldn't block `ui()`. The idiomatic
pattern is to use a "pending action" flag — store the action on `App` state, and execute it when
appropriate:

```rust,no_run
/// Actions that need to be processed (file operations, etc.)
pub enum PendingAction {
    SaveGraph(std::path::PathBuf),
    LoadGraph(std::path::PathBuf),
    NewGraph,
    SaveGraphAs,   // trigger the file dialog
    LoadGraphFrom, // trigger the file dialog
}
```

Wire the menu items (from [Chapter 7](./ch07-input-menus.md)) to set pending actions:

```rust,no_run
fn render_menu_bar(ui: &mut egui::Ui, app: &mut MyApp) {
    egui::MenuBar::new().ui(ui, |ui| {
        ui.menu_button("File", |ui| {
            if ui.button("New").clicked() {
                app.pending = Some(PendingAction::NewGraph);
                ui.close();
            }
            if ui.button("Open...").clicked() {
                app.pending = Some(PendingAction::LoadGraphFrom);
                ui.close();
            }
            ui.separator();
            if ui.button("Save").clicked() {
                // If we have a current file, save to it; otherwise trigger dialog.
                if let Some(path) = &app.current_file {
                    app.pending = Some(PendingAction::SaveGraph(path.clone()));
                } else {
                    app.pending = Some(PendingAction::SaveGraphAs);
                }
                ui.close();
            }
            if ui.button("Save As...").clicked() {
                app.pending = Some(PendingAction::SaveGraphAs);
                ui.close();
            }
        });
    });
}
```

Then process pending actions in `logic()` (so `ui()` stays cheap):

```rust,no_run
fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
    match self.pending.take() {
        Some(PendingAction::NewGraph) => {
            self.snarl = Snarl::new();
            self.current_file = None;
            self.eval = EvalState::Idle;
            self.log_lines.clear();
        }
        Some(PendingAction::SaveGraph(path)) => {
            if let Err(e) = self.save_graph(&path) {
                self.log_lines.push(format!("Save error: {e}"));
            }
        }
        Some(PendingAction::LoadGraph(path)) => {
            if let Err(e) = self.load_graph(&path) {
                self.log_lines.push(format!("Load error: {e}"));
            }
        }
        Some(PendingAction::SaveGraphAs) => {
            if let Some(path) = rfd::FileDialog::new()
                .add_filter("JSON Flow", &["json"])
                .set_file_name("my-flow.json")
                .save_file()
            {
                self.current_file = Some(path.clone());
                self.pending = Some(PendingAction::SaveGraph(path));
                ctx.request_repaint();
            }
        }
        Some(PendingAction::LoadGraphFrom) => {
            if let Some(path) = rfd::FileDialog::new()
                .add_filter("JSON Flow", &["json"])
                .pick_file()
            {
                self.current_file = Some(path.clone());
                self.pending = Some(PendingAction::LoadGraph(path));
                ctx.request_repaint();
            }
        }
        None => {}
    }
}
```

This pattern — set a flag in `ui()`, process it in `logic()` — is the same deferred-execution
approach used in the reference tutorial's context-menu node creation. It keeps the rendering path
clean and lets you centralize mutation logic.

## Auto-Save

eframe's `auto_save_interval` handles periodic saves to the built-in `Storage`. But you may also
want auto-save to the user's last-saved file. A simple approach: track the last modification time
and save if it's been more than N seconds since the last save:

```rust,no_run
struct MyApp {
    last_modified: Option<std::time::Instant>,
    last_autosave: Option<std::time::Instant>,
}

impl eframe::App for MyApp {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // If the graph was modified and 30s have passed since last autosave...
        if let (Some(modified), Some(last_save)) = (self.last_modified, self.last_autosave) {
            if modified > last_save && modified.elapsed().as_secs() > 30 {
                if let Some(path) = &self.current_file {
                    let _ = self.save_graph(path);
                    self.last_autosave = Some(std::time::Instant::now());
                    self.log_lines.push("(auto-saved)".into());
                }
            }
        }
        // Request a periodic repaint to check auto-save timers.
        ctx.request_repaint_after(std::time::Duration::from_secs(5));
    }
}
```

`ctx.request_repaint_after(duration)` schedules a repaint after the given duration, which triggers
`logic()` — perfect for periodic tasks like auto-save.

## Keyboard Shortcuts

A production editor should support Ctrl+S for save and Ctrl+O for open. We use the
`KeyboardShortcut` API from [Chapter 7](./ch07-input-menus.md):

```rust,no_run
fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
    let save_shortcut = egui::KeyboardShortcut::new(egui::Modifiers::CTRL, egui::Key::S);
    let open_shortcut = egui::KeyboardShortcut::new(egui::Modifiers::CTRL, egui::Key::O);

    ctx.input_mut(|i| {
        if i.consume_shortcut(&save_shortcut) {
            if let Some(path) = &self.current_file {
                self.pending = Some(PendingAction::SaveGraph(path.clone()));
            } else {
                self.pending = Some(PendingAction::SaveGraphAs);
            }
        }
        if i.consume_shortcut(&open_shortcut) {
            self.pending = Some(PendingAction::LoadGraphFrom);
        }
    });

    // ... process pending actions ...
}
```

`consume_shortcut` (rather than `key_pressed`) prevents the same shortcut from firing twice when
multiple widgets check it. See [Chapter 7](./ch07-input-menus.md) for the full discussion.

## What Gets Serialized?

It's important to be deliberate about what you serialize. The `Snarl<AgentNode>` (with the `serde`
feature) serializes:
- The node data (your `AgentNode` enum, which derives `Serialize`/`Deserialize`)
- Node positions (stored in the `Snarl`)
- Wires/connections (stored in the `Snarl`)

It does **not** serialize:
- `EvalState` — ephemeral, resets each session
- `log_lines` — ephemeral
- `SnarlStyle` — can be recreated from code (though you can serialize it too if you want
  user-customizable styling)
- `current_file` path — this is UI state, not graph data

This separation follows the principle from [Chapter 5](./ch05-architecture.md): persistent data
(graph, configuration) is separate from ephemeral UI state (evaluation progress, log lines, which
panel is open). Keeping them in separate structs makes the serialization boundary explicit.

---

With persistence in place, our flow editor is a functional, usable application — users can build,
run, save, and restore their AI flows. In [Chapter 17](./ch17-production.md) we'll take the final
step to production: custom error types, testing, feature flags, logging, and web/WASM deployment.
