# Eval harness

Runs the frozen human-handoff golden suite against this worker in-process
(same pattern as `test-e2e.ts`: real WASM engine, weights from disk) and
gates publishes on score and regressions.

## Layout

- `goldens/` — frozen eval: `eval.jsonl` (252 cases), `seeds_eval.jsonl`
  (lang/category meta), `tools.json` (handoff schema), `manifest.json`
  (shas + provenance). Never edit in place; re-cut with provenance.
- `run.ts` — CLI runner. Writes a JSON report, exits nonzero on gate failure.
- `scoring.ts` — DroidCall exact-match scoring (port of cactus `evaluate.py`).
- `compare.ts` — baseline-vs-candidate diff; refuses cross-golden diffs.
- `failures.ts` — rule-based miss taxonomy (reason/span/presence buckets).

## Usage

```sh
bun eval/run.ts --min-hits 250 --out eval/report.json
bun eval/run.ts --min-hits 250 --compare eval/report.prev.json
bun eval/run.ts --limit 10 --min-hits 0   # wiring smoke test
```

Exit codes: 0 pass; 2 below `--min-hits`; 3 regressions vs baseline;
4 golden mismatch. The report always lands before a nonzero exit.

## Reports

Each report records model, weights sha, golden sha + version, summary
(overall, routing, per-language, per-category, negatives), the failure
breakdown, and per-case expected/actual with latency. Compare two reports
only when their golden shas match — `run.ts --compare` enforces this.

## Engine specificity

Scores are engine-specific. The same 20L weights score 238/252 through the
Python engine and 237/252 through this worker's WASM engine alone
(measured 2026-11-13): 7 borderline cases flip deterministically between
engines, and both engines are self-consistent run to run. With the regex
fast path live the worker scores 239/252 (it answers 49 unambiguous bare
asks, two of which — ev-00074 and ev-00149 — the model missed). Always compare
worker-report to worker-report; the `--compare` gate enforces the shared
golden, and reports record the engine for provenance.

## Operational numbers (measured 2026-11-13, in-process bun)

Single request (representative handoff query, 128 max tokens):

- p50 latency 2.0s, p95 2.4s; engine decode ~39 tok/s
- ~135 estimated tokens per execution (chars/4; exact counts in
  `usage_details`, estimates flagged `usage_estimated`)

Throughput (`eval/bench.json`, mutex-serialized engine, one isolate):

- ceiling ~0.48 req/s regardless of concurrency; extra concurrency only
  queues (c=4 p95 9.1s, c=8 p95 17.6s)
- scale by isolates: sustained R req/s needs ~R/0.48 warm isolates

Cost per execution (single-threaded WASM, so CPU ms ≈ wall ms):

- meters per request: 1 request + ~2050 CPU-ms + ~135 est tokens
- cost/req = R_req + R_cpu_ms × 2050, with R_* from the Cloudflare plan
  dashboard (deliberately no rates quoted here; they change)

Uptime: `/health` plus `started_at`/`uptime_s` in `/v1/metrics` are the
probing surface; true availability % needs an external prober hitting
`/health` (not shipped here — one cron line wherever you monitor).

Serving default: `max_tokens` defaults to 128. The old 48 truncated
43/252 golden tool calls (194/252 at 48 vs 237 at 128); a handoff call
with 200-char details plus JSON needs ~60 tokens.

## Depth ladder (measured 2026-11-14, v17 weights)

Rungs built on Kaggle CPU (`ladder_slice` over the merged 20L LoRA),
scored on the frozen 252 goldens, heap measured in bun:

| Rung | Exact | Routing | Heap | p50 | Verdict |
|---|---|---|---|---|---|
| 4L | 7 (model ~1) | 123 | 35MB | — | unusable; coin-flips |
| 8L | 8 | 200 | 63MB | 1.17s | routes at 80% but cannot ground args (186 spurious-reason) |
| 12L | 29 | 203 | 90MB | 1.41s | same: routes, cannot ground (165 spurious-reason) |
| 16L | 127 | 207 | 118MB | ~1.8s | half quality; marginal on 128MB isolates |
| 20L | 238 | 245 | 145MB | 2.0s | production depth |

Handoff knowledge concentrates brutally in the top layers: routing
(i.e. call/no-call) arrives by 8L, but exact argument grounding needs
16L+ and only converges at 20L. No rung below 20L earns production
traffic — not for full serving (16L is 111 hits short), not for triage
(80% routing misthrows 1 in 5), not for negatives. Depth-by-message-count
routing is therefore parked: the worker stays single-depth 20L plus the
regex fastpath. 4L/8L/12L keep one use: cheap load/shape smoke tests.

## Metrics vs eval

`GET /v1/metrics` and the `needle.request` log lines cover live traffic per
isolate. This harness covers release quality offline. Both feed the same
question — is this model safe to ship — from opposite sides.
