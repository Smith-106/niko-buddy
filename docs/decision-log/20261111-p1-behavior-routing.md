# 2026-11-11 P1 行为重复 finding 归属修正（`character_behavior` → `behavioral_repetition`）

- **状态**：Proposed（源码已落、聚焦检查通过；**独立语义复核 pending**，尚未 review/publish/commit）
- **日期**：2026-11-11
- **范围**：审查 finding type → 门控键身份解析（仅 `src/lib/novel/review-prompt-assembly.ts` 一处逻辑改动 + `review-adapter.ts` 相关注释 + 两个 spec + `CLAUDE.md` 锚点登记 + 生成器产物）
- **锚定**：基线 HEAD `8cb7a5ab`（v2.27.1）；已发布的 v2.27.1 产物**不含**本修正
- **会话/运行**：`20261109-ralph-expert-residuals` / `run-fe6288c0ce65`

## 背景（确定性路由缺陷，非新策略）

机械层 `review-adapter.reviewChapter` 先用 `detectCharacterActions` 检「同章同一角色同一动作标签重复」，产 raw type `character_behavior` 的 warning；该机械信号在 T22 37 维注册表里的**规范 id 是 `behavioral_repetition`**（`audit-taxonomy.ts:437`，`gate: "anti_ai"` = P1，`detectionMethod: "mechanical"`，`defaultSeverity: "warning"`）。

但 `resolveReviewGateKey` 只认注册 id + 两组 CORR-108 legacy 常量，生产者别名 `character_behavior` 未登记 → 落 `quality`（P2）保守缺省。后果有两层：

1. **P1 看起来是干净的** —— 行为重复 finding 挂在 P2 名下，Anti-AI 门 findings 为空；
2. **P2 计数被污染** —— 该 finding 混进 Quality 门的题材级 warn→fail 计数（`deep-chapter-decision-gates.ts` `createGate` 的 `warningCount >= getUpgradeThreshold(genre, ...)`）。例如题材 `tuili`（阈值 `DEFAULT_UPGRADE_THRESHOLD = 3`）下「2 条真 Quality warning + 1 条行为 warning」会被误判成 P2 达标 fail。

## 决策

| 字段 | 值 |
|------|-----|
| date | 2026-11-11 |
| task_id | `p1-behavior-routing`（Run `run-fe6288c0ce65`） |
| decision_type | 统计口径 |
| value | `resolveReviewGateKey` 在既有解析序前加一步**身份归一**：normalize（trim + lowercase，口径不变）后查 `PRODUCER_TYPE_ALIASES`，`character_behavior → behavioral_repetition`，命中即用规范 id 走**原有** `getGateForDimension`（GATE_MAPPING 唯一真源）。不返回硬编码门、不新建 registry 抽象、不扩 legacy 常量集。别名表只登记本一条生产者别名。 |
| evidence_ref | `src/lib/novel/review-prompt-assembly.ts:75`（别名表）、`:83-90`（解析序注释）、`:96-104`（`resolveReviewGateKey`）；`src/lib/novel/audit-taxonomy.ts:437-451`（规范维定义）、`:700-717`（`GATE_MAPPING.anti_ai.dimensionIds` 含 `behavioral_repetition`） |
| date | 2026-11-11 |
| task_id | `p1-behavior-routing` |
| decision_type | 外部佐证引用 |
| value | 「行为重复」在本仓的机械检测器就是 `mechanical-slop-detector.detectCharacterActions`（角色-动作绑定、零 LLM、±80 字符归因窗口）。54⑨ 覆盖矩阵里「同章行为重复**暂无**检测器」的登记已失真，改为「已覆盖」，并补一条真实同章机械命中断言（fixture 复用 `mechanical-slop-detector.spec.ts` 已验证口径：同角色同动作 3 次）。口径保持原定义「已覆盖 = 至少一个确定性/机械层检测器命中」，**不**升级为语义完备 / 真实语料标定 / 文学 PASS。 |
| evidence_ref | `src/lib/novel/mechanical-slop-detector.ts:150`（`detectCharacterActions`）、`:200`（`characterActionsToText`，≥3 次走 ⚠️）；`src/lib/novel/avoid-ai-audit.spec.ts:29-51`（矩阵登记修正）、`:71`（同章机械命中断言） |
| date | 2026-11-11 |
| task_id | `p1-behavior-routing` |
| decision_type | 技术债条目 |
| value | 见下方债表 `DEBT-20261111-01` / `DEBT-20261111-02` |
| evidence_ref | 本文件 §二 |

### D1：为什么改身份解析，而不是改判定/阈值

门控三件套（`buildDecisionGates` / `resolveGateVerdict` / `resolveOverallVerdict`）、`: genre` 级 `getUpgradeThreshold`、修复严重度、Draft-first 全部**未动**。缺陷在「同一条 finding 被算到哪个门」，不在「算出来的门怎么判」。因此本修正只让 P1 的 finding 回到 P1：`anti_ai.verdict = warning`（不臆造 pass），`quality` 的 warn 计数不再被 P1 finding 填充，P0 error 存在时 `overall` 仍 `fail`。

### D2：为什么是「前置归一 + 注册表查门」而不是硬编码别名门

若在解析函数里直接 `if (type === "character_behavior") return "anti_ai"`，门归属就有了第二个真源，未来 `behavioral_repetition` 若改门（GATE_MAPPING）别名会静默漂移。现行写法把别名只当**身份**翻译，门只有一个出口 `getGateForDimension`；spec 独立钉住「别名非规范 / 目标已注册且归 anti_ai」，两侧任一漂移即红。

### D3：raw finding 与对外面不变

`character_behavior` 仍是产出的 raw `type`（`review-adapter.ts` producer 未改），finding 的 `severity` / `evidence` / `suggestion` / `message` 一字不改；`resolveReviewGateKey` 签名、CORR-108 两个历史常量数组、`review-prompt-assembly.ts` 的 export 面均不变（别名表**不导出**）。

## 二、债表

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261111-01 | 空 findings 无法区分「已评估且干净」与「不可用/未评估」；`chapter-gate-evaluation.spec.ts` 显式锁定合法 `[]` clean 路径。本修正**未**按数组长度置 pending/skipped，也未在编排层新增并行裁判。 | 门控引入显式「评估覆盖度」信号（而非从 findings 长度反推）且既有 `[]` clean 契约迁移完成 | G5 收口前显式评审 |
| DEBT-20261111-02 | 题材未传到 review prompt、以及 Anti-AI 的实质性语义覆盖，都会改动冻结评分/prompt 路径，本件未授权。已存储的 gate、第 4 章历史结果与冻结测量**不重算不重折叠**，本修正仅前向生效。 | 评分/prompt 冻结面获准变更的独立授权 | 下次评分面变更批次 |

## 验证（源码层，本 Run 实测）

- **负向控制（守卫缺失基线，先跑）**：`npx vitest run src/lib/novel/review-adapter.spec.ts src/lib/novel/avoid-ai-audit.spec.ts --reporter=verbose` → **exit 1，3 failed / 66 passed**。三条红全部是新增路由/分组/优先级用例，失败原因是 `expected 'quality' to be 'anti_ai'`（以及 `anti_ai.findings` 为空），不是 import/类型/环境错误，计数非 0。
- **修正后聚焦检查**：`npx vitest run src/lib/novel/review-adapter.spec.ts src/lib/novel/avoid-ai-audit.spec.ts src/lib/novel/chapter-gate-evaluation.spec.ts --reporter=verbose` → **exit 0，3 files / 79 passed（0 failed）**，选中用例数非 0。含既有 raw `character_behavior` producer 测试（未被替换）与 T24 canonical/大小写/legacy 对照、`chapter-gate-evaluation.spec.ts` 的编排/逐字段 parity 边界。
- **类型**：`npm run typecheck`（`tsc --build --force --pretty`）→ **exit 0**，无诊断输出。
- **生成器**：`npm run gen:atlas`（exit 0）后，独立 `node scripts/gen-module-atlas.mjs --out <Run work 临时路径>` 与仓内 atlas **逐字节相等**（248902 bytes，sha256 `5fc243f6ca21a60e1e280ef908b96e182ca10d6d355fb0b3e45bf93bb3d2ab66`，非空）。字段级差异仅 `review-adapter.ts l:968→971`、`review-prompt-assembly.ts l:269→296` 与 `stats.loc:290752→290782`，无手改。
- **受保护输入**：23 个受保护文件（`evidence/p1-routing-protected-inputs.json`）逐一 sha256 复核不变，含 `audit-taxonomy.ts`、`chapter-gate-evaluation.ts`、`mechanical-slop-detector.ts`、`package.json`/lock、`CHANGELOG.md`、`Cargo.*`、`tauri.conf.json`、10 个既有未跟踪 L9 脚本。
- **未执行（边界）**：未跑全仓 `vitest`/`test:mocks`、未跑 cargo / playwright / 真实 provider / 真实书稿门控；未重跑 `gen:check` 其余 5 项；未跑 `review-adapter.audit-triad.spec.ts` 等相邻 spec。

## 仍未验证 / 交付要求（不得当作已完成）

- **独立语义复核未完成**：本修正的语义判断归独立只读 Reviewer，当前 **pending**；本文件不是 approve 记录。
- 不据此声明语义级 Anti-AI 覆盖完备、真实语料标定、**P1 文学 PASS**、作者 accept 或整书验收；`chapter-gate-evaluation` 的「空 findings」判据仍区分不了「干净」与「未评估」（DEBT-20261111-01）。
- `humanizer-115-matrix.spec.ts` 的 `behavioral_repetition` 缺口行是 humanizer 规则池口径，与本 54⑨ 机械层矩阵不同源，本次**未复核未修改**。
- G5 保持 blocked；MCP 鉴权客户端、人工 gold 排序、provider 恢复/新门预算、H2/H5 整书授权仍阻塞。
- 版本 / CHANGELOG / 依赖 / lockfile 未改；提交、push、tag、发布均未执行。最新已发布包仍为 v2.27.1 且**不含**本源码修正。
