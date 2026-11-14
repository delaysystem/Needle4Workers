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
Python engine and 237/252 through this worker's WASM engine (measured
2026-11-13): 7 borderline cases flip deterministically between engines,
and both engines are self-consistent run to run. Always compare
worker-report to worker-report; the `--compare` gate enforces the shared
golden, and reports record the engine for provenance.

## Metrics vs eval

`GET /v1/metrics` and the `needle.request` log lines cover live traffic per
isolate. This harness covers release quality offline. Both feed the same
question — is this model safe to ship — from opposite sides.
