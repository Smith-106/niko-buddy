# 20261101 大纲结构化真源（outline-model）P0

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

## 二、字段所有权（双轨）

| 字段 | 归属层 | 谁写 | 说明 |
|------|--------|------|------|
| `schemaVersion` / `updatedAt`（顶层） | 结构 | 写入方（`utils.todayStamp` 或调用方注入） | 迁移与新鲜度用；不参与 contentKey |
| `volumes[].number` / `.title` / `.arc` | 结构 | AI/编排层产出，人可读不手改 | 卷级弧线单独成节 |
| `chapters[].id` / `.volume` / `.chapter` | 结构 | 派生（`outlineChapterId`），禁止手写 | 校验强制一致 |
| `chapters[].title` | 结构 | AI 产出，人可改文字 | 不得为空 |
| `chapters[].arc` | 结构 | AI 产出 | 章所属弧线/小高潮名，可空 |
| `chapters[].entities` | 结构 | AI 产出（显式登场名单） | 替代 `outlineText.includes(name)` 猜测 |
| `chapters[].foreshadow.plant` / `.payoff` | 结构 | AI 产出，埋设/回收分列 | 供台账对账；按关键词「埋设/回收」解析并去重 |
| `chapters[].constraints` | 结构 | AI 产出 + 人工追加禁止项 | 如「苏七本章不出场」 |
| `chapters[].prose.goal` / `.scenes` / `.emotion` | 散文 | **人类作者** | 唯一允许人手改的部分；渲染回人读版可编辑 |

## 三、债条目（P1 待办）

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261101-01 | 消费者未接线：`context-engine` 仍读 outline 长文本字符串，未改为字段寻址的 `OutlineModel`；`OutlineModel` 尚无读写 sidecar JSON 的 IO 层（读/写/迁移） | 下一任务把 `context-engine-outline` 切到模型读取，或任一功能需要 sidecar 落盘 | P1 收口 |
| DEBT-20261101-02 | 尚无 schema 迁移器：`OUTLINE_MODEL_SCHEMA_VERSION = 1` 只做「不支持即拦」，未实现 v1→vN 迁移 | 首次需要改结构字段时 | 第二次 schema 变更前 |
| DEBT-20261101-03 | 解析器 heading 回退为启发式（中文章号 + 七类小节名），未覆盖自由格式大纲；confidence 只做三档粗分，无量化阈值 | 出现解析失败的实际大纲样本，或接入真实用户稿 | P1 收口 |
| DEBT-20261101-04 | 渲染产物未纳入 `gen:atlas` / 一致性脚本的校验范围（新文件使 atlas 模块数 1166→1169，需 regen 后提交） | 本次提交时执行 `npm run gen:atlas` + `npm run gen:check` | 本次提交 |
