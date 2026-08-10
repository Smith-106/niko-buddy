# Vendored from reference/avoid-ai-writing/detector

- Source: hub `reference/avoid-ai-writing` (read-only upstream patterns)
- Ported: 2026-08-10 mid-loop full residual
- Files: `patterns.cjs`, `validate.cjs` (CommonJS; loaded via Vite `?raw` + sandbox)
- License: follow upstream package LICENSE
- Integration: `src/lib/novel/avoid-ai-patterns.ts` (Track B soft only; not product hard gate)
- Language bias: engine is English-heavy; Chinese path still uses mechanical-slop-detector

Do not edit patterns.cjs by hand for product rules — refresh from reference when upgrading.
