# WASM engine provenance

`needle.js` + `needle.wasm` are the vendored Needle inference engine
(Emscripten build exposing `_needle_load`, `_needle_init`,
`_needle_complete`, `_needle_reset`, consumed by `needle-engine.ts`).

Known facts:

- The bundle carries no version string, license header, or build metadata
  (inspected 2026-11-13; `strings` shows only Emscripten runtime code).
- It loads both the 16L base archive and the 20L LoRA-tuned
  `handoff_20l.cact` (proven by `test-e2e.ts` on each).
- Rebuild source lives outside this repo (Cactus-provided build).

Rules:

- Never hand-edit these files. A new engine version arrives as a new pair
  of files plus an updated note here (source, date, what changed).
- Redistribution rights for Cactus-derived artifacts (this engine and
  `weights/`) are unconfirmed; see the repo LICENSE and do not assume
  the code license covers the binaries.
