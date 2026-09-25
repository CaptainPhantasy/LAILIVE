# Legacy AI — Solutions

Source, artwork, fonts and catalog for [Legacy AI](https://legacyai.space).

The site includes Thesis, Intake, Solutions, Board and The Deal, with the approved layered paper design and distinct category photographs. The current 22-page catalog covers all 54 services. A separately illustrated field guide is being prepared and will be committed when its final checks finish.

## Publishing

The existing Vercel project `legacy-floydslabs/legacy_site` is connected to this repository. Its production branch is `main`; production deployments automatically receive the existing domains, including `legacyai.space`. Future edits belong on `preview`. Pushing that branch triggers a Vercel Preview deployment. Merge reviewed changes to `main` when they are ready for the live domain.

The preview deploy hook is managed in Vercel → Project Settings → Git. It rebuilds the latest committed `preview` branch. A deploy hook does not copy files or push commits to GitHub. Its secret URL must stay out of this repository. The Git integration already handles branch pushes, so a second GitHub Actions deploy call is unnecessary.

## Build and local preview

With Node.js installed:

```sh
npm ci
npm run build
npm test
npm run dev
```

The preview runs at `http://localhost:4187`. Public sources are in `dist/`. Vercel's build copies only public assets into `.vercel-static/`; `/api/board` is a native Vercel Function using the existing real AI Gateway backend. `vercel.json` selects the static framework and sets the Board function duration to 120 seconds.

The Board uses the existing project's `AI_GATEWAY_API_KEY` or Vercel OIDC. No credentials are stored here. Its prompt and provider contract were ported from the prior production website. See `docs/board-port.md` for provenance and limits. Tests verify routing/validation and the streaming contract without making paid model requests.

## Catalog

The current downloadable catalog is `dist/catalog.pdf`. The download links carry the PDF's content hash so updated editions are identifiable. The next field guide edition will include its portable editable source, six illustrations, fonts and exact image prompts. Earlier editions remain in Git history.

## Original Sites publication

`.openai/hosting.json` retains the ChatGPT Sites project association. `npm run build:sites` regenerates its Worker in `dist/server/`. That Worker proxies Board requests to the live domain; Vercel uses the direct API instead, preventing a self-proxy loop. The Sites source remote and this GitHub repository are separate publishing destinations.
