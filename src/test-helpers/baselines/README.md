# Performance Benchmark Baselines

This directory contains performance benchmark baseline data for QMAI.

## Generated Baselines

| File | Operations | Description |
|------|-----------|-------------|
| `ipc-latency.json` | 4 ops | Tauri IPC round-trip latency measurements |
| `lancedb.json` | 4 ops | LanceDB vector database operations |
| `search.json` | 5 ops | Search pipeline (tokenize, vector, RRF fusion) |
| `memory.json` | 3 ops | Memory state operations |
| `startup.json` | 3 ops | Application startup IPC latency |
| `llm-latency.json` | 2 ops | LLM API call latency (requires real API) |

## Usage

### Run all benchmarks:
```bash
npm run bench
```

### Run specific benchmark:
```bash
npx vitest run src/lib/ipc-latency.bench.ts
```

### Compare with baseline:
The benchmark framework automatically compares current results with saved baselines
and reports regressions (>20% threshold).

## Regeneration

Baselines are automatically regenerated when running benchmarks:
```bash
npx vitest run src/lib/*.bench.ts src/test-helpers/*.bench.ts
```

## Cross-Project Comparison

These baselines enable performance comparison with niko-studio:
- QMAI: Tauri IPC (binary channel)
- niko-studio: HTTP proxy (localhost REST API)

See `.workflow/outputs/licensing/ISS-006-PERFORMANCE-BASELINE.md` for detailed analysis.

---

**Generated**: 2026-08-01  
**Total Metrics**: 21 operations across 6 baseline files  
**Status**: ✅ Complete