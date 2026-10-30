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
- 后续同步（同日）：`docs/consensus/coverage-mapping.md:28` 去掉 book-analysis-book-list 的「列表接线」说法并加注，L13–L17 的历史测试计数保留原样加注；`scripts/unguarded-map-recheck.json` 与 `button-a11y-recheck.json` 用各自 recheck 脚本重跑生成（未手改）。被删组件的条目全部落入 STALE（21 / 6 条）；其余计数变化来自 10-26 以来其他提交带来的行号漂移，button-a11y TRUE-POSITIVE 6→0。
- 删除可经 git 恢复。atlas 重新生成单独提交（P16）。

## 六、独立复核后的修正（同日）

复核者只读审查四个批次，无阻断项。处理如下：

| 项 | 处理 |
|------|------|
| A1 | rebase 到 v2.23.0 后 `changelog.ts` 行数变化，atlas 重新生成单独提交，gen:check 6/6。 |
| A2 | 审查中心与设置页文案去掉 Track A/B、thril、overall、packHash 等开发口径（只改值不改键）：A/B 徽章改「必过项 / 参考项」，「状态增量阻断主链」改「状态检查出错时拦下生成」，「残章战役模式」改「未达标章节结构优先改写」。提示词与代码注释里的内部说法不动。 |
| A3 | 新增 `inspectNovelProjectMeta`（missing / corrupt / ok）。创作中枢在 project-meta.json 存在但读不出时不显示「补全项目资料」，改提示手动修复；点补全时再查一次，文件已存在就不写。`loadNovelProjectMeta` 签名不变。 |
| B1 | 导航用语表决策行改为总量 30（16 / 14），与第四节一致。 |
| B2 | 修了一个真实缺陷：六维审稿把结果写在 `dimensionResults`，`results` 恒为空，原「审稿完成」提示在生产路径上从不出现。改由 `review-center-helpers.ts` 的 `summarizeReviewRunDone` 按逐维 issues 计数；0 条显示「审稿完成，没有发现需要处理的问题」；完成门 incomplete / suspect 时不显示。重试提示另起一行，不再拼全角括号（英文界面也就不出现全角括号）。 |
| B3 | 保留。批次一把 query / overview、dashboard 严重度、lint 分节、审查卡片的颜色字段改成 `*-foreground`，与提交说明「图标保留原色」不符。这些配置里图标和旁边文字共用一个 color 字段，拆开要加字段；更深的图标对 3:1 非文本对比度只有好处。提交说明不改写历史，以本条为准。 |
| B4 | 保留。`main-control-handoff.ts` 除纯函数 `buildChapterDraftGoal` 外还持有模块级交接状态，不是纯 helper；它也不属于 F1–F15 主视图文件，不受「纯函数进 *-helpers.ts」约束。改名只会增加 import 改动。 |
| B5 | 设置开关「检查器面板」改名「本章体检」（英文 Chapter check-up），与面板标题一致。 |

未覆盖：Playwright e2e 与浏览器内实测对比度没有跑。
