# 2026-10-30 UX 审计批次四：设置分区挂载与无调用方组件退役

## 一、决策

| 字段 | 值 |
|------|----|
| date | 2026-10-30 |
| task_id | UX 审计批次四（用户逐项确认） |
| decision_type | U-xx 定稿 |
| value | ① 设置页挂载三个已写好未挂载的分区；② BriefingPanel 不挂载；③ 工作台「下一步」保持静态推荐；④ 删除 module-consolidation 清单 T1–T8 共 8 个无生产调用方组件及其 spec。 |
| evidence_ref | `settings-nav-config.ts` / `settings-view.tsx` / `settings-sections-mount-coverage.spec.ts`；`.workflow/harvest-staging/module-consolidation-20261018.md` §C.1–C.2 |

## 二、设置分区挂载

| 分区 | 入口 | 保存方式 | 说明 |
|------|------|------|------|
| `multimodal-section.tsx` | 模型与工具 → 图片描述 | 草稿保存（模型域） | multimodalConfig 原本已被 initialDraft/handleSave 读写，只缺入口 |
| `web-search-section.tsx` | 模型与工具 → 网页搜索 | 即时保存 | 组件自己写 searchApiConfig；拆文、大纲聊天的内联入口保留 |
| `output-section.tsx` | 写作 → AI 回复语言 | 草稿保存（界面域） | outputLanguage 首次有入口。挂载时 `showHistory={false}`：历史消息数只在小说页编辑，避免同一配置两个入口 |

- 新增类目 id：`multimodal` / `web-search` / `output`（`SettingsCategoryId` 与 settings-view `CategoryId` 同步）。
- 三个文件已从挂载覆盖 spec 的 legacy 清单移除；b7 账本对应行已标注已挂载。
- source-watch / scheduled-import 维持有意隐藏，about-section 维持未挂载。

## 三、BriefingPanel 不挂载

挂载需要先写 `buildBriefingSourceBundleFromProject` 装配器，并涉及把摘要写回记忆，要单独核对 Draft-first。本批不做，b7 账本条目不变。

## 四、工作台「下一步」保持静态

`lib/novel/outline-next-step.ts` 解析 AI 回复里的 `<!-- next_step -->` 块，src 内没有调用方，不是章节进度数据源。工作台继续用 `nextStepRecommendations`（有书/无书两套）。

## 五、T1–T8 退役

| # | 删除 | 替代者 |
|---|------|------|
| T1 | `novel/dismantling-view.tsx` + 2 spec | `book-analysis-view.tsx`（拆文库） |
| T2 | `novel/outline-editor.tsx` + spec | `unpack-outline-dialog.tsx` |
| T3 | `novel/book-analysis-book-list.tsx` + spec | book-analysis 侧栏 |
| T4 | `layout/file-tree.tsx` + spec | `knowledge-tree.tsx` |
| T5 | `layout/chat-bar.tsx` + spec | 不做底部停靠栏；`chat-layout.ts` 仍在生产使用，保留 |
| T6–T8 | `story-simulation/framework-list.tsx`、`framework-binding-dialog.tsx`、`play-runtime-panel.tsx` + 各自 spec | 无（T7/T8 唯一调用方是 T6） |

- 原 `dismantling-view.spec.ts` 的导航与数据层断言迁到 `layout/dismantling-routing.spec.ts`，旧组件断言改为「文件已删除」。
- `collapsible-a11y-batch1.seq45.spec.tsx` 去掉 file-tree 用例（组件已删）。
- `docs/unreachable-branch-ledger.md` 的 file-tree 行标注已删除；`story-simulation-store.ts` 注释同步。
- `lib/novel/dismantling.ts` 数据层不动。
- 已知未同步：`docs/consensus/coverage-mapping.md:28` 仍写 book-analysis-book-list「首页/列表接线」，清单当时已判为文档漂移，治理文档本批不改；`scripts/*-recheck.json` 是审计快照，由各自 recheck 脚本重跑生成，不手改。
- 删除可经 git 恢复。atlas 重新生成单独提交（P16）。
