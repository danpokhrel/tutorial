# Chapter 2: Project Setup & Structure

In this chapter we go from an empty directory to a compiling eframe project with a sensible, production-shaped structure. The goal is not yet a polished UI—that comes in [Chapter 3](./ch03-first-window.md)—but a solid foundation: the right dependencies, the right feature flags, the wgpu backend gotcha handled, and a folder layout that will not collapse under its own weight as the app grows. We will also lean on ideas from the Rust Book's chapter on packages and modules, so if you have not read it, now is a good time: [Chapter 7, "Packages, Crates, and Modules"](https://doc.rust-lang.org/stable/book/ch07-00-managing-growing-projects-with-packages-crates-and-modules.html).

## Creating the Project

Start with a fresh binary crate. We will call our example app `flow-builder` because, across the book, it grows into a node-graph editor built on `egui-snarl`:

```console
$ cargo new flow-builder --bin
$ cd flow-builder
```

This gives you the standard skeleton: a `Cargo.toml` and a `src/main.rs` that prints "Hello, world!". We will replace both.

> **Note: always use `--bin`.** eframe apps are executables (and can additionally target `wasm32-unknown-unknown` for the web), not libraries. If you skip `--bin`, cargo makes a library crate, which is the wrong starting point.

## The Full Cargo.toml

Replace `Cargo.toml` with the following. Each dependency and feature is deliberate; we explain the non-obvious choices immediately after.

```toml
[package]
name = "flow-builder"
version = "0.1.0"
edition = "2024"
rust-version = "1.92.0"

[dependencies]
# eframe is the app framework. We pin 0.35 and pick only the features we need.
eframe = { version = "0.35", default-features = false, features = [
    "default_fonts", # ships with a sensible default font set
    "wgpu",          # default renderer in 0.35
    "persistence",   # save/restore App state across runs
    "x11",           # Linux/X11 backend (winit)
    "wayland",       # Linux/Wayland backend (winit)
] }

# egui_extras: image decoders and svg support for `install_image_loaders`.
egui_extras = { version = "0.35", features = ["image", "svg"] }

# Node-graph widget for the editor we build later in the book.
egui-snarl = { version = "0.11", features = ["serde"] }

# Serialization for persistence and for snarl snapshots.
serde = { version = "1", features = ["derive"] }

[profile.release]
opt-level = 2        # egui needs reasonable optimization to feel responsive
lto = "thin"         # cross-crate inlining without full-LTO compile times
codegen-units = 1    # better optimization at the cost of slower release builds
strip = "symbols"    # smaller binaries; debug info lives in the build, not the artifact

[profile.dev.package."*"]
opt-level = 2   # build *dependencies* (egui, wgpu, ...) optimized even in dev
```

A few points worth calling out:

- **`default-features = false` on eframe.** eframe's defaults pull in everything, including the `glow` (OpenGL) renderer and platform backends you may not want. Being explicit avoids surprising link dependencies—especially on Linux, where an accidental X11/Wayland mismatch causes build pain.
- **Edition 2024, MSRV 1.92.0.** eframe 0.35 targets edition 2024 idioms (let-chains, `if let` chains, etc.). Setting `rust-version` makes the toolchain requirement explicit.
- **`egui-snarl` with `serde`.** We will serialize node graphs to disk, so the `serde` feature must be on.
- **`egui_extras` with only `image` and `svg`.** These two features are all `install_image_loaders` needs to display `Image`/`Svg` widgets. The older `http` and `file` features were dropped from this project: nothing in the app fetches images over the network or opens files through `egui_extras` (file dialogs, when we want them, come from the `rfd` crate in [Chapter 7](./ch07-input-menus.md) — and even that is optional, added only when you reach that chapter).
- **Profile settings.** egui's debug builds are sluggish because so much work happens every frame. The two `[profile]` blocks above make `cargo run` (without `--release`) usable by optimizing dependencies, while keeping *your* code compiled fast. The `[profile.dev.package."*"]` trick applies `opt-level = 2` only to *dependencies* (egui, wgpu, …), not to your own crate — the `"*"` wildcard targets every package *except* the one being built. Your code stays at `opt-level = 0` (fast to compile), while the heavy libraries run fast enough for interactive use. The `[profile.release]` block adds thin LTO, a single codegen unit, and symbol stripping for a smaller, better-optimized shipping binary. See the [Cargo profile reference](https://doc.rust-lang.org/cargo/reference/profiles.html) for details.
- **`x11` and `wayland`** are Linux-only winit backends. On macOS and Windows these features are silently ignored (they compile to no-ops), so listing them is harmless — a single `Cargo.toml` works across all three desktop platforms.

## The wgpu Backends (No Extra Dependency Needed)

A common older-tutorial pitfall is adding a *direct* `wgpu` dependency to `Cargo.toml` with target-specific backend features (`dx12`, `metal`, `webgl`). **You do not need to do this with eframe 0.35.** The `wgpu` feature on `eframe` enables `egui-wgpu` with its default features, which already turn on wgpu 29's native backends (DX12 on Windows, Metal on macOS, Vulkan/GLES on Linux). The window simply presents.

> **Warning: do not re-add a direct `wgpu` dependency.** This project previously pinned `wgpu = "23"` in a `[target.'cfg(not(target_arch = "wasm32"))'.dependencies]` block. Because `eframe` 0.35 pulls in a newer wgpu transitively, pinning an older major version here compiled an *entire second, unused wgpu tree* alongside the one eframe already uses — a slow, confusing build for no benefit. Leave wgpu out of `[dependencies]` unless `egui-wgpu`'s default feature set is ever insufficient for your needs.

If you *did* want to control the exact backends (rare), the place to do it is through `egui-wgpu`'s features, not a second `wgpu` crate dependency. For the web target, the WebGL/WebGPU paths are configured through eframe's wasm glue, not through native backend features.

## Build Prerequisites on Linux

On Linux, eframe (via winit) links against system libraries. You will need the development headers installed. On Debian/Ubuntu:

```console
$ sudo apt install -y \
    libxcb1-dev libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev \
    libxkbcommon-dev libxkbcommon-x11-dev \
    libwayland-dev libwayland-protocols
```

On Fedora the packages are named `xcb-util-devel`, `libxkbcommon-devel`, `wayland-devel`, etc. On Arch they are in the `base-devel` group plus `libxcb`, `xkbcommon`, `wayland`.

On Windows and macOS, the standard toolchains (MSVC and Xcode respectively) are sufficient—no extra system packages.

## Recommended Project Structure

A real app does not live in a single `main.rs`. Following the Rust Book's guidance on [separating modules by concern](https://doc.rust-lang.org/stable/book/ch07-03-paths-for-referring-to-an-item-in-the-module-tree.html), we split the codebase into three layers, each with a clear boundary:

```
flow-builder/
├── Cargo.toml
└── src/
    ├── main.rs              # entrypoint: build NativeOptions, run_native (stays thin)
    ├── theme.rs             # EditorTheme: Visuals, colors, style setup
    ├── graph/
    │   ├── mod.rs           # re-exports
    │   ├── model.rs         # NodeId, Pin, Node, Link — pure data
    │   └── state.rs         # GraphState — ID allocation, mutations
    └── ui/
        ├── mod.rs           # re-exports (pub use app::App;)
        ├── app.rs           # the App struct + eframe::App impl (state owner)
        └── viewer.rs        # DemoNode enum + DemoViewer (SnarlViewer impl)
```

The principle is **separation of concerns**, and the boundary is egui itself:

- **`graph/` is a *pure data model*.** It knows about nodes, pins, and links. It does **not** import `egui`. This means your graph logic is testable without rendering anything—exactly as the Rust Book advocates keeping I/O out of core logic ([Ch. 11 on testing](https://doc.rust-lang.org/stable/book/ch11-00-testing.html)). (In [Chapter 8](./ch08-egui-snarl.md) `egui-snarl`'s `Snarl<T>` takes over as the *runtime* graph container, so `graph/` becomes a pedagogical module kept only for its headless unit test — see the note in [Chapter 5](./ch05-architecture.md).)
- **`ui/` is the *rendering layer*.** It imports egui (and, later, `egui_snarl`) and turns graph data into pixels. It may read from and call methods on the graph, but it does not own the persistent state.
- **`ui/app.rs` is the *state owner*.** It holds the `Snarl`, the viewer, and the ephemeral UI flags, and wires everything together in `App::ui`. It is the only place that lives across frames.

This mirrors how a well-architected Rust program separates the model from the view. The payoff comes in later chapters: when we add undo/redo in the graph, or when we render the same graph to an export image, the `graph/` module is reusable unchanged.

## Module Structure (Following Rust Book Ch. 7)

If you have read the Rust Book's [Chapter 7](https://doc.rust-lang.org/stable/book/ch07-00-managing-growing-projects-with-packages-crates-and-modules.html), the file layout above should look familiar: each file is a module, `mod.rs` re-exports the children, and the crate root (`main.rs`) declares the top-level modules.

`src/main.rs` will start like this:

```rust,no_run
// src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod graph;
mod theme;
mod ui;

use crate::ui::App;
use eframe::egui;

fn main() -> eframe::Result {
    // (NativeOptions + run_native go here — see Chapter 3)
    Ok(())
}
```

The `windows_subsystem` attribute hides the console window on Windows in release builds. In debug builds we keep the console so `println!` output is visible—useful while developing. This is the standard Rust idiom for GUI apps; see the Rust Book's note on it in the context of [Ch. 1's "Hello, World"](https://doc.rust-lang.org/stable/book/ch01-02-hello-world.html) and the broader discussion of attributes.

> **Tip: keep `main` thin.** `main` should declare the modules, configure eframe, and call `run_native`; all real work lives in `ui/app.rs`, `theme.rs`, and `graph/`. This keeps the entrypoint readable and makes the app testable. (The reference implementation's `main.rs` is exactly this thin — under 30 lines.)

## A Minimal main.rs That Opens a Window

We will not build any widgets yet, but let's prove the setup compiles and shows a window. A truly minimal `main.rs`:

```rust,no_run
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use eframe::egui;

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([800.0, 600.0])
            .with_min_inner_size([400.0, 300.0]),
        ..Default::default()
    };

    eframe::run_native(
        "flow-builder",
        options,
        Box::new(|_cc| Ok(Box::new(MyApp::default()))),
    )
}

#[derive(Default)]
struct MyApp;

impl eframe::App for MyApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        ui.heading("It works!");
    }
}
```

> **Why `ViewportBuilder::default()` and not `::new()`?** In egui 0.35, `ViewportBuilder` has **no `new()` constructor** — it derives `Default` and exposes only `with_*` builder methods. Use `ViewportBuilder::default()` and chain `.with_inner_size(...)`, `.with_title(...)`, etc. If you see `ViewportBuilder::new()` in an older tutorial, it will not compile against 0.35.

> **Why `ui` and not `update`?** As of egui 0.34, the old `App::update(ctx, frame)` was split into `logic(ctx, frame)` and `ui(ui, frame)`. In 0.35, `update` is **removed**. You implement `ui` (required) and override `logic` (optional). We explore both in [Chapter 3](./ch03-first-window.md).

## Running the App

Build and run:

```console
$ cargo run --release
```

Use `--release`. egui in debug builds is noticeably sluggish because the per-frame work is unoptimized; with the `[profile.dev.package."*"]` tweak from earlier, plain `cargo run` is *tolerable* for iteration, but for an honest feel of the toolkit, `--release` is the way.

If the window is blank or the program panics about "no suitable adapter," double-check that your `eframe` dependency has the `wgpu` feature on — that is what brings in the native GPU backends (see the section above). You should not need any separate `wgpu` dependency.

## Next Steps

You now have a compiling, correctly-configured project that opens an 800×600 window and draws a heading. In [Chapter 3: Your First Window](./ch03-first-window.md) we will fill in the `App` trait properly: the `logic`/`ui` split, `CreationContext` setup, the root `CentralPanel`, basic widgets, and a complete hello-world app with a text field, a slider, and a button.
