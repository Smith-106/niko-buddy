# Vendored from reference/avoid-ai-writing/detector

- Source: hub `reference/avoid-ai-writing` (read-only upstream patterns)
- Ported: 2026-08-10 mid-loop full residual
- Files: `patterns.mjs` (ESM, product load path — P1-2 converted from `?raw`+eval sandbox to a direct import), `patterns.cjs` (**frozen vendor reference snapshot** — kept only as the byte-diff baseline for upstream refreshes; not loaded by the product), `validate.cjs` (CommonJS, zero product consumers)
- License: follow upstream package LICENSE
- Integration: `src/lib/novel/avoid-ai-patterns.ts` (Track B soft only; not product hard gate)
- Language bias: engine is English-heavy; Chinese path still uses mechanical-slop-detector

Do not edit patterns.mjs by hand for product rules — refresh from reference when
upgrading (refresh flow: regenerate .mjs from upstream, diff against the frozen
patterns.cjs snapshot, re-run the P1-2 equivalence check on seeds + corpus).
