# Chapter 3: Your First Window

In this chapter we take the empty window from [Chapter 2](./ch02-project-setup.md) and turn it into a real application: one that holds state, responds to input, and persists across frames. Along the way we will get hands-on with the `App` trait, the `logic`/`ui` split introduced in egui 0.34, the `CreationContext` one-time setup hook, and the root `CentralPanel`. By the end you will have a complete hello-world app—a name field, an age slider, and a counter button—and the mental tools to extend it. We will also reference a few Rust concepts along the way, especially closures (Rust Book [Ch. 13](https://doc.rust-lang.org/stable/book/ch13-01-closures.html)) and traits (Rust Book [Ch. 10](https://doc.rust-lang.org/stable/book/ch10-02-traits.html)).

## Understanding the `App` Trait

Everything you write in eframe hangs off the `eframe::App` trait. In eframe 0.35, the trait has one **required** method and several **provided** ones you may override:

| Method | Kind | Purpose |
|---|---|---|
| `fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame)` | **required** | Build the UI for this frame. |
| `fn logic(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame)` | provided | Mutate state, poll async, run animations. Override when needed. |
| `fn save(&mut self, storage: &mut dyn Storage)` | provided | Persist state. Requires the `persistence` feature. |
| `fn on_exit(&mut self, _gl: Option<&mut glow::Context>)` | provided | Cleanup on shutdown. |
| `fn clear_color(&self, _visuals: &Visuals) -> [f32; 4]` | provided | Background clear color. |
| `fn raw_input_hook(...)` | provided | Inspect raw input before egui processes it. |

> **Warning: `update` is gone.** If you are following an older tutorial, you will see `fn update(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame)`. That method was **removed in 0.35** (it was split into `logic` + `ui` back in 0.34). Copying old code verbatim will not compile. Split the work as described below.

## The `logic` vs. `ui` Split (egui 0.34+)

egui 0.34 introduced, and 0.35 keeps, a clean separation of the per-frame work into two methods:

- **`logic`** runs **before** `ui`. It receives a `&egui::Context` and the `Frame`. This is where you:
  - Advance animations and timers.
  - Drain async channel results (network, file IO) into your state.
  - Read *aggregated* input via `ctx.input(|i| …)`.
  - Decide repaint scheduling.
  - **It must not** build any widgets. You have a `Context`, not a `Ui`.

- **`ui`** runs **after** `logic`. It receives a `&mut egui::Ui` and the `Frame`. This is where you:
  - Read your (already-updated) state.
  - Emit widgets: `ui.button`, `ui.label`, etc.
  - **Keep it cheap and mostly side-effect-free.** The UI is a projection of state; if a click mutates something, prefer to record the intent and apply it in the next frame's `logic`, or apply it directly but keep it trivial.

Why split them? Two reasons. First, it makes the data flow one-directional: `state -> ui`, never `ui -> state` in surprising ways. Second, it lets egui reason about whether a repaint is needed—if `logic` reports no change and no input arrived, the frame can be skipped entirely. (See the Rust Book's discussion of [ownership and data flow](https://doc.rust-lang.org/stable/book/ch04-00-understanding-ownership.html) for the general philosophy of keeping data movement explicit.)

## `NativeOptions` and `run_native`

You launch an eframe app by handing a configuration struct and a closure to `eframe::run_native`. The closure is called once, with a `CreationContext`, and must return your `App` boxed up. Closures here follow exactly the patterns described in Rust Book [Ch. 13](https://doc.rust-lang.org/stable/book/ch13-01-closures.html):

```rust,no_run
use eframe::egui;

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::new()
            .with_inner_size([800.0, 600.0])
            .with_min_inner_size([400.0, 300.0])
            .with_title("flow-builder"),
        ..Default::default()
    };

    eframe::run_native(
        "flow-builder",
        options,
        Box::new(|cc| Ok(Box::new(HelloApp::new(cc)))),
    )
}
```

`Box::new(|cc| …)` is an `AppCreator`—a boxed closure capturing nothing (it can't; eframe calls it from a context where only `cc` is available). It returns `Result<Box<dyn App>, Box<dyn std::error::Error + Send + Sync>>`, which is why our `HelloApp::new` returns a `Result`: setup steps like loading fonts can fail.

## The `CreationContext` and `App::new`

The `CreationContext` (`cc`) is the one-time setup hook. It is where you:

- Install **image loaders** (e.g. `egui_extras::image` / `svg`). Without this, `Image` widgets do nothing—see the "beginner mistakes" in [Chapter 1](./ch01-what-is-eframe.md).
- Configure **fonts** if you need a non-default font or extra glyphs (e.g. for icons or non-Latin scripts).
- Tune **`Visuals`** (dark/light, spacing, colors) via `cc.egui_ctx.set_visuals(...)`.
- Set up a **custom repainting** strategy.

A typical `new`:

```rust,no_run
use eframe::{egui, CreationContext};

pub struct HelloApp {
    name: String,
    age: u32,
    clicks: u32,
}

impl HelloApp {
    pub fn new(cc: &CreationContext<'_>) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        // Image loaders so Image/Svg widgets work later.
        egui_extras::install_image_loaders(&cc.egui_ctx);

        // Dark theme by default.
        cc.egui_ctx.set_visuals(egui::Visuals::dark());

        Ok(Self {
            name: "World".to_owned(),
            age: 25,
            clicks: 0,
        })
    }
}
```

Because `HelloApp::new` returns a `Result`, the `AppCreator` closure in `main` can propagate setup failures cleanly—a more idiomatic choice than `unwrap()`-ing in `new`. See the Rust Book on [the `Result` type and `?`](https://doc.rust-lang.org/stable/book/ch09-02-recoverable-errors-with-result.html).

## `CentralPanel`: The Root Container

The root `egui::Ui` handed to `App::ui` has **no margin and no background**. If you draw straight into it, your content sits jammed against the window edge and floats on the clear color. You almost always wrap everything in a panel.

`CentralPanel::default()` is the root container that fills the remaining space and gives you the default theme's background and padding:

```rust,no_run
impl eframe::App for HelloApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // Panels take &mut Ui since 0.34 — NOT &Context.
        egui::CentralPanel::default().show(ui.discard_then_recover(), |ui| {
            ui.heading("Hello, eframe!");
        });
    }
}
```

> **API note (0.34+).** Panel `show()` methods take a `&mut Ui`, not a `&Context`. In tutorials older than 0.34 you will see `CentralPanel::default().show(ctx, …)`. That no longer compiles. If you are inside `App::ui`, you already have the `Ui`; you can use it directly (or, for the root, use the appropriate panel sequence). When you genuinely need a fresh root UI from a `Context`—for example, in `App::logic` or in a deferred repaint—you can construct one, but the common path is to do all panel work inside `ui`.

## Basic Widgets

egui's `Ui` is a bag of builder methods. Each returns a `Response` you can inspect. Here are the ones you will use constantly:

```rust,no_run
ui.heading("A heading");
ui.label("A plain label.");

// Single-line text bound to a &mut String:
ui.text_edit_singleline(&mut self.name);

// A slider over a &mut numeric:
ui.add(egui::Slider::new(&mut self.age, 0..=120).text("age"));

// A checkbox:
let mut flag = true;
ui.checkbox(&mut flag, "enable");

// A button — returns Response, .clicked() is true for one frame:
if ui.button("Increment").clicked() {
    self.clicks += 1;
}

// Styled text:
ui.colored_label(egui::Color32::RED, "red text");
```

Two patterns to internalize:

1. **Mutate through references.** `text_edit_singleline` takes `&mut String`, `Slider::new` takes `&mut u32`. egui writes straight into your fields. There is no "get the widget's value" step—your struct *is* the value.
2. **`clicked()` is true for one frame.** It is not a persistent state. You read it in the frame the click occurred and act immediately.

For more on how methods on `self`/`&self`/`&mut self` map to call ergonomics, the Rust Book's [Ch. 5 on method syntax](https://doc.rust-lang.org/stable/book/ch05-03-method-syntax.html) is the relevant background.

## State Persists Because It Lives on Your Struct

This is the heart of immediate mode, restated for our concrete example. `self.name`, `self.age`, and `self.clicks` live on `HelloApp`, which lives across frames (eframe keeps your `App` around between calls to `ui`). Each frame, the widgets simply read and write those fields. Nothing needs to be "synced" anywhere—the next frame's widgets will naturally reflect whatever value the fields now hold.

Contrast this with retained mode, where you would have a `TextBox` widget holding its own `String` that you must push to and pull from. In egui that widget does not exist; only your data does.

## A Complete Working Example

Putting it all together, here is a full, compilable `main.rs`-style hello world: a name field, an age slider, and an increment button, all inside a `CentralPanel`:

```rust,no_run
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use eframe::{egui, CreationContext};

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::new()
            .with_inner_size([480.0, 320.0])
            .with_min_inner_size([320.0, 200.0])
            .with_title("flow-builder"),
        ..Default::default()
    };

    eframe::run_native(
        "flow-builder",
        options,
        Box::new(|cc| Ok(Box::new(HelloApp::new(cc)?))),
    )
}

pub struct HelloApp {
    name: String,
    age: u32,
    clicks: u32,
}

impl HelloApp {
    pub fn new(cc: &CreationContext<'_>) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        egui_extras::install_image_loaders(&cc.egui_ctx);
        Ok(Self {
            name: "World".to_owned(),
            age: 25,
            clicks: 0,
        })
    }
}

impl eframe::App for HelloApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ui.discard_then_recover(), |ui| {
            ui.heading("Hello, eframe!");
            ui.separator();

            ui.horizontal(|ui| {
                ui.label("Your name:");
                ui.text_edit_singleline(&mut self.name);
            });

            ui.add(egui::Slider::new(&mut self.age, 0..=120).text("age"));

            ui.horizontal(|ui| {
                if ui.button("Increment").clicked() {
                    self.clicks += 1;
                }
                ui.label(format!("clicked {} times", self.clicks));
            });

            ui.separator();
            ui.label(format!("Hello, {} (age {})!", self.name, self.age));
        });
    }
}
```

Run it with `cargo run --release`. Type a name, drag the slider, click the button—the values flow straight into your struct and the bottom line updates next frame.

> **Note on `discard_then_recover`.** When you are passed a `&mut Ui` in `App::ui` and want a fresh root to drive `CentralPanel::default().show(...)`, eframe provides a helper to obtain one. In simple cases you can also structure your code so that you drive panels from the context obtained via `frame`/`ctx`. We will standardize on the cleanest pattern in [Chapter 4](./ch04-layout-widgets.md) when we compose multiple panels.

## The `run_ui_native` Shortcut for Quick Prototypes

For throwaway prototypes or examples, you do not even need an `App` struct. eframe offers a closure-based entry point:

```rust,no_run
fn main() -> eframe::Result {
    let mut name = String::from("World");
    let mut clicks = 0u32;

    eframe::run_simple_native("prototype", Default::default(), |ctx, _frame| {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.text_edit_singleline(&mut name);
            if ui.button("click").clicked() {
                clicks += 1;
            }
            ui.label(format!("{} clicks", clicks));
        });
    })
}
```

This is great for examples and one-off tools. Note that the closure receives a `Context` (not a `Ui`), so here `CentralPanel::show` does take `ctx`—this is the non-`App` path and is unaffected by the 0.34 panel-signature change. For anything beyond a quick demo, graduate to the `App` struct so you can use `logic`/`ui`, persistence, and clean state ownership.

## Forcing Repaints from Another Thread

egui repaints on demand (see [Chapter 1](./ch01-what-is-eframe.md)). If a background thread produces data your UI should show, you must tell egui to repaint, or nothing will update until the user wiggles the mouse.

`egui::Context` is cheaply cloneable (it is `Arc`-backed internally), so the pattern is: clone it, move the clone into the thread, and call `request_repaint()` when there is new data:

```rust,no_run
use eframe::egui;
use std::thread;
use std::time::Duration;

fn spawn_background_work(ctx: egui::Context) {
    thread::spawn(move || {
        for i in 0.. {
            // ... do work, produce a new value ...
            thread::sleep(Duration::from_millis(500));

            // Tell egui: "please repaint, new data is available."
            ctx.request_repaint();

            // (You would also push the data into a channel your
            //  App::logic drains; request_repaint just ensures the
            //  next frame runs so logic/ui see the new value.)
            let _ = i;
        }
    });
}
```

> **Warning: do not hold the context lock across UI building.** Context access for *reading* state (input, output) is closure-scoped: `ctx.input(|i| { /* read */ })`. This scoped form exists precisely so you never hold a lock while building widgets, which would risk deadlocks and borrow conflicts. Always scope context reads tightly, as shown.

The `Arc`-backed `Context` and the `move` closure are exactly the patterns the Rust Book covers in [Ch. 16 on threads](https://doc.rust-lang.org/stable/book/ch16-00-concurrency.html) and [Ch. 13 on closures](https://doc.rust-lang.org/stable/book/ch13-01-closures.html).

## Next Steps

You can now build an `App`, set it up via `CreationContext`, lay out widgets in a `CentralPanel`, and drive repaints from background work. [Chapter 4: Layout, Widgets & State](./ch04-layout-widgets.md) moves from a single panel to a real multi-panel layout: side panels, top bars, scroll areas, grids, richer text, and—critically—how to build your own custom `egui::Widget` and keep widget `Id`s stable in loops.
