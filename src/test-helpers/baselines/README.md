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

## Write contract (P2-6, 2026-09-10)

- **Read source（冻结基线）**: `src/test-helpers/baselines/*.json`（tracked，仅发布会话刷新）
- **Write target（测量落盘）**: `node_modules/.cache/qmai-baselines/*.json`（untracked，每次 bench 自动写入）
- **刷新冻结基线**: `QMAI_BASELINE_DIR=src/test-helpers/baselines npm run bench` 后走 review/commit（P16 单写者纪律）
- 目的：普通 bench 运行不再污染工作树（R11 清偿；原 skip-worktree workaround 已删）

## Regeneration

Baselines are NOT auto-regenerated into the repo anymore: regular runs write to
the untracked scratch dir (see Write contract above). Refresh the frozen
baselines only via the documented release-wave flow.

## Cross-Project Comparison

These baselines enable performance comparison with niko-studio:
- QMAI: Tauri IPC (binary channel)
- niko-studio: HTTP proxy (localhost REST API)

See `.workflow/outputs/licensing/ISS-006-PERFORMANCE-BASELINE.md` for detailed analysis.

---

**Generated**: 生成日期：2026-09-07（68 号 P2-12 版本字段统一 v2.7.8）  
**Total Metrics**: 21 operations across 6 baseline files  
**Status**: ✅ Complete