# Introduction

Build a clean, modern **node graph editor** in Rust from scratch using `eframe` and `egui` — and
progress all the way to a working **node-based agentic AI flow builder**, the kind you see in
[Langflow](https://www.langflow.org/) and [Flowise](https://flowiseai.com/).

By the end of this tutorial you will have a production-grade desktop (and web-capable) application
that lets users visually compose AI agent pipelines — connecting LLM nodes, prompt templates,
tools, and memory components with drag-and-drop wires, then executing the resulting flow live with
streaming output.

## What You Will Build

By the end of this tutorial, you will have a fully functional node graph editor — the kind you see
in shader editors, compositing tools, and visual scripting systems — extended into a visual
builder for agentic AI workflows. It will feature:

#### Interactive Nodes

Draggable nodes with input/output pins, title bars, and embedded widgets for configuring prompts,
models, and parameters.

#### Live Connections

Drag-to-create wires between pins, with type validation and one-click deletion.

#### Modern Styling

A custom dark theme with styled pins, colored wires, a grid background, and per-node-type color
coding.

#### Agent Flow Execution

A graph evaluation engine that performs topological sorting and executes the flow — with
streaming output rendered live into the UI.

#### Persistence

Save and restore the entire graph layout and configuration to and from disk, plus eframe's
built-in state persistence.

#### Web-Ready

The same codebase compiles to native desktop *and* WebAssembly, so your flow builder can run in a
browser.

## Prerequisites

This tutorial assumes you have read through **Chapters 1–10** of [The Rust
Book](https://doc.rust-lang.org/stable/book/) — covering ownership, borrowing, structs, enums,
error handling, modules, and traits. You should be comfortable with:

- Creating a project with `cargo new`
- Writing `impl` blocks for your own types
- Using `Result` and the `?` operator
- Understanding the difference between `String` (owned) and `&str` (borrowed)

Throughout this tutorial, we link to specific chapters of [The Rust Programming
Language](https://doc.rust-lang.org/stable/book/). These references ground our architectural
decisions in the canonical Rust patterns the book teaches. A few callouts reach ahead to later
chapters — `move` closures (Ch. 13.1), the `Drop` trait / RAII (Ch. 15.3), and the newtype pattern
(Ch. 19.3) — each is briefly introduced where it first appears, so you don't need to have read
those chapters in advance.

## The Tools We Will Use

### egui

[`egui`](https://github.com/emilk/egui) is a pure-Rust **immediate-mode GUI library**. In immediate
mode, the UI is re-built every frame from scratch — there is no retained widget tree. This makes
it exceptionally fast to iterate on and ideal for developer tools, editors, and real-time
applications. It has no windowing, no event loop, and no rendering backend of its own — it only
*describes* UI and handles layout and input.

### eframe

[`eframe`](https://github.com/emilk/egui/tree/master/crates/eframe) is the **official framework**
for writing apps with egui. The name stands for both "egui frame" and "egui framework". It wraps
egui with everything needed to actually run: a window and event loop (`egui-winit`), a renderer
(`egui-wgpu` by default), clipboard, persistence, web/WASM integration, and accessibility
(AccessKit). Most apps only need to depend on `eframe` — it re-exports `egui`, `emath`, `epaint`,
and the rendering crates.

The rule of thumb: if you want a standalone desktop or web GUI app in Rust, start with `eframe`.
If you're embedding egui into a game engine (Bevy, macroquad) or a custom rendering surface, use
`egui` + a specific integration crate instead.

### egui-snarl

[`egui-snarl`](https://github.com/zakarumych/egui-snarl) is a customizable **node-graph widget**
for egui — think visual scripting, shader graphs, material editors. ("Snarl" = what a complex
graph looks like.) It is the most popular egui node-graph library. It provides a generic
`Snarl<T>` container that stores positioned nodes and wires, and a `SnarlViewer<T>` trait you
implement to drive the UI for each node type.

### serde

[`serde`](https://serde.rs/) provides serialization and deserialization. We use it to save and
load the entire graph — nodes, connections, and configuration — to JSON files. eframe's built-in
persistence also uses serde under the hood.

## The egui Stack

egui is a layered ecosystem. Understanding the layers helps you reason about what each crate is
responsible for:

```
┌─────────────────────────────────────────────┐
│              Your App (impl App)             │
├─────────────────────────────────────────────┤
│                   eframe                     │  ← framework: event loop, web/native glue, persistence
│  ┌───────────────┐   ┌────────────────────┐  │
│  │   egui-winit  │   │  egui-wgpu/glow   │  │  ← platform integration + rendering
│  └───────┬───────┘   └─────────┬──────────┘  │
│          ▼                     ▼             │
│  ┌────────────────────────────────────────┐  │
│  │                  egui                  │  │  ← immediate-mode UI library (widgets, layout, ctx)
│  │   ┌──────────┐  ┌────────┐  ┌────────┐ │  │
│  │   │  emath   │  │ epaint │  │ ecolor │ │  │  ← math, tessellation/paint, colors
│  │   └──────────┘  └────────┘  └────────┘ │  │
│  └────────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

- **egui** is the *library* — pure UI, layout, input; no windowing or rendering.
- **eframe** is the *framework* — it wraps egui with winit, a renderer, clipboard, persistence,
  WASM, and AccessKit.

eframe re-exports `egui`, `emath`, `epaint`, and `egui_wgpu`/`wgpu` (and `egui_glow`/`glow` if the
glow feature is on), so most apps only need to depend on `eframe`.

## Version Pinning

This tutorial is pinned to the following stable releases (July 2026):

| Crate | Version |
|---|---|
| `eframe` / `egui` | **0.35.0** (released 2026-06-25) |
| `egui-snarl` | **0.11.0** |
| `egui_extras` | **0.35.0** |
| MSRV | Rust **1.92.0** |
| Edition | **2024** |

> **Important:** egui ships breaking changes in most minor version bumps. If you are using a
> different version, some API signatures may differ. The [migration guide](./ch17-production.md)
> chapter covers the key changes across versions.

## Tutorial Roadmap

This tutorial is organized into five parts, each building on the previous:

**Part 1 — Foundations** (Chapters 1–4) introduces the egui ecosystem, sets up a project, opens
your first window, and covers the core building blocks: panels, layouts, widgets, and stateful UI.

**Part 2 — Application Architecture** (Chapters 5–7) elevates the project from a prototype to a
structured application: the `App` trait's `logic`/`ui` split, theming and fonts, and input
handling with menus and dialogs.

**Part 3 — The Node Graph Editor** (Chapters 8–12) brings in `egui-snarl` and builds a full node
graph editor: nodes, pins, wires, context menus, selection, and custom styling.

**Part 4 — Building an Agentic AI Flow** (Chapters 13–16) turns the node editor into an agentic
AI flow builder: defining agent node types (LLM, prompt, tool, memory), a graph evaluation
engine, live streaming execution, and persistence.

**Part 5 — Production** (Chapters 17–18) covers error types, testing, feature flags, logging, and
web/WASM deployment — everything you need to ship a production-grade application.

> **Scope of the reference implementation.** The companion `tutorial-implementation` crate realizes
> the **core node-graph editor** built across Parts 1–3 (Chapters 1–12): an `eframe` app with a
> custom dark theme, a four-node `DemoNode` graph (`Number` / `Text` / `Concat` / `Sink`), a
> `SnarlViewer` with bodies, footers, and add/remove context menus, plus the pure-data `graph/`
> module and its headless unit tests. It deliberately stops there: the type-validated `connect`
> (Ch. 10), the `SnarlStyle`/`header_frame` styling (Ch. 12), and all of Part 4 — agent nodes,
> graph evaluation, live streaming, and JSON persistence — are **forward-looking material the
> reference implementation does not (yet) ship**. Those chapters teach the patterns you would add
> next; they are accurate egui/egui-snarl pedagogy, but their code is not mirrored in the
> implementation. Each such chapter now opens with a short callout noting this.

## Conventions

Code blocks are the heart of this tutorial. We use `rust` fenced blocks for all Rust code:

```rust,no_run
fn main() {
    println!("Hello, egui!");
}
```

> **Note:** The `no_run` attribute tells mdBook's syntax highlighter to render the code without
> trying to compile it during tests.

Throughout, we use blockquote callouts for tips, warnings, and notes — just like this one.

Let's begin with [Chapter 1: What Is eframe?](./ch01-what-is-eframe.md).
