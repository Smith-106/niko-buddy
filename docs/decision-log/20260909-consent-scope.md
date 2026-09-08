# 2026-09-09 — 反 AI 遥测同意粒度显式裁决（应用级）

## 一、decision-log 条目

| 字段 | 值 |
|------|------|
| date | 2026-09-09 |
| task_id | Goal 2d37e563（数据隔离加固·三视角审计 m-qwen 缺口#4：consent 应用级需显式裁决而非默认沿用） |
| decision_type | U-裁决（隐私粒度） |
| value | **`antiAiTelemetryConsent` 同意键维持应用级（app-scoped），不降级为项目级。** 理由与边界：① 同意对象是「本机匿名诊断遥测」（进程级行为开关，非项目数据授权）；② 全部遥测**数据文件**（anti-ai-telemetry sink 落盘、kb-shadow 双臂 JSONL）按 `{projectPath}/.novel/telemetry/` 项目目录隔离——同意开关跨项目共享不产生数据跨项目泄漏；③ UI 文案已明示「应用级设置：仅控制本机匿名诊断遥测，与项目级小说设置相互独立」（novel-section consent 块）。替代方案（项目级同意）被否决的原因：按项目逐次弹同意会造成重复打扰且与「本机遥测」语义不符；若未来遥测包含项目敏感内容，再议粒度升级（届时走本文件 supersede）。 |
| evidence_ref | `QMAI/src/components/settings/sections/novel-section.tsx`（consent 块明示文案）；`QMAI/src/lib/novel/anti-ai-telemetry-wiring.ts`（loadAntiAiTelemetryConsent 应用级键）；kb-shadow 数据落盘 `{projectPath}/.novel/telemetry/kb-shadow`（kb-shadow-collector.ts KB_SHADOW_DIR_REL）；三视角隔离审计（2026-09-09，Goal 2d37e563）。 |

## 二、边界声明（防止误读）

1. **同意 ≠ 数据存储**：同意键应用级；数据文件项目级。删除某项目即删除其遥测数据（随项目目录）。
2. **导出/迁移**：项目导出携带其自身 `.novel/telemetry/`（本项目数据），不含他项目数据。
3. **R5 影子采集**：同一同意门（复用本键），采集行为仍按项目目录落盘；harness 独立根 `.novel/harness-project/` 与运行时目录分离。

## 三、后续触发条件（非债，为升级触发器）

若遥测内容未来包含项目可识别信息（项目名/章节内容摘要等），必须重新裁决粒度（项目级或逐项同意）并更新本文——触发条件：`kb-shadow-collector`/`anti-ai-telemetry-sink` schema 新增任何非匿名字段。