# 20261101 大纲结构化真源（outline-model）P0/P1

> 范围：`src/lib/novel/outline-model.ts` + `outline-model-parse.ts` + `outline-model-render.ts` + `outline-model.spec.ts`（P0 纯函数层，未接消费者、未 commit 前的登记）。
> 授权：掌舵人 2026-11-01 定「sidecar JSON 为真源」。
> 门禁：`npx vitest run src/lib/novel/outline-model.spec.ts` 12/12；`npm run typecheck` 0 error；`npx eslint` 四文件 0 error。

## 一、决策条目

| date | task_id | decision_type | value | evidence_ref |
|------|---------|---------------|-------|--------------|
| 2026-11-01 | OL-P0-1 | 裁决人 | 大纲真源改为 **sidecar JSON 结构化模型**，Markdown 退为投影（人读版）。AI 侧不再读「整段长文本 + substring 猜测」，改为字段寻址；人侧只编辑 prose（本章目标/场景/情绪），结构字段由渲染器生成，不手改 | `src/lib/novel/outline-model.ts` 文件头注释 |
| 2026-11-01 | OL-P0-2 | 裁决人 | 命名定为 **outline-model**，不叫 canon。仓库内 `canon` 已被事实三表占用（`src-tauri/src/canon/*`：实体/边/章节快照 + 时态三层 + POV 认知轴），语义不同，混用会误导消费方 | `src-tauri/src/canon/types.rs`；`src/lib/novel/outline-model.ts` |
| 2026-11-01 | OL-P0-3 | 手设参数 | 章锚点 `id` 由卷号/章号派生 `v{02}c{03}`（如 `v02c012`），不手写；`outlineChapterId` / `parseOutlineChapterId` 严格互逆，`validateOutlineModel` 校验 id 与 volume/chapter 一致，避免改名漂移 | `src/lib/novel/outline-model.ts` `outlineChapterId` / `parseOutlineChapterId` |
| 2026-11-01 | OL-P0-4 | 手设参数 | 校验策略为**收集全部 issue 而非首错即返**（`{ ok, issues[] }`）。拦四类：schemaVersion 不支持、卷号/章号重复或非法、id 与卷章号不一致、章归属与所属卷不一致、标题为空。理由：大纲是长文档，一次报全才能一轮修完 | `src/lib/novel/outline-model.ts` `validateOutlineModel` |
| 2026-11-01 | OL-P0-5 | 手设参数 | 漂移检测用 `computeOutlineModelDigest`（复用 `checkpoint-digest` 的 `computeCheckpointDigestOf`）+ `outlineModelContentKey`（**忽略 `updatedAt`**）。两者分工：digest 进 frontmatter 供渲染/回读比对，contentKey 供单测判「往返等值」 | `src/lib/novel/outline-model.ts`；`checkpoint-digest.ts` `computeCheckpointDigestOf` |
| 2026-11-01 | OL-P0-6 | 手设参数 | 解析（md→model）采用**结构优先、正则回退**三级识别：① `frontmatter.outline_model` 整对象；② frontmatter 结构化字段（卷/章/entities/foreshadow_plant\|payoff/constraints，单章文件）；③ 正文 heading 回退（`第N卷\|卷N\|Volume N` + 中文数字；`第N章\|回\|Chapter N`；小节弧线/本章目标/场景/情绪/登场/伏笔/约束）。confidence/source 随结果返回，缺卷归第 1 卷并记 warning，无章标题返回空模型 + warning | `src/lib/novel/outline-model-parse.ts` `parseOutlineMarkdownToModel` |
| 2026-11-01 | OL-P0-7 | 手设参数 | 渲染（model→md）必须**确定性 + 幂等**：不写时间戳、不用随机；整本 frontmatter 带 `type/outline_type/schema_version/outline_model_digest/outline_updated_at`，正文按卷→章固定小节顺序（弧线/本章目标/场景/情绪/登场/伏笔/约束）。渲染器同步，digest 由调用方异步算好传入（避免渲染层引入异步 IO） | `src/lib/novel/outline-model-render.ts` `renderOutlineModelToMarkdown` |
| 2026-11-01 | OL-P0-8 | 手设参数 | 复用既有工具，不新写平行实现：`parseFrontmatter`（`src/lib/frontmatter.ts`）、`parseChineseInteger`（`chapter-import.ts`）、`computeCheckpointDigestOf`（`checkpoint-digest.ts`） | 三处 import |
| 2026-11-01 | OL-P1-1 | 手设参数 | `schemaVersion 1→2` + 章级 `pov`：`pov` = **计划期 POV**（写作前意图，人名，可空串）；实际 POV 仍走 `.novel/snapshots/*.snapshot.json` 的 `povCharacter`（`resolveChapterPovCharacter`），禁止当作「实际 POV」消费，也禁止新增第三套 POV 解析路径。`pov` 参与 `outlineModelContentKey`（否则改 POV 不触发 digest 漂移） | `src/lib/novel/outline-model.ts` `pov: string` JSDoc；`outline-model-render.ts` `SECTION_POV` |
| 2026-11-01 | OL-P1-2 | 裁决人 | D1 章定位键：`chapter` 语义 = **全局章号**（运行时 `chapter_number` 全局单增 = 解析器写入的 第N章 字面 N = spec 的 `v02c003` 全局编号）。G2 用 `flattenOutlineChapters` 后按 `chapter` 单值匹配，**恰 1 命中**才采信该章 `entities`；0 或 ≥2 命中一律回退旧文本路径（≥2 记 warning）。不改 `hints` 签名、不要求调用方传 volume、不用 `findOutlineChapter` | `src/lib/novel/outline-model.ts` `flattenOutlineChapters`；`context-engine.ts` `selectActiveEntities` |
| 2026-11-01 | OL-P1-3 | 手设参数 | D2 confidence 契约：`high/medium/low` 三档 + `confidenceScore`(0..1) + `signals` 明细（volumeHeadings/chapterHeadings/nonEmptyTitles/filledSections/warnings）。硬不变量「最高档 ⇒ warnings 为空且 filledSections > 0」——只凭「看到了卷/章标题」判 high 会让「标题全对、字段全丢」拿到假高置信 | `src/lib/novel/outline-model-parse.ts` `ParsedOutlineModel` / `gradeConfidence` |
| 2026-11-01 | OL-P1-4 | 手设参数 | D3 存储范式：自建注入式 deps（`readText/writeText/ensureDir` 可选 + `createFsDeps` 默认实现），迁移步形状照 `SchemaMigrationStep` 的 `from/to/forward`（P1 不提供 inverse，因无回滚入口），**不复用** `createAtomicJsonStore` 工厂（其 migrations 生产零调用、`arrayFieldCaps` 会静默截断大纲数组） | `src/lib/novel/outline-model-store.ts`；`projection-store.ts:56-63` |
| 2026-11-01 | OL-P1-5 | 裁决人 | D4 损坏 JSON 处置：load 返回 `{ model: null, migratedFrom: null, error }`（缺失无 error；损坏含「JSON 解析失败」；版本更高含「高于支持版本」；校验失败含 issues），**绝不降级为空模型再 save**，不做 `.corrupt` 备份。消费方以 `model === null` 作为回退旧文本路径的判据 | `src/lib/novel/outline-model-store.ts` `loadOutlineModel` |
| 2026-11-01 | OL-P1-6 | 手设参数 | D5 序列化：`JSON.stringify(model, null, 2)` 且**无尾随换行**（与 `projection-store.ts:133` / `facts-store.ts:100` 主流一致），spec 固化字节形态（`text === JSON.stringify(model, null, 2)` 且 `endsWith("\n") === false`） | `src/lib/novel/outline-model-store.ts` `saveOutlineModel`；`outline-model-store.spec.ts` |
| 2026-11-01 | OL-P1-7 | 裁决人 | BG-1 章号约定：运行时 `chapterNumber` 全局单增 = 解析器把 第N章 的字面 N 写入 `chapter` = P0 spec 的 `v02c003` 全局编号。三处代码证据一致，因此不新增「稳定全局章序号」字段（那会超出「只加 pov」并把 scope 升为 large） | `context-engine-outline-helpers.ts:26-30`；`outline-model-parse.ts` `numberFromLabel`；`outline-model.spec.ts` `buildModel` |

> **行号引用已全部改为符号引用**（P1 复核轮，2026-11-01，session `20261101-ralph-outline-p1` / review run `run-d9b13fa173f0`）：行号随实现漂移会让 grep 式复核空转（R-26）。引用代码位置请只写符号名（函数/常量），不写行号。

## 二、字段所有权（双轨）

| 字段 | 归属层 | 谁写 | 说明 |
|------|--------|------|------|
| `schemaVersion` / `updatedAt`（顶层） | 结构 | 写入方（`utils.todayStamp` 或调用方注入） | 迁移与新鲜度用；不参与 contentKey |
| `volumes[].number` / `.title` / `.arc` | 结构 | AI/编排层产出，人可读不手改 | 卷级弧线单独成节 |
| `chapters[].id` / `.volume` / `.chapter` | 结构 | 派生（`outlineChapterId`），禁止手写 | 校验强制一致 |
| `chapters[].title` | 结构 | AI 产出，人可改文字 | 不得为空 |
| `chapters[].pov` | 结构 | AI 产出（计划期 POV，人名，可空串） | 计划期意图；实际 POV 仍走 snapshots 的 `povCharacter`（BG-2），禁止当作实际 POV 消费 |
| `chapters[].arc` | 结构 | AI 产出 | 章所属弧线/小高潮名，可空 |
| `chapters[].entities` | 结构 | AI 产出（显式登场名单） | 替代 `outlineText.includes(name)` 猜测 |
| `chapters[].foreshadow.plant` / `.payoff` | 结构 | AI 产出，埋设/回收分列 | 供台账对账；按关键词「埋设/回收」解析并去重 |
| `chapters[].constraints` | 结构 | AI 产出 + 人工追加禁止项 | 如「苏七本章不出场」 |
| `chapters[].prose.goal` / `.scenes` / `.emotion` | 散文 | **人类作者** | 唯一允许人手改的部分；渲染回人读版可编辑 |

## 三、债条目（P1 待办）

| 债 ID | 描述 | 偿还触发 | 到期阶段 | 状态 |
|-------|------|----------|----------|------|
| DEBT-20261101-01 | 消费者接线：**读侧已接** —— `context-engine` 的 `selectActiveEntities` 已改字段寻址（sidecar `chapter.entities`，0/≥2 命中回退旧文本）；**写侧未接** —— `saveOutlineModel` 无生产调用方，`outline-model.json` 在生产环境不会产生 | 读侧：已偿还；写侧：见 DEBT-20261101-05 | P1 收口 / P2 写侧 | 部分偿还（读侧已接、写侧未接） |
| DEBT-20261101-02 | 尚无 schema 迁移器：`OUTLINE_MODEL_SCHEMA_VERSION = 1` 只做「不支持即拦」，未实现 v1→vN 迁移 | 首次需要改结构字段时 | 第二次 schema 变更前 | 已偿还（OL-P1-1 / TASK-001：`schemaVersion 1→2` + `OUTLINE_MODEL_MIGRATIONS`，迁移在校验之前） |
| DEBT-20261101-03 | 解析器 heading 回退为启发式（中文章号 + 七类小节名），未覆盖自由格式大纲；confidence 只有 `high`/`low` 两档粗分，无量化阈值 | 出现解析失败的实际大纲样本，或接入真实用户稿 | P1 收口 | 已偿还（OL-P1-3 / TASK-002：heading/粗体/列表/裸文本四类前缀 + 别名与黑名单 + 章号夹取；confidence 现为 high/medium/low 三档 + `confidenceScore`(0..1) + `signals`）。**证据形态已升级为变异验证过的断言清单**（R-07 两条子句 / R-11 两条子句 / R-02 / R-08 / R-09 / R-10 / R-12 / R-24 各自一条可命中输入），见 `outputs/plan.json` 的 `finding_map` 与各 task 的 `mutation_proof` |
| DEBT-20261101-05 | sidecar 生产者缺失：`saveOutlineModel` 全仓零生产调用（仅 barrel 与 spec），读侧字段寻址 100% 走旧文本回退；registry 已按「声明的合法孤岛」登记（orphan=true / consumer=internal） | P2 大纲生成/导入流程落地写入方（`saveOutlineModel` 出现生产调用点）时，registry 条目须同步改回 orphan=false / consumer=context-pack | P2 | 未偿还（DEBT-20261101-05） |
| DEBT-20261101-04 | 渲染产物未纳入 `gen:atlas` / 一致性脚本的校验范围（新文件使 atlas 模块数 1166→1169，需 regen 后提交） | 本次提交时执行 `npm run gen:atlas` + `npm run gen:check` | 本次提交 | 已偿还（TASK-004：`npm run gen:atlas` 后 `node scripts/check-generated.mjs` 6/6 PASS，modules 1169→1170） |

## 四、P1 收口记录

> 执行期：2026-11-01（session `20261101-ralph-outline-p1` / plan run `run-4c34ae68e4b3` / execute run `run-2338056b7142`）。
> 4 个 task 全部 `done`；下表为**实跑原始输出**（非推断）。

| task | 范围 | 验收命令 | 实跑结果 |
|------|------|----------|----------|
| TASK-001 (G1) | `schemaVersion 1→2` + 章级 `pov` 往返 + `.novel/outline-model.json` store（load/save/v1→v2 迁移） | `npm run typecheck` | exit 0，0 error |
| | | `npx vitest run outline-model.spec.ts outline-model-store.spec.ts` | 2 files passed；16 + 13 = 29 tests |
| | | `npx vitest run conditional-routing.spec.ts` | 8 tests passed（行为零改动） |
| TASK-002 (G3) | heading/粗体/列表/裸文本四类前缀 + 别名与黑名单 + 章号夹取 + confidence 三档量化 | `npx vitest run outline-model.spec.ts` | 22 tests passed（>= 21） |
| | | `npx vitest run` 4 基线 spec | 4 files passed；47 tests（基线 23 未减少） |
| TASK-003 (G2) | `selectActiveEntities` 源 A 改读 `chapter.entities`（单值匹配 + 0/≥2 回退）+ 两处 spec mock 形态加固 | `npx vitest run context-engine.spec.ts` | 220 tests passed（基线 213 + 新增 7） |
| | | `npx vitest run conditional-routing.spec.ts` | 9 tests passed（基线 8 + 新增 1，含 HARD-1 静态扫描 it） |
| TASK-004 | registry 登记 + barrel 导出 + atlas 重生成 + 本文件 | `npx vitest run projections-registry.spec.ts` | 6 tests passed（基线 5 + 新增 1） |
| | | `node scripts/check-generated.mjs` | RESULT: 6/6 passed（module-atlas 243224 bytes，modules 1169→1170） |
| | | `npm run lint` | exit 0（eslint . 干净 + check-boundaries 5/5） |

关键不变量复核（可 grep）：

- `OUTLINE_MODEL_SCHEMA_VERSION = 2`；`outline-model.ts` 仍零 IO（IO 全在 `outline-model-store.ts`）。
- 迁移在校验之前：`outline-model-store.ts` 中 `step.forward(record)` 行号 < `validateOutlineModel(model)` 行号。
- `saveOutlineModel` 写入 `JSON.stringify(model, null, 2)`，无尾随换行（spec 固化字节形态）。
- `selectActiveEntities` 仍在 `context-engine.ts`，函数体内无 `writeStatus`/`saveStatus`/`persistCheckpoint`，且不新增 `fileExists` 使用。
- rank 公式三处同构未改（`context-engine.ts` / `temporal-memory.ts` / `context-entity-budget.ts`），`ContextEntity.entityId` 形状未改。
- `chapter-import.ts` 未在改动清单内（`parseChineseInteger` 未触碰）。

### P1 复核轮结论（2026-11-01，review run `run-d9b13fa173f0`）

- **verdict = block 的原因**：1 条 critical（R-01：`{}` / 无关 JSON / 空 volumes 被降级为可用空模型，违反 locked D4）+ 12 条 major（R-02..R-13），修复前 `load` 会把损坏 JSON 变成「看起来正常」的模型。
- **修复范围**：29 条 finding → 必修 19（R-01..R-13 + R-19/R-20/R-21/R-23/R-24/R-26）、顺手 4（R-17/R-25/R-28/R-29）、deferred 6（R-14/R-15/R-16/R-18/R-22/R-27，另 3 条 parent deferred 顺延）。
- **confidence 硬不变量已变成可证伪断言**（R-11）：两条子句各自配一条「可命中输入」，删掉任一子句对应断言即转红；「vitest 全绿」不再作为有效性证据。
- **治理面如实化**（R-06）：写侧零生产者期间 registry 登记为 `orphan=true` / `consumer=internal`，并由双向可证伪断言守住（生产者数 0 ⇒ orphan 必须 true；出现生产调用点 ⇒ 必须 false）。
