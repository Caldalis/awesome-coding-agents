# Web Site

This directory contains the Astro + React site for **awesome coding agents**

The site is a static documentation wrapper around the Markdown chapters in the
repository root:

- English chapters: `../docs/`
- Chinese chapters: `../docs/zh/`
- Chapter metadata and route mapping: `src/content/chapters.ts`
- Shared layout: `src/layouts/BaseLayout.astro`
- Shared styling: `src/styles/global.css`
- Interactive React islands: `src/components/`

## Commands

Run all commands from this `web/` directory.

```sh
npm ci
npm run dev
npm run build
npm run preview
```

Command purpose:

| Command | Purpose |
|---------|---------|
| `npm ci` | Install locked dependencies |
| `npm run dev` | Start the local Astro dev server |
| `npm run build` | Build the static site into `dist/` |
| `npm run preview` | Serve the built site locally |
| `npm run astro -- --help` | Show Astro CLI help |

## Routing

The site exposes two language roots:

- `/`: English home page
- `/zh/`: Chinese home page

Chapter pages are generated from the metadata in `src/content/chapters.ts`.
Deep-dive pages are also mapped there.

The configured GitHub Pages `base` value in `astro.config.mjs` is applied to all
generated links through the helper functions in `src/utils/i18n.ts`.

## Content Flow

The page components do not duplicate chapter text. At build time, Astro reads the
Markdown files from `../docs/`, converts them to HTML, and renders them inside
the chapter layouts.

When adding or renaming a chapter:

1. Add or move the Markdown under `../docs/`.
2. Add the Chinese version under `../docs/zh/` when available.
3. Update `src/content/chapters.ts`.
4. Run `npm run build`.

## UI Notes

Use `src/styles/global.css` for shared visual tokens such as background colors,
accent colors, typography, Markdown rendering, and code block styling.

Use component-local styles only for layout or behavior that belongs to a single
component. Keep long-form reading styles stable so the documentation remains
comfortable to read.

## Deployment

The repository deploys through the GitHub Pages workflow in
`../.github/workflows/deploy.yml`.

The workflow runs:

```sh
npm ci
npm run build
```

and publishes `web/dist/`.
