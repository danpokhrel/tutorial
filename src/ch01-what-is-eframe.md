# Chapter 1: What Is eframe?

This chapter introduces the two crates at the heart of this book—egui and eframe—and explains how they relate to each other and to the rest of the Rust GUI ecosystem. Before we write a single line of UI code, it is worth understanding the architecture you are about to build on, because the mental model of "immediate mode" will shape every decision you make in later chapters. If you have worked with retained-mode toolkits like Qt, GTK, or the web's DOM, some of these ideas will feel backwards at first—that is normal, and we will take it slowly.

## What Is egui?

**egui** is an immediate-mode GUI library written in pure Rust. "Immediate mode" means that, instead of constructing a tree of widget objects that live in memory and get mutated over time, you call functions every frame that *describe* what the user interface should look like right now. egui takes that description, figures out what changed, and paints the result. There is no widget tree, no signal/slot wiring, and no hidden stateful object per button.

egui itself knows nothing about windows, keyboards, mice, or rendering surfaces. It is a pure logic crate: you feed it input events, it hands you back a list of triangles to draw. That separation is deliberate—it lets egui run anywhere, from a desktop window to a web canvas to a game engine overlay.

> **A note on the name.** "egui" is pronounced "e-goo-ee." The "e" originally stood for *emerald*; these days most people just say "egui."

## What Is eframe?

**eframe** is the framework crate that wraps egui and makes it usable as a complete application. Where egui says "draw these triangles," eframe says "I will create the window, pump platform events, load fonts, talk to the clipboard, persist your state to disk, and hand egui a wgpu or glow surface to paint on." In other words, eframe is the "batteries-included" layer so that you can focus on your app rather than windowing boilerplate.

Concretely, eframe gives you:

- A **window** and event loop via `winit` (on desktop) or the browser canvas (on the web).
- A **renderer** backed by `wgpu` (the default) or `glow` (OpenGL).
- **Clipboard** integration for copy/paste.
- **Persistence**: save and restore your `App` state across runs using `epi::App::save`.
- **WASM** support so the same code runs in a browser.
- **AccessKit** integration for accessibility (screen readers, etc.).
- Sensible **defaults**: fonts, visuals, dark/light theme, DPI handling.

If you have used `wgpu` or `winit` directly, you know how much ceremony is involved just to get a blank window on screen. eframe exists so you do not have to write that ceremony.

## The Stack Architecture

Your application sits on top of a layered stack. Each layer has one job and delegates to the one below it:

```
        ┌──────────────────────────────────┐
        │           Your App               │  <- your logic & state
        │  (implements eframe::App)        │
        └──────────────┬───────────────────┘
                       │
        ┌──────────────▼───────────────────┐
        │            eframe                │  <- window, loop, persistence,
        │  (app framework)                 │     clipboard, AccessKit, WASM
        └──────────────┬───────────────────┘
                       │
        ┌──────────────▼───────────────────┐
        │  egui-winit   egui-wgpu  / glow   │  <- glue: events -> egui input,
        │                                 │     egui output -> rendering
        └──────┬─────────────┬─────────────┘
               │             │
        ┌──────▼─────┐ ┌────▼──────────────┐
        │   egui     │ │  wgpu / glow      │  <- GUI logic   /  GPU painting
        └──────┬─────┘ └───────────────────┘
               │
   ┌───────────┼───────────┐
   │           │           │
┌──▼──┐  ┌─────▼─────┐ ┌──▼─────┐
│emath│  │ epaint   │ │ecolor │   <- math / tessellation / colors
└─────┘  └──────────┘ └────────┘
```

- **Your App** implements the `eframe::App` trait. This is where your state lives and where you build your UI each frame.
- **eframe** owns the event loop and the window, creates the renderer, and calls into your app at the right moments.
- **egui-winit / egui-wgpu** are the "glue" crates: egui-winit translates `winit` events into egui's input format, and egui-wgpu paints egui's tessellated mesh onto a wgpu surface.
- **egui** is the pure-logic GUI crate: layouts, widgets, input state, clipping, etc.
- **emath / epaint / ecolor** are the small leaf crates egui depends on—math primitives, triangle tessellation, and color types respectively.

You will almost never touch the crates below egui directly. Knowing the stack exists, though, helps you read error messages and understand which crate owns which behavior.

## Immediate Mode vs. Retained Mode

The single most important concept in this book is the difference between immediate-mode and retained-mode UI. Let's make it concrete.

In a retained-mode toolkit (GTK, Qt, the DOM), you create a button object, add it to a layout object, connect a click handler, and the button lives in memory until you destroy it:

```rust,no_run
// (Pseudocode—not egui)
let mut button = Button::new("Click me");
button.on_click(|| { /* ... */ });
layout.add(&button);
// `button` persists; the toolkit owns it.
```

In egui, there is no button object that outlives the frame. Each frame, you call a function that says "draw a button here, and tell me if it was clicked this frame":

```rust,no_run
// egui
if ui.button("Click me").clicked() {
    // ran only on the frame the click happened
}
```

The implications are profound:

- **No widget state to sync.** There is no `Button` object whose `enabled` property you must keep in sync with your model. You just read your model and call the right function. For more on why avoiding shared mutable state is a theme of Rust in general, see [Chapter 4 of the Rust Book](https://doc.rust-lang.org/stable/book/ch04-00-understanding-ownership.html).
- **No callback wiring.** Event handling is a return value (`clicked()`), not a registered closure, so ownership stays simple.
- **State lives in your structs.** egui holds no business state. A text field's contents live in *your* `String` field, not in a widget object. The UI is a pure projection of your state.
- **Everything is rebuilt every frame.** This sounds expensive, but egui is fast: a typical frame rebuilds the whole UI in well under a millisecond. The trade-off is simplicity for the developer at the cost of some CPU per frame—but only on frames that actually run.

> **Tip: the mental shift.** If you find yourself wanting to "get a reference to a widget and change it later," stop. In egui you change your data; the widget reflects that next frame automatically.

## When to Use eframe vs. Raw egui

eframe is the right default, but egui is designed to be embeddable, so there are other hosts. Use this decision tree:

1. **Are you embedding UI inside a game engine (Bevy, Fyrox)?**
   Use `bevy_egui` (or the engine's egui integration). You already have a window and a render loop; eframe would fight it.
2. **Do you need a custom window manager, multiple separate viewports, or a non-winit platform?**
   Use raw `egui` + `egui-winit` + `egui-wgpu` directly. You are taking on eframe's job yourself, but you get full control.
3. **Are you writing a normal desktop or web app?**
   Use **eframe**. It is what this book covers, and it will handle 95% of real projects.

In short: eframe is "egui as an application," while the lower crates are "egui as a library."

## What egui Is Good (and Bad) At

egui shines for **developer-facing and power-user-facing tools**:

- **Developer tools**: debug viewers, profilers, log inspectors.
- **Dashboards**: telemetry, monitoring, data exploration.
- **Editors**: level editors, configuration tools, asset browsers.
- **Node graphs**: visual programming, shader graphs, material editors (this is exactly the domain of `egui-snarl`, which we use later in the book).

egui is weaker in a few areas—know them before committing:

- **Pixel-perfect mobile design.** egui is not layout-engine-precise the way a native mobile toolkit is. Touch hit-targeting and responsive breakpoints require manual work.
- **Rich text editing.** There is no rich-text contenteditable widget; the `TextEdit` is single-style plain text plus some formatting.
- **Deep native OS integration.** egui draws its own widgets, so they do not look native. If matching the OS chrome exactly is a hard requirement, consider a native toolkit instead.

For the node-graph editor we build across this book, egui is an excellent fit.

## The Per-Frame Flow

Every frame, eframe runs the same pipeline. Understanding this loop is the key to understanding why egui code looks the way it does:

```
platform events (input, resize, etc.)
        │
        ▼
┌───────────────────────────┐
│  App::logic (0.34+)       │  <- state updates, async, animations
│  ctx, frame               │     NO UI calls here
└────────────┬──────────────┘
             │
             ▼
┌───────────────────────────┐
│  App::ui (required)       │  <- build widgets from current state
│  ui, frame                │     keep this cheap & pure-ish
└────────────┬──────────────┘
             │
             ▼
┌───────────────────────────┐
│  egui tessellates         │  <- primitives -> triangle mesh
└────────────┬──────────────┘
             │
             ▼
┌───────────────────────────┐
│  wgpu / glow paints       │  <- GPU draws the mesh
└───────────────────────────┘
```

Two things stand out. First, the **logic/ui split** (introduced in egui 0.34, carried into 0.35): `App::logic` runs *before* `ui` and is meant for state mutation—reading input, advancing animations, polling async results—while `App::ui` only reads that state and builds the widget list. The old `App::update` method that did both is **removed in 0.35**; if you see old tutorials calling `update`, they are out of date.

Second, the repaint model.

## The Repaint Model: On-Demand, Not 60 FPS

egui does **not** render at a fixed 60 FPS by default. When nothing is happening, the application goes idle and uses essentially zero CPU. It only repaints when something requests a repaint:

- User input (a click, a keystroke, a mouse move over the window) requests a repaint automatically.
- Animations and timers inside egui request repaints as needed.
- **Your background work** must request a repaint explicitly, or the UI will appear frozen until the next input event.

If you spawn a background thread that produces data the UI should reflect, you must call `ctx.request_repaint()` when new data is ready. We will see exactly how to do that (clone the `Context`, which is cheaply cloneable, and call the method from any thread) in [Chapter 3](./ch03-first-window.md).

> **Warning: the silent freeze.** The single most common "my UI won't update" bug in egui is forgetting to request a repaint after a background update. If your app works when you wiggle the mouse but otherwise stalls, look here first.

## The Five Most Common Beginner Mistakes

To round out this chapter, here are the five mistakes new egui developers hit over and over. We will revisit each in detail later; for now, memorize the list:

1. **Forgetting image loaders.** egui cannot load images out of the box in 0.35; you must register an image loader (typically via `egui_extras`'s `image`/`svg` features) in `App::new`. Without it, `Image` widgets show nothing or panic.
2. **Holding the `Context` lock across UI code.** Context access is closure-based (`ctx.input(|i| …)`) precisely to avoid this. If you grab a lock and then build widgets, you will deadlock or borrow-checker yourself into a corner. Always scope context reads tightly.
3. **Not requesting repaints.** Covered above. Background-driven updates need `ctx.request_repaint()`.
4. **Missing the `wgpu` feature.** Rendering is off by default — you must enable the `wgpu` feature on `eframe` (or `glow`, for OpenGL) to get a renderer. The good news in 0.35 is that eframe's `wgpu` feature already turns on `egui-wgpu` with its *default* native backends (DX12 on Windows, Metal on macOS, Vulkan/GLES on Linux), so you do **not** need a separate `wgpu` dependency or target-specific backend features. Forgetting the `wgpu` feature entirely, though, gives you a blank window or a runtime panic. We set this up in [Chapter 2](./ch02-project-setup.md).
5. **Unstable `Id`s in loops.** egui tracks widget state (scroll position, focus, etc.) by `Id`. If you generate `Id`s with a loop index that changes when items are added/removed, state will jump around. Use stable identifiers (`Id::new(&item.key)` or `id.with(child_id)`). We cover this in [Chapter 4](./ch04-layout-widgets.md).

## Next Steps

You now have the mental model: egui is pure immediate-mode logic, eframe is the application shell, state lives in your structs, and the whole thing repaints on demand. In [Chapter 2: Project Setup & Structure](./ch02-project-setup.md) we will turn this into a real project—a `Cargo.toml`, the right feature flags, the wgpu backend gotcha, and a folder layout fit for a production app.
