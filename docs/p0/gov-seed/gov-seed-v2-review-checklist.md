# gov-seed v2 候选复核清单（-R2 批次，待人工复核）

> 2026-09-08 生成 · 三模型共识（session `20260907-p1-track`）：模板化半自动生成 + 逐例人工复核（R6 缓解），复核通过后合入 `gov-seed-v1.jsonl`。

## 现状与目标

- v1 主文件：36 例（OBL 16 / PSN 8 / VIO 12，P-1..P-6 各 2）→ `loadGovSeedSet` 恒 insufficient
- v2 候选：74 例（OBL 44 / PSN 22 / VIO 8，`-R2` 批号）→ 合并后 OBL 60 / PSN 30 / VIO 20，trap P-1..P-6 各 ≥3
- **GOV_SEED_MIN_SCALE 达标（60/30/20+trap≥2）**，但候选未复核，**不得直接合入**

## 复核要点（逐例）

| 类别 | 复核项 | 数量 |
|---|---|---|
| OBL（GOV-OBL-CFX-017..060-R2） | query 是否像真实写作指令（非机械拼接）；expectedObligationIds 与 query 语义对应（fixtures goldChunks 前 3 条） | 44 |
| PSN（GOV-PSN-CFX-009..030-R2） | poisonBlockCheck 的 crossbook_leak 排除语义是否成立（跨书泄漏检查） | 22 |
| VIO（GOV-VIO-CFX-013..020-P?-R2） | canonSnapshotRef 指向真实 fixture；povMask 与 query 的 POV 遮罩语义一致 | 8 |

## 合入流程

1. 逐例复核（预计 2-3 人日，分批 20-30 例）
2. 复核通过 → append 至 `gov-seed-v1.jsonl`（保留 -R2 批号）
3. `eval-gate.spec.ts` 复跑 → `loadGovSeedSet` status=ready（0 scaleViolations）
4. 影子双臂采集（运行期）继续积累，支撑后续 flag 翻转证据（不阻塞就绪）

## 已知限制（如实）

- OBL query 为模板拼接（「写第N章：<goldChunk 前 24 字>（项目名）」），复核时需改写为自然写作指令
- PSN 为模式扩展（crossbook_leak 变体），复核时需确认排除语义真实成立
- VIO 为 POV 遮罩模板，复核时需确认与 fixture 章节内容一致
- 影子双臂采集未跑（运行期前置，跨轮）
