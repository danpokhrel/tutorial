# Building a Node-Based AI Flow Editor with eframe & egui

A comprehensive tutorial covering the eframe/egui ecosystem — from your first window to a
production-grade node-based agentic AI flow builder (like Langflow or Flowise).

Built with [mdBook](https://rust-lang.github.io/mdBook/).

## Build Locally

```sh
# Install mdBook
cargo install mdbook

# Build the static site
mdbook build

# Serve with live reload
mdbook serve --open
```

The generated site is in `book/`.

## Deploy to GitHub Pages

This repo includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that automatically
builds and deploys the site on every push to `main`/`master`.

After pushing to GitHub:

1. Go to **Settings → Pages**
2. Under **Build and deployment → Source**, select **GitHub Actions**
3. The workflow will run and your site will be live at
   `https://<your-username>.github.io/<repo-name>/`

## Structure

```
├── book.toml              # mdBook configuration
├── src/
│   ├── SUMMARY.md         # Table of contents
│   ├── introduction.md    # Introduction
│   └── ch01–ch18*.md      # 18 tutorial chapters
├── theme/                 # Custom theme (coal dark mode, Inter font)
│   └── css/custom.css
└── .github/workflows/
    └── deploy.yml          # GitHub Pages CI/CD
```
