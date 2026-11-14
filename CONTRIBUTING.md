# Contributing

## Setup

```sh
bun install
bun run cf-typegen
cp .dev.vars.example .dev.vars   # local secrets; never commit the real one
```

## Gates (must pass before any PR)

```sh
bun run test            # unit + weights-backed route tests + e2e
bunx --bun tsc --noEmit # pre-existing worker-configuration error aside, add none
```

Conventions:

- `src/lib/*` stays pure and unit-tested; the worker entry wires it.
- Weights and the WASM engine are vendored binaries: never hand-edit.
  Re-cut weights with `scripts/chunk-weights.sh` and update
  `WEIGHTS_SHA` in `wrangler.jsonc`.
- Goldens under `eval/goldens/` are frozen: never edit in place,
  re-cut with provenance and bump the manifest version.
- Deps float on `^` ranges; `bun.lock` is the pinned source of truth
  (do not reintroduce `package-lock.json`).

## License

Contributions are under the repo's Business Source License 1.0
(see LICENSE). Note it does not automatically cover the vendored
weights/WASM binaries (see README).
