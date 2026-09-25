# Real Board backend port for LAILIVE

Prepared 25 September 2026. Implemented separately in this folder; not deployed. No model request, credential-value inspection, domain change, or modification to the main site/GitHub checkout occurred.

## What this preserves

This is a port of the actual deployed `app/api/board/route.ts` from `LegacyAI-FloydsLabs/legacy-ai-website` at commit `73fa7f4516f1050c6189ea4cbdfc4fd4191547d3`, fetched using GitHub's read-only file tool. The fetched source is retained in `provenance/deployed-route.ts.txt`. The old repository's `AGENTS.md` returned 404 at that commit; the canonical server law and code-work skill were read.

The existing backend is one AI SDK generation whose system prompt describes five board members. It is not five independent model processes. The complete deployed system prompt is preserved byte-for-byte in its string value, along with:

- AI SDK `ai@7.0.38`; its source lock resolves Gateway `4.0.29`, provider `4.0.4`, provider-utils `5.0.13`, and Zod `4.2.1`. The new lock pins the original AI SDK and Zod versions.
- Primary model `anthropic/claude-sonnet-4.6` and Gateway fallback `openai/gpt-5.6-terra`.
- Maximum 8,000 output tokens; 90-second generation timeout; 120-second Vercel function duration in the configuration fragment.
- Plain UTF-8 streamed response expected by existing `dist/board.js`; no SSE or new client protocol.
- Provider billing/rate status mapping before the first chunk; midstream failures error the stream instead of reporting a completed truncated response.
- Cancellation aborts generation; empty output returns an error.
- Original four requests per IP per hour, held in a warm-instance memory Map, with `Retry-After`.

## Minimal integration

1. Copy `api/board.js` and `lib/board-handler.js` into the LAILIVE repository root's corresponding directories. Do not copy `node_modules` or provenance into the served static assets.
2. Merge this folder's package dependencies and `type: module` into the root package manifest, preserving the parent task's build script. Commit the resulting lockfile. If using this package/lock as the root starting point, add the existing static-site build command and the desired test script deliberately.
3. Merge `vercel.fragment.json` into the parent's Vercel configuration. The function must be discovered as `/api/board`, separate from `dist` static files. Use the plain/static framework setting, not the former Next.js setting; the parent owns exact build/output configuration.
4. Keep the existing browser request to `/api/board`; that path must invoke this native function. There is no `legacyai.space` fetch in this port, so the deployment serves its own backend with no proxy loop.
5. `board-proxy.mjs` exists only for the local preview server (`npm run dev`); deployments use the native function.
6. Configure function duration at 120 seconds and verify the selected project runtime allows it. The implementation uses Node's standard Request/Response/ReadableStream APIs and does not require Next.js or `@vercel/node`. Vercel supports a native `export default { fetch(request) {} }` in root `api/` files: [official Node runtime documentation](https://vercel.com/docs/functions/runtimes/node-js).

## Authentication and dependencies

The actual source checks two environment names only: `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`. Authentication remains implicit in the AI SDK: an explicit Gateway key is preferred; otherwise Vercel OIDC is used. The OIDC token must not be manually passed as an API key. The same project retaining its existing configuration is promising, but this task did not inspect environment values or prove the new deployment's identity/billing/model access.

No Anthropic/OpenAI direct API key, database, Redis, or other endpoint is referenced by the deployed Board source. Gateway billing, authorized model availability, and the original fallback's availability still need an actual authorized runtime request to verify end to end. No assertion that either provider succeeded is made here.

## Deliberate compatibility/protection changes

- Added the current LAILIVE proxy's method/Origin protections to the direct backend; cross-origin browser requests are rejected when Origin is supplied. Server requests without Origin remain permitted, preserving the Sites proxy path. This is not authentication or durable abuse prevention.
- Preserved LAILIVE's 8–500-character visible/input contract, which is stricter than the old standalone backend's 8–2000 limit.
- Applied a 4096-byte streaming body limit plus the Content-Length check, so chunked bodies cannot bypass the cap.
- Disabled SDK-level automatic retries (`maxRetries: 0`) while retaining the original explicit Gateway fallback. This intentionally limits accidental repeated paid calls; the model fallback still has its own Gateway behavior.
- Omitted raw provider error details from public errors; retained meaningful error category/status. No secret values were read or copied.
- Added no-store to ordinary JSON errors and `nosniff` to streamed output.

## Known limitations retained rather than hidden

- The IP limiter is per warm function instance, resets on cold start, and is not a durable project-wide spend limit. Parallel instances can each allow a bucket. This matches the actual deployed implementation, not the stronger “one session per visitor” client wording. The parent's deployment review should report this honestly; a durable limiter is a separate change.
- Client `localStorage` remains a presentation limit, not an enforceable quota. This port does not alter the browser code.
- After the first response bytes, HTTP status cannot be changed. The stream is deliberately aborted on provider failure; the existing browser catch path handles failure.
- Network-free tests do not verify Gateway credentials, credits, model availability, Vercel routing, production streaming, or real report quality.

## Verification receipts

- `npm install --ignore-scripts --no-audit --no-fund` installed the actual AI SDK without package scripts; no model invocation occurred. Zod was subsequently pinned to the source lock's `4.2.1`.
- `node --check lib/board-handler.js` returned exit 0.
- `npm test` passes ten contract tests covering method/Origin/body validation, missing auth, exact deployed prompt, model/fallback/options, real handler streaming contract, hourly rate limit/reset, billing/rate errors, empty output, midstream failure, cancellation, and OIDC selection. Test-only providers exist only in `test/board.test.js`; the production API imports the real SDK and has no canned output or simulation path.
- Importing `api/board.js` with the installed real AI SDK and sending a local GET Request returned HTTP 405 without invoking a provider.
- A formatting pass initially addressed a workspace-relative path from inside the port folder and returned `FileNotFoundError`; it made no changes. The corrected path succeeded and all ten tests passed again with the final pinned dependencies.
- Final formatting used Prettier 3.6.2 on `lib/board-handler.js` only. All ten tests passed again, including exact prompt comparison. Syntax checking passed. The installed-SDK entrypoint returned 405 for GET, 400 for malformed JSON, 400 for a short question, and 403 for a foreign Origin, without invoking generation.

After integration, verify a deployment's `/api/board` with a GET (expect 405), malformed JSON/short question (expect 400), and foreign Origin (expect 403); these paths must not invoke the model. A real successful generation requires a separately authorized paid request. Do not call invalid/error-only probes evidence of full Board delivery.

Successful external rejection checks establish that Vercel deployed the function, resolved its installed SDK imports, and executed its Request/Response validation path. They do not establish Gateway authentication, billing, model access, first-token latency, sustained streaming through the platform, or a complete real report. Report that narrower result as “function runtime and validation verified; real generation unverified.” Use a URL that actually reaches the deployment; an access-protection page alone does not verify the function.
