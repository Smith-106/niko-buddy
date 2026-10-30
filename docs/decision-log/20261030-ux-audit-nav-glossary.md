# 2026-10-30 UX 审计批次三：导航六组与界面用语表

## 一、决策

| 字段 | 值 |
|------|----|
| date | 2026-10-30 |
| task_id | UX 审计批次三·10 / 11 / 12 / 13 |
| decision_type | U-xx 定稿 |
| value | 侧栏导航由四组改为六组，顺序按作者工作流：开书 si → 写作 ma → 审改 review → 设定资料 shen → 创作工具 tools → 维护 maint。旧「设置」组（14 项）拆成「创作工具」与「维护」，组名改「维护」，不再与设置页「模型与写作设置」撞名。组 id 沿用 si/ma/shen/maint，新增 review/tools，用户存过的折叠偏好继续有效；有书时默认展开写作、审改。总量 31、primary/secondary 16/15 不变。 |
| evidence_ref | `src/components/layout/nav-items.ts` NAV_ITEMS / NAV_GROUP_ORDER / DEFAULT_COLLAPSED_GROUPS；`nav-items.spec.ts`「nav 六组」；`icon-sidebar.spec.tsx`「六组分组展示」 |

## 二、界面用语表（一个功能一个名字）

以侧栏导航名（`novel.nav.*`）为准。界面文案、空态、按钮、通知都用这里的名字；提示词、导出报告、changelog 历史条目不在此约束内。

| 功能（view id） | 界面名 | 不再使用 | 说明 |
|------|------|------|------|
| storySimulation | 故事模拟 | 故事推演、推演数据 | 工作台卡片与数据管理分类同步改名 |
| bookAnalysis | 拆文库（动作叫「拆文」） | 拆书分析、拆书作品 | 后台通知改为「拆文库：后台拆文中 / 拆文出错 / 拆文完成」 |
| lint | 记忆中心 | 一致性检查、Lint | 检查按钮文案「开始检查」保留 |
| mainControl | 主控 | — | 「生成本章草稿」经主控预填目标 |
| liveExecution | AI 实况 | — | 批次三·12 并入主控页签「AI 实况」，侧栏不再单列；旧深链路由保留 |
| maint 组 | 维护 | 设置（作组名时） | 「设置」只指设置页「模型与写作设置」 |
| outline thril 软门 | 开写前爽点结构检查 | thril 软门、Track B 结构预检、FIX-1 | 五个结构点：开头危机、压抑后释放、主角主动选择、章末钩子、不提前剧透 |
| inspector | 本章体检 | Inspector | — |
| wiki.gatingProgress | 本章检查进度 | 章节机械门控进度 | — |

## 三、未改范围

- `lib/novel/` 下提示词与报告标题（如「故事推演报告」导出文件、`aura-adapter` 诚实边界句）属于生成层文本，改名会影响已导出产物与提示词基线，保持不动。
- `lib/changelog.ts` 历史条目不回写。

## 四、批次三·12 工作台

- 工作台顶部加「下一步」：无书时推荐主控 / 拆文库 / 书架，有书时推荐写作 / 审查中心 / 跟进中心；纯函数 `nextStepRecommendations`（`workbench-helpers.ts`）。批次四若接 `outline-next-step.ts` 可替换为按大纲进度推荐。
- 「最近使用」：`app-layout` 在 activeView 变化时记录到 localStorage `niko-buddy-recent-views`（UI 偏好，不是运行时状态，不触 `.novel/status.json`），上限 6，工作台/设置/搜索/开发视图不记。
- 模块热力图、流水线动效两张开发视图卡收进折叠区「开发者视图」。
- AI 实况并入主控页签；侧栏 NAV_ITEMS 31 → 30（primary 16 / secondary 14）。

## 五、批次三·13 去开发口径

- i18n 只改值不改键：thril 软门系列、文学抛光去「Track B」、Inspector、章节门控进度（zh/en 同步）。
- 审查中心侧栏：去掉硬编码「Track B · soft」徽章；「: off」改「：已关闭」（`common.off`）；检查点的英文启发式判据收进「技术详情」折叠（`common.techDetails`）。
- `THRILL_CHECKPOINT_LABELS.fix1_no_conflict` 改为作者能读懂的问句。该标签也进提示词清单，只是措辞变化，判定逻辑不变；提示词里「确认 thril 软门」等内部句保持不动。
- KB 健康面板：N/A 的缺源原因（seed-missing 等）收进「暂无数据（技术详情）」；漂移告警改作者语言，`truth_fold_drift=N` 留在读屏文本。
- 设定校正（canon editor）去掉悬停显示项目 ID。
- 创作中枢：元数据缺失改为「项目元数据缺失（不影响写作）」，并加「补全项目资料」按钮。按钮只写 `.novel/project-meta.json`（`createDefaultNovelProjectMeta`，书名取文件夹名），不碰正文与正式记忆，符合 Draft-first；为此在 `@/lib/novel` barrel 补导出 `createDefaultNovelProjectMeta`。
- 诊断中心的错误码、技术详情本来就在「详情」展开里，未改。
