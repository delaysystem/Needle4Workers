# needle-router

Stateless depth router: one entry point in front of single-depth worker
deployments. No model, no weights, no engine — 72KB bundle, fits anywhere.

## Policy

`ROUTE_POLICY=single-20` (default): everything goes to `BACKEND_20L_URL`.
`ROUTE_POLICY=depth-split`: 1 user message → 4L, 2 → 16L, 3+ → 20L.

Default is single-20 **on measured evidence**: golden scores are 4L 7/252,
8L 8/252, 12L 29/252, 16L 127/252, 20L 238/252. No sub-20L rung earns
traffic today. Flip to `depth-split` only when a rung proves itself, or
for experiments. `X-Needle-Depth: 4|16|20` overrides per request.

Every path first tries the regex fastpath (`src/lib/fastpath.ts`):
unambiguous bare asks answer here with `X-Served-By-Depth: fastpath`
and no proxy hop.

Backend failure (non-2xx, throw, 90s timeout) falls back to 20L once,
flagged `X-Needle-Fell-Back: 1`; if 20L is down the router answers 502.

## Endpoints

`GET /health` (config dump), `GET /ready` (200 when the 20L backend
answers `/health`, else 503 with per-backend status), `GET /v1/metrics`
(same isolate counters plus per-tier `tiers`), `POST /v1/chat/completions`.
`AUTH_TOKEN` locks chat + metrics when set; `X-Served-By-Depth` labels
every chat response.

## Deploy

```sh
cd router
wrangler secret put AUTH_TOKEN   # optional but recommended
wrangler deploy
```

Backends are plain URLs (`BACKEND_4L_URL`, `BACKEND_16L_URL`,
`BACKEND_20L_URL` — 20L required); point them at edge workers, bun
servers, or anything OpenAI-compatible.

## Tests

`bun test test/router.test.ts` — fully hermetic, stubbed `fetch`, no
weights, no network. The depth policy table is the first thing it pins.
