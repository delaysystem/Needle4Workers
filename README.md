# Needle4Workers

Production Cloudflare Worker serving a finetuned Cactus Needle 3 20L
model for human-handoff detection, with an OpenAI-compatible tool-calling
API, runtime guardrails, metrics, and a release-gating eval harness.

The model was trained in the companion repo
([Needle4Humans](https://github.com/delaysystem/Needle4Humans)): a 7-language
(EN/DE/FR/ES/IT/NL/PL) LoRA finetune that routes support conversations
to human agents. This repo serves the resulting 63MB archive.

Naming: the repo, folder, and npm package are `Needle4Workers`
(`needle4workers` on npm); the deployed worker keeps the historical
name `needle` (renaming it would provision a new worker).

## Results

- Worker eval: **237/252 exact** (routing 244) on the frozen golden suite
  (the same weights score 238/252 through the Python engine — 7 borderline
  cases flip deterministically between engines; see `eval/README.md`).
- Latency: p50 2.0s, p95 2.4s per request; engine decodes ~39 tok/s.
- Throughput: ~0.48 req/s per isolate (mutex-serialized); see `eval/bench.json`.
- Cost: ~2050 CPU-ms + ~135 estimated tokens per execution.

## Quickstart

Prerequisites: [bun](https://bun.sh) 1.4+, [wrangler](https://developers.cloudflare.com/workers/wrangler/) 4.x.

```sh
bun install
bun run cf-typegen        # generates worker-configuration.d.ts for tsc
cp .dev.vars.example .dev.vars   # local secrets (never commit the real one)
bun run dev               # serves on http://localhost:8787
```

Deploy: `bun run deploy` (needs `wrangler login` + `wrangler secret put AUTH_TOKEN`
for a locked-down instance; without it the worker runs the open demo posture).
No public deployment exists yet (checked 2026-11-14) — say the word and
I'll ship one, starting with `AUTH_TOKEN` set.

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Liveness + build info (always 200) |
| `/ready` | GET | Readiness: 200 when the engine is loaded and healthy, else 503 |
| `/v1/chat/completions` | POST | OpenAI-compatible tool calling |
| `/v1/metrics` | GET | Isolate counters, latency p50/p95, compute totals |

Demo trio (worker running locally):

```sh
# 1. Explicit handoff -> tool call
curl -s localhost:8787/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Get me a human being."}],
       "tools":[{"name":"request_human_handoff","description":"Hand off to a human.",
       "parameters":{"type":"object","properties":{
         "reason":{"type":"string","enum":["billing","technical","account","complaint"]},
         "details":{"type":"string","maxLength":200}},"required":[]}}]}' \
  | head -c 400; echo
# 2. Sarcastic frustration -> still routes
# 3. Off-topic question -> no tool call ([])
```

Full request validation applies: 400s for malformed bodies, 401 when
`AUTH_TOKEN` is set and the bearer is missing/wrong, 429 past the queue
cap (with `Retry-After`), 502 when model output fails the tool schema.
`X-Request-Id` replays identical responses without re-running inference.

## Architecture

```
client -> worker.fetch -> validate -> idempotency? -> 429? -> mutex
  -> engine.init(tools) -> engine.complete(query) -> reset (finally)
  -> validate output -> OpenAI response + metrics
```

- `src/index.ts` — routes, guardrail wiring, metrics recording.
- `src/lib/guardrails.ts` — request/output validation, idempotency cache,
  retry policy, engine-health counter (pure, unit-tested).
- `src/lib/metrics.ts` — isolate-local counters, latency quantiles,
  compute accounting, structured log lines.
- `src/lib/weights.ts` — chunked-asset weights load with sha verification
  and B2 fallback, module-level bytes cache.
- `src/wasm/` — vendored Needle inference engine + TS wrapper (see
  `src/wasm/SOURCE.md` for provenance).
- `eval/` — golden harness, regression gates, failure taxonomy, bench.

## Eval

```sh
bun eval/run.ts --min-hits 250 --out eval/report.json
bun eval/run.ts --min-hits 250 --compare eval/report.prev.json
bun eval/bench.ts --requests 32 --out eval/bench.json
```

Exit codes: 0 pass, 2 below threshold, 3 regressions, 4 golden mismatch.
Details in `eval/README.md`.

## Tests

- `bun test test/` — fast unit tests plus weights-backed route tests
  (needs `weights/` on disk, ~1 min of real inference).
- `bun test-e2e.ts` — full worker verification incl. chunk-sha and
  failure modes (needs weights + network for the B2 negative case).
- `bun run test` runs both. `tsc --noEmit` needs `cf-typegen` first.

## Configuration

| Variable | Kind | Purpose |
|---|---|---|
| `NEEDLE_LAYERS` | var | 20 for these weights |
| `WEIGHTS_CHUNKS` | var | Comma-separated chunk paths under `./weights` |
| `WEIGHTS_SHA` | var | sha256 of reassembled weights; load refuses on mismatch |
| `AUTH_TOKEN` | secret | Bearer for chat + metrics; unset = open |
| `ALLOWED_ORIGIN` | var | CORS origin; unset = `*` (demo posture) |
| `BACKBLAZE_*` | secrets | B2 fallback for weights (optional) |

## Weights

`weights/needle3-20l-handoff.cact.{aa,ab,ac}` are the production weights
(63MB in 25MiB static-asset chunks + `SHA256SUMS`). Re-cut with
`scripts/chunk-weights.sh <archive.cact> <basename>`. These derive from
the Cactus Needle 3 base model; redistribution rights for derived
weights are unconfirmed — the code LICENSE below does not automatically
cover the binaries.

## License

Business Source License 1.0, see [LICENSE](LICENSE). Converts to
Apache-2.0 on 2030-01-01.
