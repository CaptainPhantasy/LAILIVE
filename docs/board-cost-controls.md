# Board routing and measured cost

Updated 2026-10-17. This change prepares repeat sessions; it does not claim that a live session has been measured or that access is unlimited.

## Behavior

- Monday–Friday, 8am–5pm in `America/Indianapolis`: `deepseek/deepseek-v4.1-flash` through the existing Vercel AI Gateway connection, limited to the `deepseek` provider. No expensive model fallback in this window.
- Outside that window: existing Claude Sonnet 4.6 / GPT-5.6 Terra fallback route remains.
- Five advisor perspectives, competing recommendations, risks, assumptions and three next actions remain. One concise report replaces the long staged debate. Output limit: 3,000 tokens, including reasoning tokens if the provider produces any. Truncated reports fail visibly instead of counting as delivered.
- Identical instructions come first; the changing decision is the final user prompt. `caching: 'auto'` is enabled. DeepSeek uses implicit prefix caching; a cache hit is never assumed.
- Contact capture and consent remain required. Existing four-per-hour and 20-per-day sitewide pilot protections remain. These are not a $20 total-spend enforcement mechanism; the overall account budget still needs to be respected by the operator.
- `BOARD_REPEAT_SESSIONS=true` enables returning visitors and additional questions during business hours. It defaults off. Do not activate on the basis of the estimate below alone. The page says four sessions per hour, subject to availability; it does not advertise unlimited use.

## Evidence and pricing

Official sources checked October 17, 2026:

- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/): Flash off-peak $0.15/million uncached input, $0.003/million cached input and $0.60/million output. Peak prices double. Peak is 01:00–04:00 and 06:00–10:00 UTC on weekdays, excluding Chinese public holidays.
- [Gateway model/provider pricing](https://vercel.com/ai-gateway/models/deepseek-v4.1-flash): DeepSeek provider row lists the same base input/output rates and cache rate; other providers differ. Do not use the page's cheapest-provider headline as the selected provider's price.
- [Gateway REST reference](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api): public catalog and model-endpoint discovery allow verifying the selected provider and price without generating tokens. `GET /v1/models` confirmed this model supports implicit caching and reasoning off (`none`).
- [DeepSeek caching](https://api-docs.deepseek.com/guides/kv_cache/): repeated prefixes can hit the cache; persistence is best effort and may need more than one warm-up request.
- [Gateway caching](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options): automatic caching configuration.
- [Gateway cost metadata](https://vercel.com/academy/ai-gateway/ai-gateway-pricing) and [generation lookup](https://vercel.com/docs/ai-gateway/observability-and-spend/usage): actual generation cost can be read from `providerMetadata.gateway.cost` and looked up by generation ID.

Indiana's stated business window is 12:00–21:00 UTC in daylight time and 13:00–22:00 UTC in standard time. Both are outside the documented peak window. Weekend verification is also off-peak, but the production route deliberately uses the configured business-hours schedule.

Illustration only: 1,500 uncached input tokens plus the full 3,000 output cap would cost $0.002025 at those off-peak model rates, before non-model hosting/delivery costs. Actual token counts, provider billing and response quality require measurement; this is not a charge receipt or a guaranteed maximum for all providers/times.

## Activation verification

Use existing Gateway credentials (`AI_GATEWAY_API_KEY` locally or native Vercel OIDC when deployed); no new DeepSeek account is required. The handler accepts an injected clock for deterministic schedule testing. Do not change the deployed clock to force business hours.

For a real acceptance request outside business hours, the isolated preview branch `feat/live-service-demos` may set `BOARD_PREVIEW_DEEPSEEK=true`. This takes effect only with `VERCEL_ENV=preview` and that exact `VERCEL_GIT_COMMIT_REF`. It changes the model route only: real timestamps, business-hours status, repeat availability, contact consent and rate limits stay unchanged. Production and all other branches ignore it. Disable the branch-scoped switch when acceptance finishes; no credentials are read out or returned.

1. Run a real business decision with `BOARD_SYSTEM_PROMPT` and `boardGenerationOptions(boardPolicy({}, weekdayTimestamp))`. Inspect all five useful perspectives and a complete final action list.
2. Read the `board_usage` log: billed USD, input/output/cache-read/reasoning tokens, finish reason and Gateway generation ID. Missing billing is `null`, never zero. Logs contain no question text or customer contact details.
3. Use a different decision with the identical prompt prefix to inspect caching. If the second request has no cache hit, the official caching guide says common-prefix detection can require a third request; do not count a cache hit without the returned usage field.
4. Only after measured cost and report quality pass, set `BOARD_REPEAT_SESSIONS=true` for the approved deployment. Verify a returning visitor can ask again, while contact capture and the pilot limits still apply.

True unlimited access remains a separate launch decision: the preserved sitewide pilot allowance would need a deliberate revision alongside spending controls.
