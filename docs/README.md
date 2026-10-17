# QMAI / Niko Buddy 文档目录索引

> 本文件是 `QMAI/docs/` 的结构索引。新增文档请登记到对应分区，避免目录继续散点式增长。
> 产品对外文档站（用户文档）在 `docs-site/`，本目录面向**工程与治理**。

## 1. 治理与决策（长期有效，需随变更更新）

| 路径 | 用途 |
|------|------|
| `arch-decisions.md` | **ADR 统一索引**（架构决策唯一真源；引用写 `ADR-nn`） |
| `decision-log/` | 逐次工程决策记录（按日期命名，ADR 的取证底稿） |
| `debt-triage-ledger.md` | 技术债分级台账 |
| `unreachable-branch-ledger.md` | 不可达分支登记（覆盖率豁免需在此登记） |
| `kb-flag-promotion-flow.md` | KB 开关晋升流程（ADR-47/48 判定式） |
| `consensus/` | 多模型共识与评审协议记录 |

## 2. 规格与设计（按主题）

| 路径 | 用途 |
|------|------|
| `novel/` | 小说主链（写作/门控/记忆）设计文档 |
| `s10-evaluation-replay-foundation.md` | 评测回放地基 |
| `s11-premium-mode-protocol.md` | Premium 模式协议 |
| `s12-literary-improvement-dimensions.md` | 文学改进维度 |
| `de-ai-integration-design-p3.md` | 去 AI 味集成设计（P3） |
| `plan-54-perspective-C-test-acceptance.md` | 54 号透视 C 验收计划 |

## 3. 阶段验收证据（按波次，只增不改）

| 路径 | 用途 |
|------|------|
| `p0/` | P0 基线、gov-seed、rerank 触发证据 |
| `p2/` | P2 阶段证据 |
| `p4/` | P4 阶段证据 |
| `p5/` | P5 真机冒烟与验收（含不可入库的大样本说明） |
| `p6/` | P6 A/B 证据（仅 hash manifest 入库，语料本体不入库） |
| `generated/` | 由脚本生成的报告（生成器脚本见 `scripts/`，勿手改） |
| `diagrams/` | 架构/流程图的源码与导出一览 |
| `archive/` | 已归档文档（保留只读，勿在此新增） |

## 4. 维护纪律

1. **新增文档必须落在既有分区**；需要新分区时先在本索引登记再建目录。
2. `generated/` 内容由脚本产出，禁止手工编辑；重生成命令写在对应脚本头部。
3. 语料本体、超大样本（如 PDF/PNG 导出样本）不入库，只在文档中给出重生成命令。
4. 文档中的版本号需与 `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` 一致（发版时同批更新）。
