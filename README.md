# Building a Node Graph Editor in Rust with dear-app

A multi-chapter interactive web tutorial that teaches you to build a production-grade
node graph editor in Rust using the [dear-imgui-rs](https://crates.io/crates/dear-imgui-rs)
ecosystem (`dear-app`, `dear-imnodes`), aligned with *The Rust Programming Language* book.

## View the tutorial

This is a static site. Open `index.html` directly, or visit the published
GitHub Pages site (served from the root of this repository).

## Run locally

Any static file server works, for example:

```bash
# Python
python3 -m http.server 8000
# then open http://localhost:8000

# or Node
npx serve .
```

## Structure

```
index.html      # The full 13-chapter tutorial (single-page app)
css/style.css   # Styling
js/main.js      # Sidebar navigation, copy buttons, chapter routing
.nojekyll       # Tells GitHub Pages to serve files as-is (no Jekyll)
```

## Source review

See `CRITIQUE.md` for the technical and pedagogical review this tutorial
was improved against.
