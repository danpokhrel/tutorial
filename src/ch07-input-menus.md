# Chapter 7: Input, Menus & Dialogs

An application is more than a display of data — it responds to the keyboard, the mouse, menus, and dialogs. In this chapter we'll cover egui's input system, build a menu bar with dropdowns, add right-click context menus, open floating windows, implement a modal dialog from scratch (egui has no built-in one), and wire up native file dialogs with the `rfd` crate. By the end we'll assemble all of it into a single example app. This chapter assumes you have read [Chapter 5](./ch05-architecture.md) on structuring your app and [Chapter 6](./ch06-theming.md) on theming.

## Input Handling

All input state lives on the `egui::Context`. Because the context's input is guarded by an internal lock, you access it through **closures** — you must never hold the lock across widget building. The closure form `ctx.input(|i| ...)` takes a shared borrow, runs your closure, and releases the lock before returning:

```rust,no_run
use eframe::egui;

impl eframe::App for MyApp {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Read-only input access via a closure.
        let save_pressed = ctx.input(|i| {
            i.key_pressed(egui::Key::S)
                && (i.modifiers.ctrl || i.modifiers.command)
        });
        if save_pressed {
            self.save();
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // ...
    }
}
```

> **Warning:** Never store the `egui::InputState` returned by the closure outside it, and never call `ui.add(...)` from inside the closure. The lock must be released before you build widgets, or you will deadlock or panic. The closure form makes this impossible to get wrong — the borrow ends when the closure returns.

For mutations — consuming an event so no one else sees it — use `ctx.input_mut`:

```rust,no_run
ctx.input_mut(|i| {
    if i.key_pressed(egui::Key::Escape) {
        i.events.clear(); // consume remaining events this frame
    }
});
```

> **When to use `input_mut`:** You rarely need it. The main use case is `consume_shortcut`, which marks a shortcut as handled so it does not fire twice. For simply reading input state, always use `ctx.input(|i| ...)` (the shared borrow). Mutating input state outside of shortcut consumption is almost never necessary.

Every widget you add to a `Ui` returns a `Response`, which tells you how the user interacted with *that specific widget*. This is the primary way to react to clicks, hovers, and drags:

```rust,no_run
let response = ui.button("Click me");
if response.clicked() {
    println!("clicked");
}
if response.hovered() {
    println!("hovered");
}
// Tooltips and context menus are also methods on Response.
response.on_hover_text("This button does a thing");
```

The most useful `Response` methods are:

| Method | Meaning |
|---|---|
| `clicked()` | The widget was clicked this frame. |
| `hovered()` | The pointer is over the widget. |
| `dragged()` | The widget is being dragged (button held + moved). |
| `drag_delta()` | How far it moved since last frame. |
| `on_hover_text(s)` | Show a tooltip. |
| `context_menu(|ui| ...)` | Attach a right-click menu. |

Because `Response` is returned by value, you can collect interaction results and act on them after the immutable borrow ends — the collect-then-mutate pattern from [Chapter 5](./ch05-architecture.md).

## Keyboard Shortcuts

For structured shortcuts, use `KeyboardShortcut` and `consume_shortcut`. This pairs a `Modifiers` value with a `Key` and lets egui handle the bookkeeping of whether the shortcut was pressed *and* not yet consumed:

```rust,no_run
use eframe::egui;

impl eframe::App for MyApp {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let new_shortcut = egui::KeyboardShortcut::new(
            egui::Modifiers::CTRL,
            egui::Key::N,
        );
        let open_shortcut = egui::KeyboardShortcut::new(
            egui::Modifiers::CTRL,
            egui::Key::O,
        );

        ctx.input_mut(|i| {
            if i.consume_shortcut(&new_shortcut) {
                self.new_document();
            }
            if i.consume_shortcut(&open_shortcut) {
                self.open_document();
            }
        });
    }

    fn ui(&mut self, _ui: &mut egui::Ui, _frame: &mut eframe::Frame) {}
}
```

`consume_shortcut` returns `true` only if the shortcut was pressed this frame and has not already been consumed, which prevents double-handling when multiple widgets listen for the same key. The pattern of branching on a value and running code per arm is the same `match`-style flow control introduced in Rust Book [Chapter 6](https://doc.rust-lang.org/stable/book/ch06-02-match.html).

## Mouse Input

Mouse state is part of the same input closure:

```rust,no_run
ctx.input(|i| {
    let pos = i.pointer.primary_pressed(); // Option<Pos2> on press
    let _hover = i.pointer.hover_pos();    // Option<Pos2> current pos
    let _mods = i.modifiers;               // Modifiers (ctrl, shift, ...)
    let _clicked = i.pointer.primary_clicked();
});
```

`pointer.primary_pressed()` fires on the frame the button goes down; `primary_clicked()` fires on a completed click (down then up without much movement). Use `hover_pos()` for things like cursor-following tooltips.

## Menu Bars

A top menu bar is a `Panel::top` containing a `MenuBar` closure. Inside, `ui.menu_button` creates a dropdown, and `ui.close()` closes it programmatically (useful after an action that should dismiss the menu):

```rust,no_run
use eframe::egui;

impl eframe::App for MyApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::Panel::top("menu_bar").show(ui, |ui| {
            egui::MenuBar::new().ui(ui, |ui| {
                ui.menu_button("File", |ui| {
                    if ui.button("New").clicked() {
                        self.new_document();
                        ui.close();
                    }
                    if ui.button("Open...").clicked() {
                        self.open_document();
                        ui.close();
                    }
                    if ui.button("Save").clicked() {
                        self.save();
                        ui.close();
                    }
                    ui.separator();
                    if ui.button("Quit").clicked() {
                        ui.ctx().send_viewport_cmd(
                            egui::ViewportCommand::Close,
                        );
                    }
                });
                ui.menu_button("Edit", |ui| {
                    if ui.button("Undo").clicked() {
                        self.undo();
                        ui.close();
                    }
                });
            });
        });
    }
}
```

Recall from [Chapter 5](./ch05-architecture.md) that `Panel::show` takes a `&mut Ui` (since 0.34). The menu items are ordinary buttons; their `clicked()` results drive your app state.

## Context Menus

Right-click menus attach to any `Response`:

```rust,no_run
let response = ui.label("Right-click me");
response.context_menu(|ui| {
    if ui.button("Rename").clicked() {
        self.ui_state.renaming = true;
        ui.close();
    }
    if ui.button("Delete").clicked() {
        self.delete_selected();
        ui.close();
    }
    ui.separator();
    if ui.button("Duplicate").clicked() {
        self.duplicate_selected();
        ui.close();
    }
});
```

The menu appears automatically when the user right-clicks the widget and disappears when an item is chosen or the user clicks elsewhere. No extra state is required on your part.

## Floating Windows

`egui::Window` is a floating, draggable, collapsible, resizable panel — the kind of window you'd use for a settings dialog or a tool palette. Its `.show` method takes a `&mut Ui` and a closure that builds its contents:

```rust,no_run
use eframe::egui;

impl eframe::App for MyApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // A toggle button controls the window's visibility.
        ui.checkbox(&mut self.ui_state.settings_open, "Settings");

        if self.ui_state.settings_open {
            egui::Window::new("Settings")
                .open(&mut self.ui_state.settings_open)
                .default_pos([100.0, 100.0])
                .resizable(true)
                .collapsible(true)
                .show(ui, |ui| {
                    ui.label("Application settings");
                    ui.separator();
                    ui.checkbox(&mut self.config.autosave, "Autosave");
                    ui.add(
                        egui::Slider::new(&mut self.config.zoom, 0.5..=3.0)
                            .text("Zoom"),
                    );
                });
        }
    }
}
```

The `.open(&mut bool)` argument binds the window's open state to a flag. When the user clicks the window's close button (the X), egui sets the flag to `false`, which is how you detect that the user dismissed it.

## Modal Dialogs

egui 0.35 introduced a built-in **`egui::Modal`** widget — `Modal::new(id).show(ctx, |ui| ...)` returns a `ModalResponse<T>` with a `backdrop_response` you can check for click-to-dismiss. This is the recommended approach: it handles the dimming, click-capture, and centering for you, so you do not have to hand-roll an `Area` + `Window` stack.

A quit-confirmation modal is a one-screen read once you have it. Gate it behind a `quit_modal_open: bool` on your `App`, render it only while the flag is set, and dismiss it on Cancel, Escape, backdrop click, or a confirmed Quit:

```rust,no_run
use eframe::egui;

impl eframe::App for MyApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // ... your normal panels ...

        // --- Quit confirmation modal (egui 0.35's built-in Modal) ---
        if self.quit_modal_open {
            let resp = egui::Modal::new(egui::Id::new("quit_modal")).show(ui.ctx(), |ui| {
                ui.set_min_width(280.0);
                ui.heading("Quit");
                ui.label("Quit the application?");
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    // Cancel on the button or the Escape key.
                    let cancel = ui.button("Cancel").clicked()
                        || ui.input(|i| i.key_pressed(egui::Key::Escape));
                    if cancel {
                        self.quit_modal_open = false;
                    }
                    // Confirm on the button or Enter.
                    let quit = ui.button("Quit").clicked()
                        || ui.input(|i| i.key_pressed(egui::Key::Enter));
                    if quit {
                        ui.ctx().send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                });
            });
            // Clicking the dimmed backdrop also dismisses the modal.
            if resp.backdrop_response.clicked() {
                self.quit_modal_open = false;
            }
        }
    }
}
```

> **Tip: intercept the window's close button too.** The OS window-manager close (X) button bypasses your modal by default. To route it through the same confirmation, check `ctx.input(|i| i.viewport().close_requested())` in `logic()` and, when the modal is *not* already open, send `ViewportCommand::CancelClose` and set `quit_modal_open = true`. If the modal is already open, let the request through — the user is insisting. The reference implementation's `App::logic` does exactly this; see ["The Assembled App"](./ch11-interactions.md#the-assembled-app) in [Chapter 11](./ch11-interactions.md).

Below, for completeness and for cases where you need fine-grained control over the dimming/layering that `Modal` does not expose, is the manual `Area + Window` pattern. In practice, prefer `egui::Modal`.

```rust,no_run
use eframe::egui;

pub struct ConfirmModal {
    pub open: bool,
    pub message: String,
    pub on_confirm: bool, // set true when user confirms
}

impl ConfirmModal {
    /// Render the modal. Returns Some(true) if confirmed,
    /// Some(false) if cancelled, None otherwise.
    pub fn show(&mut self, ui: &mut egui::Ui) -> Option<bool> {
        if !self.open {
            return None;
        }

        let mut result = None;

        // Dim the rest of the screen and capture clicks.
        let screen = ui.ctx().screen_rect();
        egui::Area::new(egui::Id::new("modal_dimmer"))
            .order(egui::Order::Foreground)
            .fixed_pos(screen.min)
            .show(ui, |ui| {
                // A transparent-but-clickable layer over the whole screen.
                let _ =
                    ui.allocate_rect(screen, egui::Sense::click());
                let painter = ui.painter();
                painter.rect_filled(
                    screen,
                    egui::CornerRadius::ZERO,
                    egui::Color32::from_black_alpha(120),
                );
            });

        // The dialog itself, centered.
        let dialog_size = egui::vec2(320.0, 140.0);
        let pos = screen.center() - dialog_size / 2.0;
        egui::Window::new("Confirm")
            .order(egui::Order::Foreground)
            .fixed_pos(pos)
            .resizable(false)
            .collapsible(false)
            .movable(false)
            .show(ui, |ui| {
                ui.set_min_width(dialog_size.x);
                ui.label(&self.message);
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    if ui.button("Cancel").clicked() {
                        result = Some(false);
                    }
                    if ui.button("OK").clicked() {
                        result = Some(true);
                    }
                });
            });

        if let Some(confirmed) = result {
            self.open = false;
            Some(confirmed)
        } else {
            None
        }
    }
}
```

The dimming `Area` is drawn first with `Order::Foreground` and allocates the full screen rect with `Sense::click()`, which "eats" clicks so they don't fall through to widgets underneath. The dialog `Window` is also `Foreground` and drawn after, so it sits on top of the dimmer. Because `movable(false)` and `resizable(false)` are set, it behaves like a true modal.

> **Tip:** If you need several modals, give each dimmer a unique `Id` so they don't clash, and track a `current_modal: Option<ModalKind>` enum so only one is open at a time. Enums for state machines are the same idea as Rust Book [Chapter 6](https://doc.rust-lang.org/stable/book/ch06-01-defining-an-enum.html).

## File Dialogs

egui does not ship a file picker. The standard choice is the [`rfd`](https://crates.io/crates/rfd) crate (Rusty File Dialog), which opens native OS dialogs and works on the web with an async fallback.

Add it to your `Cargo.toml`:

```toml
[dependencies]
eframe = "0.35"
rfd = "0.15"
```

On desktop, `rfd` is synchronous and returns the result immediately:

```rust,no_run
fn open_file_dialog_sync() -> Option<std::path::PathBuf> {
    rfd::FileDialog::new()
        .add_filter("Graph", &["json"])
        .set_title("Open graph")
        .pick_file()
}
```

For background-friendliness (and web support), use the async API and spawn it the way we did in [Chapter 5](./ch05-architecture.md) — store the result in an `Arc<Mutex<...>>` and call `ctx.request_repaint()`:

```rust,no_run
use std::sync::{Arc, Mutex};
use eframe::egui;

impl MyApp {
    pub fn open_file_async(
        &self,
        ctx: egui::Context,
        pending: Arc<Mutex<Vec<BackgroundResult>>>,
    ) {
        // `rfd::AsyncFileDialog` works on both native and web.
        let task = rfd::AsyncFileDialog::new()
            .add_filter("Graph", &["json"])
            .set_title("Open graph")
            .pick_file();

        // On native this spawns a thread; on web it integrates with the
        // browser's async runtime. Either way, the future resolves later.
        std::thread::spawn(move || {
            // Block on the future. On web you'd use a wasm-friendly
            // executor instead; see rfd's web docs.
            let file = pollster::block_on(task);
            if let Some(file) = file {
                let path = file.path().to_path_buf();
                let bytes = std::fs::read(&path).unwrap_or_default();
                {
                    let mut buf = pending.lock().unwrap();
                    buf.push(BackgroundResult::FileLoaded {
                        name: path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default(),
                        bytes,
                    });
                }
                ctx.request_repaint();
            }
        });
    }
}
```

> **Note:** On the web, `rfd`'s async dialog must be driven by the browser's event loop and cannot be blocked on with `pollster`. The `Arc<Mutex<...>>` + `request_repaint()` handoff is the same; only the executor differs. Consult the `rfd` crate's web documentation for the exact integration with your async runtime.

> **Note:** `pollster` is not in our `Cargo.toml`. Add `pollster = "0.3"` if you want the async path. However, on native desktop, `rfd::FileDialog::pick_file()` is already synchronous and blocking — you do not need `pollster`, threads, or async at all. The async API is only needed for web (WASM) targets, where `std::thread` is unavailable.

Saving is symmetric — use `save_file()` / `AsyncFileDialog::save_file()`.

## Clipboard

Clipboard access is on the context:

```rust,no_run
ctx.copy_text("Hello, clipboard");
let pasted = ctx.input(|i| i.events.iter().find_map(|e| {
    if let egui::Event::Paste(s) = e { Some(s.clone()) } else { None }
}));
```

`ctx.copy_text` places text on the OS clipboard. Paste arrives as an `Event::Paste` in the input stream; Ctrl/Cmd-V is handled by egui automatically when a text widget has focus, so you usually only need to read paste events manually for custom widgets.

## Window and OS Controls

You can drive the OS window from inside egui using `ViewportCommand`, sent via `ctx.send_viewport_cmd`:

```rust,no_run
use eframe::egui;

impl eframe::App for MyApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx();
        ui.horizontal(|ui| {
            if ui.button("Fullscreen").clicked() {
                ctx.send_viewport_cmd(
                    egui::ViewportCommand::Fullscreen(true),
                );
            }
            if ui.button("Minimize").clicked() {
                ctx.send_viewport_cmd(egui::ViewportCommand::Minimize(true));
            }
            if ui.button("SetTitle").clicked() {
                ctx.send_viewport_cmd(
                    egui::ViewportCommand::Title("New Title".into()),
                );
            }
            if ui.button("Quit").clicked() {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
        });
    }
}
```

Other useful commands include `InnerSize`, `OuterSize`, `Position`, `Maximized`, `Visible`, and `StartDragging` (lets the user drag an undecorated window). These correspond to the underlying windowing system's capabilities.

## A Complete Example

Let's assemble everything: a menu bar (File → New / Open / Save / Quit), a settings floating window, and a confirmation modal that appears before quitting. This draws on the architecture from [Chapter 5](./ch05-architecture.md) and the theming from [Chapter 6](./ch06-theming.md).

```rust,no_run
// src/main.rs
use eframe::egui;
use std::sync::{Arc, Mutex};

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([900.0, 600.0])
            .with_title("Graph Editor"),
        ..Default::default()
    };
    eframe::run_native(
        "Graph Editor",
        options,
        Box::new(|ctx| Ok(Box::new(App::new(ctx)))),
    )
}

pub enum BackgroundResult {
    FileLoaded { name: String, bytes: Vec<u8> },
}

pub struct App {
    settings_open: bool,
    autosave: bool,
    status: String,
    quit_modal: ConfirmModal,
    pending: Arc<Mutex<Vec<BackgroundResult>>>,
}

impl App {
    fn new(ctx: &egui::Context) -> Self {
        crate::theme::EditorTheme::dark().apply(ctx);
        egui_extras::install_image_loaders(ctx);
        Self {
            settings_open: false,
            autosave: true,
            status: "Ready".into(),
            quit_modal: ConfirmModal {
                open: false,
                message: "Quit without saving?".into(),
                on_confirm: false,
            },
            pending: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn new_document(&mut self) {
        self.status = "New document".into();
    }

    fn open_document(&mut self, ctx: &egui::Context) {
        self.status = "Opening...".into();
        let pending = self.pending.clone();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let file = rfd::FileDialog::new()
                .add_filter("Graph", &["json"])
                .pick_file();
            if let Some(path) = file {
                let bytes = std::fs::read(&path).unwrap_or_default();
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                {
                    let mut buf = pending.lock().unwrap();
                    buf.push(BackgroundResult::FileLoaded { name, bytes });
                }
                ctx.request_repaint();
            }
        });
    }

    fn save(&mut self) {
        self.status = "Saved".into();
    }

    fn request_quit(&mut self) {
        self.quit_modal.open = true;
    }
}

impl eframe::App for App {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Keyboard shortcuts.
        ctx.input_mut(|i| {
            let new_sc =
                egui::KeyboardShortcut::new(egui::Modifiers::CTRL, egui::Key::N);
            let open_sc =
                egui::KeyboardShortcut::new(egui::Modifiers::CTRL, egui::Key::O);
            let save_sc =
                egui::KeyboardShortcut::new(egui::Modifiers::CTRL, egui::Key::S);
            let quit_sc = egui::KeyboardShortcut::new(
                egui::Modifiers::CTRL,
                egui::Key::Q,
            );
            if i.consume_shortcut(&new_sc) {
                self.new_document();
            }
            if i.consume_shortcut(&open_sc) {
                self.open_document(ctx);
            }
            if i.consume_shortcut(&save_sc) {
                self.save();
            }
            if i.consume_shortcut(&quit_sc) {
                self.request_quit();
            }
        });

        // Drain background results.
        let mut pending = self.pending.lock().unwrap();
        for result in pending.drain(..) {
            match result {
                BackgroundResult::FileLoaded { name, bytes: _ } => {
                    self.status = format!("Loaded {name}");
                }
            }
        }
        drop(pending);
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();

        // --- Menu bar ---
        egui::Panel::top("menu_bar").show(ui, |ui| {
            egui::MenuBar::new().ui(ui, |ui| {
                ui.menu_button("File", |ui| {
                    if ui.button("New").clicked() {
                        self.new_document();
                        ui.close();
                    }
                    if ui.button("Open...").clicked() {
                        self.open_document(&ctx);
                        ui.close();
                    }
                    if ui.button("Save").clicked() {
                        self.save();
                        ui.close();
                    }
                    ui.separator();
                    if ui.button("Quit").clicked() {
                        self.request_quit();
                        ui.close();
                    }
                });
                ui.menu_button("View", |ui| {
                    ui.checkbox(&mut self.settings_open, "Settings");
                });
            });
        });

        // --- Main content ---
        egui::CentralPanel::default().show(ui, |ui| {
            ui.heading("Graph Editor");
            ui.label(&self.status);
            ui.checkbox(&mut self.settings_open, "Show settings");

            // Context menu on a label, for variety.
            let resp = ui.label("Right-click here for options");
            resp.context_menu(|ui| {
                if ui.button("New document").clicked() {
                    self.new_document();
                    ui.close();
                }
                if ui.button("Toggle settings").clicked() {
                    self.settings_open = !self.settings_open;
                    ui.close();
                }
            });
        });

        // --- Settings floating window ---
        if self.settings_open {
            egui::Window::new("Settings")
                .open(&mut self.settings_open)
                .default_pos([120.0, 120.0])
                .resizable(true)
                .show(ui, |ui| {
                    ui.checkbox(&mut self.autosave, "Autosave");
                    ui.label("Theme:");
                    ui.horizontal(|ui| {
                        if ui.button("Dark").clicked() {
                            ui.ctx().set_theme(egui::ThemePreference::Dark);
                        }
                        if ui.button("Light").clicked() {
                            ui.ctx().set_theme(egui::ThemePreference::Light);
                        }
                    });
                });
        }

        // --- Quit confirmation modal ---
        if let Some(confirmed) = self.quit_modal.show(ui) {
            if confirmed {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
        }
    }
}

/// A simple confirmation modal built from Area + Window.
pub struct ConfirmModal {
    pub open: bool,
    pub message: String,
    pub on_confirm: bool,
}

impl ConfirmModal {
    pub fn show(&mut self, ui: &mut egui::Ui) -> Option<bool> {
        if !self.open {
            return None;
        }
        let mut result = None;
        let screen = ui.ctx().screen_rect();

        // Dimmer: full-screen, eats clicks.
        egui::Area::new(egui::Id::new("quit_modal_dimmer"))
            .order(egui::Order::Foreground)
            .fixed_pos(screen.min)
            .show(ui, |ui| {
                let _ = ui.allocate_rect(screen, egui::Sense::click());
                ui.painter().rect_filled(
                    screen,
                    egui::CornerRadius::ZERO,
                    egui::Color32::from_black_alpha(120),
                );
            });

        // Dialog window, centered and immovable.
        let size = egui::vec2(300.0, 120.0);
        let pos = screen.center() - size / 2.0;
        egui::Window::new("Confirm")
            .order(egui::Order::Foreground)
            .fixed_pos(pos)
            .resizable(false)
            .collapsible(false)
            .movable(false)
            .show(ui, |ui| {
                ui.set_min_width(size.x);
                ui.label(&self.message);
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    if ui.button("Cancel").clicked() {
                        result = Some(false);
                    }
                    if ui.button("Quit").clicked() {
                        result = Some(true);
                    }
                });
            });

        if let Some(c) = result {
            self.open = false;
            self.on_confirm = c;
            Some(c)
        } else {
            None
        }
    }
}
```

> **Tip:** Notice that `logic()` handles keyboard shortcuts and drains background results, while `ui()` only builds widgets and collects the *intent* to quit (setting `quit_modal.open = true`). The actual `ViewportCommand::Close` is sent only after the user confirms in the modal. This separation keeps your control flow readable and is the same collect-then-mutate discipline from [Chapter 5](./ch05-architecture.md).

The error-handling pattern in the file-open thread — `unwrap_or_default()` on `std::fs::read` — is a deliberately forgiving choice. For production code you'd propagate the error through your `BackgroundResult` enum using `Result`, as described in Rust Book [Chapter 9](https://doc.rust-lang.org/stable/book/ch09-02-recoverable-errors-with-result.html), and display it in the UI.

---

We now have an application that responds to the keyboard and mouse, offers menus and context menus, pops up floating settings windows, confirms destructive actions with a modal, and opens native file dialogs. In the next chapter we'll turn our attention to the canvas — drawing custom geometry, handling pan-and-zoom, and rendering the node graph itself.
