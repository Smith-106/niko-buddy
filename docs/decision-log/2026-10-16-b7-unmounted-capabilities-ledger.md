# B7 已登记未挂载能力台账（Unmounted Capabilities Ledger）

Date: 2026-10-16. Project: QMAI. Scope: B7 审计收口 —— BriefingPanel 挂载决策 +
settings/sections 挂载覆盖门。本文件是这两处「未挂载/legacy」状态的登记真源。

> 本台账登记经审计确认「代码存在、测试存在、但应用壳层无用户可达入口」的能力。
> 登记不是放弃：每条给出**不可达证据（file:line）**、**当前不宜挂载的原因**、
> **恢复条件**与**登记位置**。
>
> 与另外两份台账互补：
> - 本地 `unreachable-branch-ledger.md`：覆盖率战役的不可达**分支**（函数内粒度）；
> - 本地 `debt-triage-ledger.md`：跨决定日志的 DEBT 分拣（债务粒度）；
> - 本台账：**组件/能力级**的「未挂载」登记（应用壳层可达性粒度）。
>
> 纪律：未挂载能力的恢复必须遵守 Draft-first 安全边界（AI 输出先进 pending/ready
> 草稿，人工 accept 后才回填正式层），本条登记不得成为绕过门控的入口。
> 条目状态变化时修订本文件并保留修订日期。

---

## 1. F-003 续写简报面板 BriefingPanel（B7 审计条目，裁决：登记，不挂载）

- **能力源码**：`src/components/briefing/BriefingPanel.tsx`
  （只读呈现 + 逐条溯源 + opt-in 记忆补丁；组件级登记注释见该文件顶部）。
- **支撑实现**：
  - `src/lib/novel/briefing/digest-aggregator.ts`（确定性聚合，15 用例：
    `src/lib/novel/briefing/__tests__/digest-aggregator.spec.ts`）；
  - `src/lib/novel/briefing/briefing-renderer.ts`（canon 裁决 / divergence 块 /
    记忆补丁纯构造）。
- **现状（不可达证据）**：全应用无生产 import/挂载；仅
  `src/components/briefing/BriefingPanel.spec.tsx`（冒烟）与 `e2e/briefing.spec.ts`
  注释引用。canon divergence 展示与写回能力因此不可达。
- **不宜直接挂载的原因（裁决依据）**：
  1. **输入契约未对齐生产 store（挂载会展示失真简报）**：
     - `formatEmotionEntry`（digest-aggregator.ts:111）按 `chapter/emotion/intensity`
       候选字段读取；生产 emotion-ledger 条目形状是
       `{characterName, netValue, valence, arousal, dominance, lastUpdatedChapter, history}`
       （character-state.ts:57-65）——真实条目只会命中 `netValue`，渲染为
       「情绪曲线 强度=<netValue>」，丢失角色名与情绪语义。
     - `currentChapterOf`（digest-aggregator.ts:129）只认 `currentChapter/current_chapter/chapter`
       根字段；生产 `.novel/status.json`（NovelSessionStatus，novel-session-status.ts:82）
       没有该字段且无 status 投影生产者——progress 块与「已过 N 章」将恒缺失。
  2. **无 Draft-first 写回承接点**：`MemoryPatchDraft` 只有纯构造
     （briefing-renderer.ts:137/147），仓库没有 pending/ready 补丁草稿队列；
     `memoryPatchPath`（briefing-renderer.ts:63）只是路径约定。挂载写回要么绕过草稿
     （违反 Draft-first 红线），要么先建新基础设施（超出最小外科手术范围）。
  3. **只读挂载也不诚实**：上述字段错配下，面板无法兑现「每条断言带 source、
     确定性呈现」的承诺；宁可不挂载，也不在写作主界面展示疑似失真的简报。
- **恢复条件（按序）**：
  1. 在 `src/lib/novel/briefing/` 增加生产装配器（如
     `buildBriefingSourceBundleFromProject(projectPath)`），把真实 store 映射为
     `BriefingSourceBundle`（emotion 条目补角色名/情绪语义、status 投影给出显式
     章节来源），并补契约 spec；
  2. 建立补丁草稿承接（pending → ready → 人工 accept 后才回填），或明确维持
     「无写回」；
  3. 完成 1 后，把面板以**只读**形式挂载（候选：写作工作台工具抽屉 / review 侧栏），
     并补挂载测试；`onWritePatch` 仅在 2 就绪后启用，且永远不得自动 accept。
- **关联**：
  - `src/components/briefing/BriefingPanel.tsx` 顶部登记注释；
  - `e2e/briefing.spec.ts`（诚实边界注释）；
  - `src/components/settings/settings-sections-mount-coverage.spec.ts`（同类
    「挂载或登记」门，作用于 settings/sections，见 §2）。

---

## 2. settings/sections 未挂载 section（显式 legacy 清单）

- **清单真源**：`src/components/settings/settings-sections-mount-coverage.spec.ts`
  的 `LEGACY_UNMOUNTED_SECTIONS`（每条含 `reason` 未挂载原因 + `recovery` 恢复条件，
  spec 会校验非空）。
- **门控语义（双向）**：
  - 在 `src/components/settings/sections/` 新增未挂载且未登记的 section →
    测试变红并点名该文件；
  - legacy 文件被接回 `settings-view.tsx` 挂载链但未移出清单 → 同样变红。
  - 「挂载」按值 import / 动态 import / re-export 的传递可达判定（`import type`
    不算挂载）。
- **当前登记条目**（与 spec 清单同源，仅摘要）：

  | 文件 | 一句话原因 |
  |------|-----------|
  | `about-section.tsx` | 版本信息重复入口（changelog-section 已显示当前版本），无导航类目 |
  | `multimodal-section.tsx` | ~~图片 caption 配置 UI 未挂载~~ 2026-10-30 UX 审计批次四已挂载：设置 → 模型与工具 → 图片描述 |
  | `output-section.tsx` | ~~outputLanguage 无 UI~~ 2026-10-30 UX 审计批次四已挂载：设置 → 写作 → AI 回复语言（showHistory=false，历史消息数仍只在小说页编辑） |
  | `scheduled-import-section.tsx` | 有意隐藏的历史类目（settings-hidden-legacy-sections.spec.ts 负断言） |
  | `source-watch-section.tsx` | 有意隐藏的历史类目（settings-hidden-legacy-sections.spec.ts 负断言） |
  | `web-search-section.tsx` | ~~集中式搜索 provider 配置无入口~~ 2026-10-30 UX 审计批次四已挂载：设置 → 模型与工具 → 网页搜索（即时保存）；拆文、大纲聊天的内联入口保留 |

- **恢复条件**：逐条见 spec 清单的 `recovery` 字段；重新暴露历史隐藏类目须同步
  修订 `settings-hidden-legacy-sections.spec.ts` 的负断言，避免两套断言互相矛盾。
