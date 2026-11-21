# Eval harness

Runs the frozen human-handoff golden suite against this worker in-process
(same pattern as `test-e2e.ts`: real WASM engine, weights from disk) and
gates publishes on score and regressions.

## Layout

- `goldens/` — frozen eval: `eval.jsonl` (336 cases, v3), `seeds_eval.jsonl`
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

Scores are engine-specific. On the v2 252-case goldens the same 20L
weights scored 238/252 through the Python engine and 237/252 through
this worker's WASM engine alone (measured 2026-11-13): 7 borderline
cases flip deterministically between engines, and both engines are
self-consistent run to run. With the regex fast path live the worker
scored 239/252 (it answered 49 unambiguous bare asks, two of which —
ev-00074 and ev-00149 — the model missed). On the v3 336-case goldens
the worker harness scores 336/336 (fastpath 336 — every golden now
resolves in the rules layers with zero engine calls, measured
2026-11-19; the bench therefore uses an adversarial fall-through query).
Always compare worker-report to worker-report; the `--compare` gate
enforces the shared golden, and reports record the engine for provenance.

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

## Depth ladder (measured 2026-11-18, v18 rank-128 weights)

Rungs sliced locally (`cactus build --layers N` over the merged 20L
LoRA), scored engine-only on the v2 252-case goldens, heap = WASM
linear memory after load+inference in bun. +Rules = deterministic
verdict-layer projection (131/131 eval precision; measured 251 on 20L):

| Rung | Exact | Routing | +Rules | Heap | Verdict |
|---|---|---|---|---|---|
| 4L | 20 | 186 | 140 | 35.4MB | smoke tests only |
| 8L | 30 | 198 | 144 | 62.9MB | routes at 79%, cannot ground reasons |
| 12L | 33 | 150 | 140 | 90.4MB | fits easily, weak everywhere |
| 16L | 124 | 144 | 192 | 117.9MB | fits 128MB isolates; the slim pick |
| 20L | 225 | 231 | 251 | 145.4MB | full quality; needs >128MB serving |

Routing (call/no-call) arrives by 8L but exact reason grounding needs
16L+ and only converges at 20L. The rules layer contributes most where
the engine is weakest (+107–120 below 12L, +68 at 16L, +26 at 20L),
which is why 16L+rules (192) is viable while 16L alone (124) is not.
Latency per rung was not remeasured for v18 (last: 4L n/a, 8L 1.17s,
12L 1.41s, 16L ~1.8s, 20L 2.0s on v17).

## Metrics vs eval

`GET /v1/metrics` and the `needle.request` log lines cover live traffic per
isolate. This harness covers release quality offline. Both feed the same
question — is this model safe to ship — from opposite sides.
