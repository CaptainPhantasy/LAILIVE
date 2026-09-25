# Legacy AI — Solutions

Source and published assets for [Legacy AI — Solutions](https://legacy-ai-solutions-dossier.captainphantasy.chatgpt.site).

The site includes Thesis, Intake, Solutions, Board, and The Deal. The current edition uses Cormorant Garamond and Source Serif, layered paper styling, distinct category photographs, and a 22-page catalog covering all 54 services.

## Run locally

With Node.js installed, run `node preview.mjs` and open `http://localhost:4187`. The five page sources and their styles, scripts, fonts, images, and catalog are in `dist/`.

## Build

Run `node build.mjs` to regenerate the Cloudflare Worker in `dist/server/`. Generated files are committed alongside their source assets. The Board requires this Worker because `/api/board` forwards requests to the existing Legacy AI service; the preview uses the same proxy.

The Sites project association is preserved in `.openai/hosting.json`. This checkout matches published Sites version 7, source commit `e9d61760f3128bcfc97b8b80054b587c9c9d59fb`, dated 25 September 2026.

## Catalog

The current downloadable catalog is `dist/catalog.pdf` (22 pages, 3.5 MB). The page links use a content version so visitors receive the latest edition.
