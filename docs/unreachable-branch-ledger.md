# 不可达分支台账（覆盖率战役收口证据）

> 全口径 100% 目标下，以下 file:line 经论证为真正不可达（或仅防御性死代码），
> 不通过硬写测试伪造覆盖。每条含论证依据。最终由用户裁决：保留为 reported-gap
> 或加入 vite.config.ts 的 v8 ignore 列表。

## lib

### lib/path-utils.ts
- **L26 `?? p`**（getFileName）：`normalized.split("/").pop()` 对任意字符串恒返回数组元素（空串输入返回 `""`），pop 永不返回 undefined → `?? p` 回退不可达。死代码。

### lib/wiki-cleanup.ts
- **L50 `?? normalized`**（normalizeWikiRefKey）：同上，`split("/").pop()` 永不返回 undefined → 回退不可达。死代码。

### lib/deep-thinking-stream.ts
- **L30 `|| raw`**（stageKey 内部函数）：唯一调用方 updateThinking 先 `content.trim()` 且守卫 `!trimmed` 早退，传入 stageKey 的 raw 首行必非空白；`split("\n",1)[0]?.trim()` 恒为真值 → 回退不可达。防御性代码。

### lib/chat-copy-content.ts
- **L31 false 分支**（`if (!/<think(?:ing)?>/i.test(prefix))` 的 else）：配对块与未闭合开标签两条正则先执行——任何残存的 `<think` 开标签都会被 unclosed 正则（`<think…>$`）从该位置一直删到串尾，因此残存 `</think>` 的 prefix 中不可能再含开标签 → 条件恒真，false 分支不可达。

### lib/endpoint-normalizer.ts
- **L88/110/126/130 部分分支**：IPv4 非法段与 azure-regex 回退分支——`new URL(...)` 先抛异常即短路，后续分支不可达（前序已论证，待最终核对行号）。

### lib/novel/residual-campaign.ts
- **insufficient_samples 分支**：唯一调用方使用默认 `samples=5`，样本不足分支不可达（前序已论证）。

### lib/novel/outline-import.ts
- **`untitled` 回退分支**：标题为空时调用方已有守卫（前序已论证）。

### lib/text-chunker.ts
- **L423-425、L454-456**：atoms 永不包含空行，段落内空行拆分分支为死代码（前序已论证）。

### lib/rerank-api.ts
- **L30 部分**：`isDirectRerankEndpoint` 要求 URL 带 `/rerank` 后缀，另一侧不可达（前序已论证）。

### lib/agent/tools/write-outline-node.ts
- **L63 `return String(value)`**（jsonObjectToMarkdown 尾部兜底）：函数按 `null/undefined`、`string`、`number/boolean`、`Array`、`object` 依次早退，剩下能落到该行的只有 `function` 与 `symbol`。而本函数的唯一入口是 `convertJsonToMarkdown` 里的 `JSON.parse`（write-outline-node.ts:14），JSON 值域不含 function/symbol → 从本模块入口不可达。防御性代码。

### lib/agent/tool-call-parser.ts
- **L168 `: ""` 分支**（parseTextToolCalls 的 residualText 三元式）：`candidate` 只可能来自 `extractJsonCandidates` 的三个来源——① `text.trim()`（本身就是 text 的子串）、② `text.slice(firstObj, lastObj + 1)`（显然是子串）、③ 代码块围栏内的捕获组 `.trim()`（trim 只削首尾空白，结果仍是 text 的子串）。三者都满足 `text.includes(candidate) === true`，故 else 分支不可达。防御性代码。

### lib/novel/skill-hub-seed.ts
- **L19 else 穿透 / L20-22 glob catch / L23-41 fs-walk / L42-44 webview catch**（loadSkillHubModules 运行时分区）：函数在模块顶层无条件执行一次。vitest 下 `import.meta.glob` 被 Vite 编译期内联，恒返回仓库 `skills/SkillHub` 实有的 75 个 SKILL.md（已数过），`Object.keys(...).length > 0` 恒真，故 L20 以下永不执行。`npx tsx` 实测无 glob 变换时抛错 → fs-walk 真实走通并加载 75 个 Skill（`SKILLS_VIA_FSWALK:75`），故 fs-walk 是 Node 脚本运行时的活代码，不是死代码；仅在 vitest 分区下不可达。L42-44 仅当 `node:fs` 为 throwing shim 的 webview 分区触发。运行时分区代码。
- **L67 `?? ""`**（getSkillHubFolder 无匹配回退）：唯一调用链是 `DEFAULT_SKILL_HUB_SKILLS` 的 `Object.entries(skillHubModules).map(...)`，key 要么是 glob 的 `"../../../skills/SkillHub/<Folder>/SKILL.md"`，要么是 fs-walk 的绝对路径（同样含 `/skills/SkillHub/<Folder>/`），正则 `/SkillHub\/([^/]+)\//` 恒匹配 → 右端不可达。行本身被执行，仅分支边缺失。

### lib/novel/search-strategy.ts
- **L414 both-empty `return 1.0`**（shingleSetJaccard 私有函数）：仅有的两个调用点——`charShingleJaccard`（L443-447）与 mmr 内部 `simBetween`（L496-501）——都在调用前做了完全相同的 both-empty 短路（`a===b` / trim 相等 / 双空返回），故私函数内的该行永不可达。防御性代码。
- **L563-565 tie-break `u < bestIdx` 分支**：`unselected` 是按候选下标升序插入的 `Set`（`candidates.map((_, i) => i)`），迭代顺序恒升序；每轮首个访问的 `u` 即走 `bestIdx===-1` 分支成为最小值，后续 `u` 恒大于 `bestIdx` → `u < bestIdx` 永假。防御性 tie-break。
- **L582 `break`**：`while (selected<targetK && unselected.size>0)` 保证循环体进入时 `unselected` 非空，`for` 至少执行一次、首次即走 `bestIdx===-1` 分支置位，故循环结束时 `bestIdx!==-1` 恒成立 → else-`break` 不可达。
- **L600 `?? str`**（extractNodeStem）：`String.split` 恒返回 ≥1 元数组，`pop()` 永不返回 undefined → 回退不可达（判例模式 1）。
- **L976 `!has(anchor)` false 侧**：`resolvedAnchors` 的全部返回点都是 `Array.from(resolvedSet)`（去重），`distanceMap` 初始为空，故首见恒为 miss → 已存在跳过侧不可达。

### lib/novel/deep-chapter-generation.ts
- **L635-639 / L834-838 `flush().catch` 回退**（manualHandoff 与 run-end 两处）：`statusMerger` 为空（`input.snapshotWriter` 缺省）时 `if` 不进；非空时 legacy 路径下唯一的 `schedule` 生产点在 route 块 L468（`if (routeInstruction)` 内，现有测试/生产配置恒走 legacy、`routeInstruction===null`，且 route 块本身 v8 ignore），故 pending 恒空 → `flush()` 直接返 `false` 不抛错 → `.catch` 永不触发。防御性代码（判例模式 2；若未来测试启用 route 模式需重审）。

### lib/novel/main-control.ts
- **L376-377 `getSkillConfig: () => null` / `getChatConversations: () => []`**：`enabledToolNames` 由 `MAIN_CONTROL_TOOLS` 白名单过滤产生（L295-296 `filter(name => allowed.has(name))`，调用方点名也无法扩大），白名单 12 项不含 `read_chat_history`/`apply_skill`；`registerAllBuiltInTools`（tools/index.ts:98/122）按名注册，故这两个 getter 永远没有对应工具实例去调用。`ToolFactoryOptions` 类型又强制要求传桩 → 桩体永不执行。类型占位死代码。

### lib/novel/de-ai-skill-library.ts
- **L785-787 整体回退分支**（deleteProjectDeAiSkill）：L782 已守卫 `skillId` 必为 `project:` 前缀。`next` 经 `normalizeDeAiSkillConfig`（L578-580）保证 `default ∈ knownIds（BUILT-IN ∪ 剩余 project）`；被删的 `skillId` 既不在剩余 project 中，也不在 `built-in:*` 集合中 → 首析取 `next.defaultSkillId===skillId` 永假；`getAllDeAiSkills(next)` 含全部 project + 全部内建 id → `!some(...)` 永假。故整个 `if` 体不可达。
- **L598 `(config.builtInSkillOverrides ?? [])` 右端**（getAllDeAiSkills）：仓内全部生产调用点传入的 config 均经 `normalizeDeAiSkillConfig`（L571-577 恒产出数组，`[]` 保底），`?? []` 右端不可达（判例模式 3；直接手造未归一化对象可触发，但不属公共 API 调用路径）。

### lib/agent/plugins/select-skills-plugin.ts
- **L501-506 残留补齐循环体**（topoOrderPlan）：该函数模块私有，唯一调用点 L424 在 `if (!parsed.ok) return empty` 之后；`parseCapabilityPlan` 经 `validateCapabilityPlan`（capability-planner.ts:177-210，含 DFS 环检测 :208、自环 :191、悬空依赖 :192）保证传给 topo 的 plan 无环。Kahn 算法在无环输入下必访问全部节点 → 残留补齐 `if` 永假。防御性防漏选代码。

### lib/novel/story-simulation/simulation-engine.ts
- **L1184-1185 `usedIndex` 落盘分支**（runSimulation 随机事件）：唯一调用点 L1174 首参为 `stagedPool ?? state.dynamicEventPool`。非空池恒经 `stringArrayToStagedPool` 转成分阶段对象（L891-896；空池则两边同为 `undefined`）；`StoryNode.index` 类型为必填 `number`（types.ts:274），`totalNodes` 为实数 → `generateRandomEvent` 恒走分阶段分支（L390），只产 `usedEventId` 不产 `usedIndex`；空池走 `RANDOM_EVENTS` 也不产下标。故 `usedIndex` 恒为 `undefined`，首项恒假。legacy 下标 plumbing 仅对直接调用生效，本调用点不可达。历史遗留防御代码。

### lib/novel/outline-multi-agent-orchestrator.ts
- **L497 `runSingleAgentFallback: async () => ""`**（resumeInput 类型占位桩）：`OutlineMultiAgentRunInput` 接口强制该字段（L54）；`runDependencyGraph`（L233-338）只用 `runSubAgent`/`onStatusChange`，从不调用它；真正的三次回退调用（L171/194/216）走的都是原始 `input`。桩体经公共 API 永不执行。类型占位死代码。

### lib/novel/foreshadowing-cleanup.ts
- **L402-403 `applyMergeIssue` 内 kind 守卫 throw**：函数模块私有，唯一调用方 `applyCleanupIssue`（L555）在调用前已做完全相同的校验并先抛错（L551-553），两者之间无对象变异 → 私有守卫的 throw 侧永不可达。防御性双重守卫。

### lib/novel/director-auto-advance.ts
- **L437-438 外层 catch `return null`**（loadBlueprintForGate）：try 体两项全量兜底——① `import("./world-blueprint")` 目标静态存在，导入永不失败；② `loadWorldBlueprint` 内部自带 try/catch（world-blueprint.ts:134-140），异常返回 null 永不 reject。故外层 catch 不可达。防御性代码（判例模式 2）。

### lib/novel/campaign-runner.ts
- **L595-602 arc-settlement 可观测事件块**：守卫 `shouldTriggerArcSettlement(currentChapterNum, null)` 的 `arcEndChapter` 实参是字面量 `null`；被调函数首行即 `if (arcEndChapter === null) return false`（arc-settlement.ts:41-46）→ 恒假 → 事件体不可达。待 `TODO(B2-arc)` 接入真实弧边界来源后自然可达。占位可观测代码。

### lib/diagnostics/health-check.ts
- **L107 `return "healthy"` 尾部兜底**（worst）：`worst` 模块私有，唯一调用方 `collectHealthReport` 传入固定 7 元检测器数组（L578，非空）；`SEVERITY_ORDER` 穷举 `HealthStatus` 全部 5 值，循环内必命中 `return` → 尾部兜底不可达。防御性代码。

## components

### components/settings/sections/about-section.tsx
- **L29 `row.mono ? "font-mono" : ""` false 侧**：`infoRows` 是硬编码单元素数组（唯一行 `mono: true`），非 mono 分支经公共 API 不可达。防御性三元。

### components/settings/sections/about-section.tsx（修正）
- **L29 注释形式修正**：JSX 元素行前的独立注释（裸 `/* */` 或 `{/* */}`）均无效，改为同行 `{}` 表达式内联注释 `{/* v8 ignore next */ row.mono ? ...}`。

### components/chat/chat-resume.ts
- **L42/L61 `active_step_index` 非数字 → "unknown" 侧**：`resolveStatusResumeCheckpoint` → `activeStepIndexToCheckpointStage` 对非数字索引返回 undefined → checkpoint 为 null → 两个 builder（`buildInterruptedResumeVisibleThinking` / `buildInterruptedResumeContext`）根本不会被调用。防御性三元，行级 start/stop 注释。

### components/settings/llm-presets.ts
- **L471 `preset.apiMode ?? "chat_completions"` 回退侧**：LLM_PRESETS 中所有带 baseUrl 的 custom 预设都显式声明 apiMode（含 azure 走 azure 分支），`??` 回退静态不可达。

### components/settings/hooks/use-batch-model-test.ts
- **L145-147 内层三元 `prev.success ? prev.message : ""`**：`failedModels` 仅在失败时填充，失败时 `success=false`；`success=true` 时 `failedModels` 必为空数组→ `removeFailedModel` 走 `!prev.failedModels` 早退。success=true 侧不可达，行级 start/stop。

### lib/novel/chapter-utils.ts
- **L399 `split("/").pop() ?? ""` 回退**：非空字符串 split 后 pop() 永不为 undefined，`?? ""` 死代码。

### components/editor/frontmatter-panel.tsx
- **L285 `name.split(".").pop() ?? ""` 回退**：pop() 永不为 undefined。

### components/search/search-view.tsx
- **L731 `split("/wiki/").pop() ?? result.path` 回退**：pop() 永不为 undefined。

### components/sources/outline-chat-panel.tsx
- **L517 `outlinePath.split("/").pop() ?? draft.title` 回退**：pop() 永不为 undefined。

### components/settings/sections/changelog-section.tsx
- **L142 `{errorMessage || "检查更新失败"}` 回退**：组件内所有 `setUpdateStatus("error")` 调用点都同步写入非空 errorMessage，error 态下回退文案不可达。行级 start/stop 包裹。

### components/settings/sections/maintenance-section.tsx
- **L348-350 `pendingPositionByTaskId.get(task.id) ?? 0` 回退**：map 由全部 pending 任务构建，task.status==="pending" 时 id 必在 map 中。`?? 0` 不可达。

### components/settings/sections/saved-models-manager.tsx
- **L97 `customEndpoint.trim() || ""` 回退 + L100-104 `if (!endpoint)` 早退**：拉取按钮 `disabled={!formData.customEndpoint.trim()}`，endpoint 为空时 handleFetchModels 无法经 UI 触发，防御性早退死代码。行级 start/stop。

### components/layout/activity-panel.tsx
- **L44 `FILE_TYPE_LABELS[dir] ?? dir` 回退**：FILE_TYPE_ICONS 与 FILE_TYPE_LABELS 键集合完全一致（6 个 dir 相同），Record 查找必命中。

### components/lint/lint-view.tsx
- **L68 `typeof next === "function" ? next(prev) : next` 非函数侧**：内部 setResults 的 5 个调用点全部传函数，非函数侧不可达。

### components/layout/soul-sidebar-panel.tsx
- **L68 `auraNameById.get(auraId) ?? "新角色灵魂"` 回退**：改绑下拉的 option 全部来自已加载 aura 列表，选中值必在 map 中。

### components/sources/source-sidebar.tsx
- **L545 `else if (!node.is_dir)` 未取侧**：countFiles 仅接收 filterTree 过滤后的树（空目录已剔除），「无 children 的目录」节点不可达。行级 start/stop。
- **L634 `if (!target) return` 早退**：hasMore=true 时哨兵元素必然渲染（visibleLimit < rows.length），refs 先于 effects 附加，target 必非 null。行级 start/stop。
- **【行为修复】轮询完成标记逻辑（原 L116-143）**：原实现把 `completed.push(path)` 塞进 `setExtractTaskIdsByPath` updater、再在 updater 外检查 `completed.length > 0`——React 18/19 并发下 updater 非同步执行，completed 恒为空，完成态永不上勾（Check 图标从未出现）。改为在 interval 回调内基于闭包快照直接计算 next/completed，再分别 setState。修复后 `提取完成→打勾` 与 `队列无记录视为完成` 两个既有测试断言同步修正为 Check 图标。修复源为真实缺陷，非为覆盖而改。

### 保留不删的防御守卫（s6 决策：不拿覆盖率换健壮性）

> 下面这些分支在**当前 UI 接线**下不可达，但删掉会把「防御性编程」换成「依赖调用点自律」。
> s6 曾派 agent 尝试按「删死代码」处理，编排方逐条复核后**全部回退**——理由是这些守卫
> 都在保护脏数据/并发/竞态，而非包裹真正的死代码。真死代码（构造上不可能执行、无任何
> 生产者）另见 use-simulation-worker 判例（该残留已整体删除）。

#### src/lib/novel/canon-backfill.ts
- **`backfillCanonHistory` 内 `chapter_number` 合法性校验分支**（原 L561-575，编排方已核）：
  `ep.chapter_number` 当前唯一生产者是 `buildBackfillOps`（取自 `loadBackfillSnapshot` 用文件名
  派生的 `snapshot.chapterNumber`，`parseDiscoveredChapters` 只产出 `\d{3}` → 1..999 整数），
  故「非法 → 回退 + warn」分支当前不可达。**保留理由**：源码注释原文即
  「DEBUG#8 / defensive D1：corrupt persisted chapter_number must not silently substitute the
  fallback chapter into a canon credential write. Validate first.」——它防的是**磁盘上持久化数据被
  篡改/损坏**这一真实故障面，而持久化数据正是本函数从外部读入的。删掉等于把「脏数据写进 canon
  凭据」重新变成静默可能。给这一段写测试需要伪造损坏的持久化快照，属可行但本轮未做，先记此账。

#### src/lib/novel/book-rules.ts
- **`validateFanficChapter` 的 `if (policy.mode === "cp") { if (policy.pairing) {...} }` 块**（编排方已核）：
  `fanficPolicyFromRules`（L77）硬编码 `pairing: null`，全仓无 `pairing` 生产者
  （`git grep "pairing:"` 仅命中类型声明、该硬编码、以及 L280 的读取点）→ 内层真支不可达。
  **保留理由**：`FanficPolicy.pairing` 字段与 L280 的读取逻辑都还在，删掉校验块会让「将来接线
  pairing 时校验静默不发生」。这是未接线功能，不是死代码；删它换覆盖率是负资产。

#### src/lib/novel/premium-execution.ts
- **`runDualProposal` 首行 `if (signal?.aborted) throw new Error("已停止生成")`**（编排方已核）：
  当前所有调用点传入的 `signal` 在进入函数时均未 abort，故本支不可达。**保留理由**：这是
  用户「停止生成」的唯一入口守卫，属于必须存在的竞态防护；删掉它换覆盖率是明确禁止的
  「为让测试通过而削生产代码守卫」。（本轮有一 agent 擅自改为 `if (false)`，已回退。）

#### src/components/novel/export-center-view.tsx
- **`loadExportCenterSnapshot` 的 `try/catch`**（编排方已核）：`countFinalChapters` 内部已
  try/catch 转 0，永不 reject → 外层 catch 不可达。**保留理由**：`countFinalChapters` 的实现细节
  属另一个模块的私有承诺，外层 catch 是跨模块防御；改成无 catch 等于让「上游某天改成会 reject」
  变成未处理拒绝。
- **`handleExport` 首行 `if (exporting !== null || projectPath === "") return`**（编排方已核）：
  三个调用点（Word/EPUB 按钮 `disabled={!canExport}`、覆盖确认按钮）在 exporting 非空时不可点
  或不存在 → 当前不可达。**保留理由**：这是**重入**守卫，并发保护不能只靠渲染层 disabled
  （确认对话框那条路径是异步续跑，不经过 disabled 判定）。

#### src/components/novel/story-simulation/story-draft-view.tsx
- **`handleImport` 里 `selectedIndices.length === 0` 报错分支**：确认按钮
  `disabled={importing || selectedIndices.length === 0}`，disabled 下原生 click 不派发 →
  当前不可达。**保留理由**：handler 若被键盘/程序化触发同样需要人话提示，且它承担
  `setTimeout(() => setError(null), 3000)` 的提示生命周期；删掉后「零选中」只剩一个禁用按钮、
  无任何解释文案。
- **`Dialog onOpenChange` 的 `else setShowImportDialog(true)`**：受控 Dialog 无 Trigger，
  `onOpenChange(true)` 当前不可达。**保留理由**：`open` 由 `showImportDialog` 驱动，缺 else 支时
  一次意外的 `onOpenChange(true)` 会让受控值与内部值漂移；保留为幂等写回。

#### src/components/skill-library/writing-skill-library-view.tsx
- **`handleOpenBundleImport` 首行 `if (!project) return`**：入口按钮在无项目时不渲染 →
  当前不可达。**保留理由**：函数内随后会用 `project.path` 拼导入目标；无守卫时若按钮接线变动
  会直接抛 TypeError。

#### src/components/settings/sections/data-management-section.tsx
- **`handleCleanLegacy` 首行 `if (!currentProject?.path) return`**：清理按钮在无项目时
  disabled → 当前不可达。**保留理由**：同文件 docx/epub/canon 三处同形守卫的先例；且该函数会
  触发不可恢复的向量表删除，务必保留纵深。
  （本轮有一 agent 在此处加 `/* v8 ignore next */`，因未走台账流程已随该文件一并回退。）

### 黑盒 UI 不可达：`disabled` 闸门对冲的 handler 首行守卫

> **判例依据（实测）**：React 19.2.4 下，`disabled` 表单控件的
> `element.click()` 与 `dispatchEvent(new MouseEvent("click"))` **都不触发合成 onClick**
> （合成事件层在派发前就丢弃）；把 `disabled` 去掉后同一派发路径立刻命中。
> 因此「JSX `disabled={X}` 与 handler 首行 `if (X) return` 条件等价」时，
> 守卫的真分支在**纯黑盒 UI 测试**下不可达。
> 注意这只说明「黑盒测不到」，不说明代码该删——它们是防重入/防无项目写盘的兜底，
> 保留是刻意的（见本文件「保留不删的防御守卫」小节的原则）。

#### components/skill-library/skill-library-view.tsx
- **L116 / L287 / L307 / L316 / L323 / L334 / L343 / L361 各 `if (...) return` 真支**（12 语句 / 16 臂）：
  闸门分别为 L145 `disabled={!config || !project || saving}`（与 L116 守卫逐项相同）、
  L562 `disabled={!canSaveDraft}`（Ctrl+S 监听 L384 同样先判 `canSaveDraft`）、
  L571 `disabled={!draftChanged || saving}`（`draftChanged` L241 在无选中时恒 false）、
  L483 / L504 / L493 / L412 / L421。
- **L97-100 / L266-270 两处 `persist` 内 `!project` 早退**：唯一调用链上游已同判
  （L116 / L123 首行 `!project` 早退；详情侧 save 走 `canSaveDraft`(L245 含 `project`)、
  setDefault/delete/reset 按钮 L483/L504/L493 的 `disabled` 均含 `!project`）。
  同一闭包内 `project` 不可能两处取值不同，故第二道闸无消费者。
- **纯回退臂** `B16:34`/`B16:54`：`config.defaultSkillId || allSkills[0]?.id || ""` ——
  `normalizeDeAiSkillConfig`（de-ai-skill-library.ts:579-580）无条件把 `defaultSkillId`
  归一为已知 id，`getAllDeAiSkills`(597-601) 恒含内置技能 ⇒ 前段恒真。
  `B263:100`：`updateDraftDirty` 的 `: false`，三个调用点都在编辑器分支内的 onChange ⇒
  `selectedSkill` 恒非 null。`B329:48`/`B329:81`：`deleteProjectDeAiSkill`(781-789) 归一后
  `defaultSkillId` 恒非空。`B475:20`：该 JSX(439-475) 位于 L431 `) : (` 编辑器分支内，
  `deAiSkillToUserSkill`(624) 返回非空 `UserSkill`。

#### components/skill-library/writing-skill-library-view.tsx
- **L39 `handleOpenBundleImport` 的 `!project` 早退**：触发按钮 L577-584 位于
  L561 `{config && project ? ... : null}` 内，无项目时**按钮被卸载**（不是禁用）。
- **L140-143 `persist` 的 `!project`**：三个调用点(173/203/210)首行已判 project；
  唯一未判的 `handlePackImported`(160) 的触发器 `SkillPackPanel` 同在 L561 同一区块内。
- **L173 / L210**：L540 `disabled={!canSaveDraft}` / L333 `disabled={!project || saving}`。
- **L220 `handleExportSkill` 的 `!selectedSkill`**：触发按钮 L322-328 只在 L298 编辑器分支渲染。
- **L241 `handleReloadLinkedContent`**：触发按钮 L496-502 只在 L492 `{isLinkedSkill ? ...}` 内 ⇒
  三个臂（无选中 / 非外链 / 无 config）均无消费者。
- **`B136:8`**、**`B589:75`**（`|| config.categories[0]?.id || ""` 第三段）：
  `loadUserSkillConfig` → `ensureBuiltinSkills`(user-skill-store.ts:454-471) 合并
  `DEFAULT_SKILL_ROUTE_CATEGORIES`（skill-route.ts:17，`skill-route.spec.ts:40` 断言行数=9）
  ⇒ `categories` 恒非空。

#### components/skill-library/unified-skill-library-view.tsx
- **L171 / L187 / L203 / L211 / L237 / L244 六个 `if (!project || saving) return` 真支**：
  四个 header 按钮 L286/L289/L295/L298 统一 `disabled={disabled}`，而 L280
  `const disabled = !project || saving` —— 与守卫**条件完全相同**；两个 `persist*Config`
  也只由这些已判调用方触发。
- **`B138:101`**（`compact` 真段）：`SkillLibraryHeader`(L128) 未导出，唯一调用点
  L313 `<SkillLibraryHeader />` 不传 `compact`。
- **`B175:6`**（`if (nextSkillId)` 隐式 else）：`nextSkillId` 取自 `loadUserSkillConfig` →
  `ensureBuiltinSkills` 恒注入内置写作技能 ⇒ `normalizeUserSkillConfig`(113-115) 的
  `selectedSkillId` 恒非 null。
- **`B500:87`**（`|| "未分类"`）：writing 条目 `kind` 经 `normalizeUserSkill` 的
  `uniqueValid(value.kind, VALID_KINDS, ["style"])`(skill-library.ts:134) 恒非空；
  de-ai 条目硬编码 `["rewrite","style"]`(L49)。

### lib/novel/skill-hub-seed.ts（运行时分区代码）
- **15 条语句**全部落在 `readdirSync` 的 `try` 成功路径与目录遍历分支上：
  该模块在 **Node/tsx 启动脚本**里跑真实的 fs 遍历来播种技能中枢种子，
  而 vitest 是 jsdom 环境、且该函数在 Tauri 侧走 `@tauri-apps/plugin-fs` 分支。
  两套运行时互斥，jsdom 下无论怎么造都会走 catch/回退分支。
  这是**运行时分区代码**（不是死代码），正确处置是记账而非强测或删除。

### lib/novel/deep-chapter-review-repair.ts（⚠ 本条已证伪，禁止 v8 ignore）

> **2026-11-06 更正**：原条目声称「L253-275 stage-5.5 块结构性不可达（overall==="pending"
> 被 buildDecisionGates 重写后恒不成立）」。该结论**已被 ISS-20260708-016 证伪**：
> `hasCheckpointRevision` 在 repair 主路径确有调用，revision checkpoint + pending 门控
> 即可命中该分支。源码 L251-252 留有当时的结论注释，且 `p1-dedup-016-stage55.spec.ts`
> 是锁定此事的回归护栏——它断言「阶段5.5：返修后复审」前 6 行内**不得出现** `v8 ignore`。
>
> 本次战役曾按本条给该块加块级 `v8 ignore`，被该护栏测试当场抓住并回退。
> 教训：台账条目本身也可能过期，标注前必须交叉验证源码注释与既有回归测试，
> 不能只信台账。
>
> **当前真实状态**：该块在既有全量跑中仍 count=0，但可达性已由静态推理 + 逻辑单测确认，
> 属于「可达但未被真实驱动」。正确处置是**补一个真正走 resume 路径的用例**，不是抑制。

### components/novel/story-simulation/branch-compare-view.tsx
- **L44 `default: return String(key)`**（dimensionLabel）：参数类型为 `keyof DirectorScore`（7 键联合），`switch` 穷举 7 案；调用点 L154/249（`DIMENSION_KEYS` 字面量迭代）与 L401（`d.key as keyof DirectorScore`）全在类型内 → default 不可达（判例模式 8）。
- **L363-365 `branches.length<2` 早退**（KeyDifferencesTab 内 effect）：外层 `BranchCompareView` 在 `compareBranches<2` 时提前返回 `selectAtLeastTwoBranches`（L525-536），`KeyDifferencesTab` 仅在 ≥2 时挂载（L592）；父级 `story-simulation-view` 传的是实时 branches，收缩时外层先卸载本 Tab、effect 不会带着新 props 重跑 → 内层重复守卫仅防挂载后收缩竞态，当前调用点无收缩。防御性代码。

### components/skill-library/writing-skill-sidebar-panel.tsx
- **L123-126 `persist` 内 `!project` 早退**：`persist` 为组件内私有函数，全部 8 个调用方（handleDragEnd/Select/Create/Import/ToggleSkill/CreateCategory/RenameCategory/DeleteCategory）调用前均已 `if (!config||!project||saving) return`；按钮亦 `disabled={!config||!project||saving}`（L368/376）；且项目关闭时 `useWritingSkillConfig` 随 projectPath 变更即 `setConfig(null)` → 内层 `!project` 为第二层防御，不可达。
- **L150 / L163 create/import 守卫 `!config||!project||saving`**：对应按钮 disabled 下原生 click 不派发 `onClick`（已有 spec 绕 disabled 派发不触发 handler 实证），无项目/无配置时 handler 无法经 UI 触发，函数未导出 → 防御性早退死代码。

### components/skill-library/writing-skill-library-view.tsx
- **L39 `handleOpenBundleImport` 内 `if (!project) return`**：函数仅在 `{config && project ? ...}` 挂载块内的按钮（L581）可点到，函数未导出 → 不可达。挂载门控防御。
- **L140-143 `persist` 内 `!project` 早退**：`handleSaveSkill` 被 `canSaveDraft`（本身要求 project，L94）拦截，`handleToggleEnabled`/`handleDeleteSkill` 自带 `!project` 守卫；`handlePackImported` 不判 project，但其唯一触发源 `SkillPackPanel.onImported` 只挂载于 `{config&&project}` 块（L587-591）→ 第二层防御，不可达。
- **L160 `!result.ok || !config` 守卫**（handlePackImported）：`!config` 被挂载守卫排除；`!result.ok` 被 `SkillPackPanel:122`（`if (imported.ok)` 才调 `onImported`）排除 → 双项皆死。
- **L173 / L203 / L210 / L220 / L241 守卫中的 `!config` / `!selectedSkill` / `!project` / `source!=="linked"` 项**：保存按钮 `disabled={!canSaveDraft}`（L540，`canSaveDraft` 要求四者全真）；删除按钮 `disabled={!project||saving}`（L333）；toggle checkbox 与导出/删除行仅在 `selectedSkill` 真时渲染（L294 三元空态分支，`selectedSkill` 又派生自 `config?.skills` L58-61）；重载按钮仅在 `{isLinkedSkill ? ...}` 卡片内挂载（L488，`isLinkedSkill = selectedSkill?.source==="linked"`）→ 均为挂载/禁用门控下的第二层防御。

### components/settings/sections/webhook-section.tsx
- **L32-33 `ping` 内 `!url.trim()` 早退**：`ping`/`verify` 均为组件内 `useCallback`，未导出；ping 按钮 `disabled={!url.trim()}`（L113），原生 disabled 拦截 click（空 URL 用例实证无请求发出）→ 早退不可达。
- **L70 `verify` 内 `!lastSigned` 早退**：验签按钮 `disabled={!lastSigned}`（L117），未签名不可点 → 不可达。

### components/skills/SkillPackPanel.tsx
- **L88-89 `stripped_tool_fields` / `stripped_pack_fields` 分支**（exportWarningText）：面板内 `buildPack` 调用固定 `options={name,version}`（L70-73），`options.tools` 恒 undefined → `tools=[]` → 前者永不产生；pack 顶层键固定且无一命中凭据键（`stripCredentialKeys` 只扫对象键，prompts 条目仅 `{id,body}`，body 字符串值不扫描）→ 后者永不产生。props 无法改变固定 options → 不可达。防御性分支。

### components/novel/story-simulation/simulation-report-view.tsx
- **L58-59 `formatDate` catch 回退**：`new Date(string)` 对任意输入永不抛错（非法串得 Invalid Date 对象）；`toLocaleString` 参数固定合法 → catch 不可达。防御性代码。

### components/novel/story-simulation/interview-history-view.tsx
- **L163-164 `formatDate` catch 回退**：同上判例，`new Date(string)` 永不抛错 → 不可达。防御性代码。

### lib/novel/canon-backfill.ts（两处，均为防御守卫）
- **L559 `if (op.canonPayload.kind !== "episode") continue`**：循环遍历的 `ops` 只来自 `buildBackfillOps(snapshot)`（L541），该函数唯一构造点（L223-232）硬编码 `canonPayload: { kind: "episode" as const, ... }`，无分支；supersede 操作另存于 `supersedeOps`/`allOps`（L548-551），不进入此循环。类型上是联合类型，故该守卫是未来 producer 变更的契约保护，删除即失去保护。
- **L571-574 invalid chapter_number 告警**：`ep.chapter_number` 取自 `buildBackfillOps` L227 的 `snapshot.chapterNumber`，而 `loadBackfillSnapshot`（L176-191）末尾 `return { ...parsed, chapterNumber: chapter }` 强制覆盖为发现章节号；`chapter` 来自 `parseChapterSnapshotFileName`（L78-83：`^(\d{3})\.snapshot\.json$` 且 `n >= 1`），恒为 1..999 正整数。故 `chapterNumber !== parsedChapter` 恒假。源码注释自称「defensive D1」。

### components/novel/pipeline-motion-panel.tsx
- **L354 `if (total === 0) return`**：L352-353 `useDemo = sourceEvents.length === 0`、`total = useDemo ? demoEvts.length : sourceEvents.length`。sourceEvents 非空 → total>0；为空 → total = `demoEvents()`（L131-145）返回固定 8 条字面量，永不为空。组件 props 只暴露 `projection`/`input`（L28-33），无法注入空 demo 流，也无法 mock 同文件私有函数。防御守卫。

### components/settings/sections/external-control-section.tsx
- **L211 `if (!status) return`**：`copyEndpoint` 唯一调用点是 L347 按钮，同按钮 L348 有 `disabled={!status}`，两处取同一次渲染的 status。React SimpleEventPlugin 对被 disabled 的表单元素不派发鼠标事件，handler 只可能在 status 为真时进入。**实测证据**：既有用例 `external-control-section.spec.tsx:509-522` 已对 disabled 按钮 `fireEvent.click` 并断言「未写剪贴板」，而同次覆盖里 L211 仍 count=0 —— 点击确实未进入 handler。属「disabled 闸门对冲 handler 守卫」判例（见上文 skill-library 三视图同型论证）。

### lib/mcp/draft-actions.ts
- **L47 `if (!cleaned) throw new Error("名称清洗后为空")`**：`sanitizeName` 为私有函数，全部 3 个调用点（L58、97、103）都以 `requireText(...)` 返回值为实参；`requireText`（L37-42）在 `value.trim() === ""` 时先行抛错，而 `cleaned = name.trim().replace(/[\/:*?"<>|]/g, "_")` 只做替换不做删除，故 `cleaned === ""` 当且仅当 `name.trim() === ""`，与前置条件直接矛盾。纵深防御守卫。

### lib/novel/pipeline-motion-projection.ts
- **L166 `default: return null`（eventToStage）**：switch 已穷举 `RunEventKind` 的 9 个字面量（见 `run-event-ledger.ts:48-61`）；运行期所有 producer 都经 `appendRunEvent` → `normalizeEvent` → `RUN_EVENT_SCHEMA.parse`（`run-event-ledger.ts:167-180`），zod `z.enum(RUN_EVENT_KINDS)` 对未知 kind 直接抛 `RunEventIntegrityError`；磁盘回放 `parseLedgerText`（`run-event-ledger-store.ts:124-146`）逐行走同一校验并 fail-loud。故未知 kind 无法到达投影函数。前向兼容防御分支。

### lib/novel/skill-hub-seed.ts（补充运行时分区证据）
- **L23-44（15 条，fs 遍历兜底 + 其 catch）**：L15 的 `import.meta.glob("../../../skills/SkillHub/**/SKILL.md", {eager:true})` 被 Vite 在构建期内联为静态对象字面量（非函数调用），永不抛错；仓库内 `skills/SkillHub` 恰有 75 个 SKILL.md，L19 `Object.keys(globbed).length > 0` 恒真并 return。**实测证据**：同一次 v8 覆盖中 `skill-hub-seed.spec.ts` 全过且 `DEFAULT_SKILL_HUB_SKILLS.length === 75`，而 L23-44 全部 count=0 —— 若走过 fs 遍历，这些语句必然 >0。

### lib/novel/related-chapters.ts（冗余惰性构造，实测确认）
- **L162-163 `rset = new Set(existing.reasons)` / `reasonSets.set(chapter, rset)`**
  与 **L171-172 `eset = ...` / `entitySets.set(chapter, eset)`**：`byChapter` 的唯一写入点是
  同函数 else 分支（L186-193），而该分支在 `byChapter.set(...)` 之后**立即**执行
  `reasonSets.set(chapter, new Set([reason]))` 与 `entitySets.set(chapter, new Set([entity]))`。
  因此凡 `existing` 为真的章，两个 Map 必然已有条目 → `if (!rset)` / `if (!eset)` 恒假。
  这是 ISS-20260709-051（reasons/matchedEntities 判重改 Set O(1)）改造后的遗留冗余。
  **实测证据**：专门写探针把两条伏笔放在同一章（`轩辕剑封印` + `玉佩来历`，均命中大纲），
  断言 `matchedEntities === ["轩辕剑封印","玉佩来历"]` 成立，而同次 v8 覆盖里 L162/163/171/172
  仍 count=0 —— 即「同章第二次命中」确实发生了，但惰性构造确实没被执行。
  判定：**保留**。它不是纯死代码，而是 else 分支若被未来改动移除 seed 时的兜底；
  按「防御守卫一律保留并记账」处理，不删除。

### components/skill-library/skill-library-view.tsx（逐条核对 disabled 表达式，2026-11-06）

> 这一组曾被笼统归为「disabled 闸门对冲」。本次逐行核对每个触发按钮的 `disabled`
> 表达式与 handler 守卫是否**逐字等价**，区分出三种不同机制——它们都不可达，
> 但证明方式不同，混为一谈会在未来改动时误判。

| 行 | 守卫 | 触发按钮 disabled | 机制 |
|----|------|-------------------|------|
| 98-99 | `persist`#1 `if (!project)` | — | **第二道防线**：两个调用方 `handleCreateSkill`(L116) / `handleToggleSkill`(L125) 都已先查 `!project` |
| 116 | `handleCreateSkill` 首行 `!config \|\| !project \|\| saving` | `disabled={!config \|\| !project \|\| saving}`（新建技能按钮 L145） | **条件逐字等价** |
| 268-269 | `persist`#2 `if (!project)` | 各调用按钮 | **传递蕴含**：`canSaveDraft = Boolean(project) && …`（L235）使所有可达路径都已有 project |
| 287 | `handleSaveSkill` 首行 `!config \|\| !selectedSkill \|\| !canSaveDraft` | `disabled={!canSaveDraft}`（L558） | **传递蕴含**（canSaveDraft 蕴含 project + selectedIsEditable） |
| 316 | `handleSetDefault` `!config \|\| !selectedSkill` | `disabled={!project \|\| saving \|\| !selectedEnabled \|\| config?.defaultSkillId === selectedSkill.id}` | disabled 表达式内直接解引用 `selectedSkill.id` / `config?.`，渲染前提已保证两者非空 |
| 323 | `handleDeleteSkill` `!config \|\| !selectedSkill \|\| selectedIsBuiltIn` | `disabled={!project \|\| saving}`，且渲染在 selectedSkill 分支内 | 渲染前提 + disabled 闸门 |
| 334 | `handleResetBuiltInSkill` 四条件 | `disabled={!project \|\| saving \|\| !selectedHasBuiltInOverride}` | 渲染前提 + disabled 闸门 |
| 343 | `handleRestoreBackup` `!project \|\| saving` | `disabled={!project \|\| saving}`（L412） | **条件逐字等价** |
| 361 | `handleRecreateConfig` `!project \|\| saving` | `disabled={!project \|\| saving}`（L421） | **条件逐字等价** |

**React 行为前提**（本仓实测，见上文 skill-library 三视图论证）：React 19.2.4 下
`disabled` 表单控件的 `.click()` 与 `dispatchEvent(MouseEvent)` 均不触发合成 onClick，
故「disabled 条件 == handler 守卫条件」时守卫真分支在纯黑盒 UI 测试下不可达。

### components/skill-library/writing-skill-library-view.tsx（探针实测渲染前提，2026-11-06）

> 判定手段：渲染时把 `project` 置空，枚举实际渲染出的 `data-testid`。
> 无项目时**渲染出的**是 enabled-checkbox / delete-button / save-button / 各输入框；
> **不渲染的**是 bundle-import-open、导出按钮、重载按钮。这决定了各守卫的不可达机制。

| 行 | 守卫 | 机制 |
|----|------|------|
| 39 | `handleOpenBundleImport` `!project` | **渲染前提**：唯一入口在 `{config && project ? (`（L561）内，无项目不渲染。已有用例「无项目时技能包导入入口不渲染」锁定 |
| 141-143 | `persist` `!project` | **多路径合并**：调用方要么先查 project（toggle/delete 守卫含 `!project`），要么触发按钮无项目时不渲染（导出/重载/导入） |
| 174 | `handleSaveSkill` | **传递蕴含**：`canSaveDraft = Boolean(project && config && selectedSkill && draftChanged && !saving)`（L94） |
| 211 | `handleDeleteSkill` | disabled 闸门 `{!project || saving}`（L333）+ 渲染前提排除 `!config`/`!selectedSkill` |
| 221 | `handleExportSkill` `!selectedSkill` | **渲染前提**：导出按钮无项目时不渲染（探针实测 testid 缺失） |
| 242 | `handleReloadLinkedContent` | **渲染前提**：重载按钮仅在 `source === "linked"` 技能下渲染（探针实测） |

---

### components/novel/story-simulation/story-draft-view.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 105-108 | `handleImport` 空选守卫 | 按钮 `disabled={importing || selectedIndices.length === 0}`（L462）与守卫**逐字等价** |
| 178 | `openEditDialog` `!draft` | 唯一入口 L265 在 `draft.chapters.map` 内，渲染前提已保证 draft 非空 |
| 186 | `saveEdit` `editingChapterIdx === null \|\| !draft` | 编辑对话框仅在 `editingChapterIdx` 非空时渲染，且打开前已要求 draft |
| 288 | `else setShowImportDialog(true)` | 该 `Dialog` 无 `DialogTrigger`，受控 `open` 只由 L224 按钮置 true；Radix 不会产出 `onOpenChange(true)`。**注意**：`/* v8 ignore next */` 对 `else` 子句无效，必须用紧贴的 start/stop 块 |

### components/novel/director-view.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 76 / 102 / 120 / 188 | `updateIdea` / `refreshSnapshot` / `handleAdvance` / `handleRetry` 的 `if (!persisted) return` | **渲染前提**：组件在 L252 `if (!started \|\| !persisted)` 提前返回，无 persisted 时本组件的按钮/输入框一律不渲染。注：同形的 L114 守卫**是覆盖的**（useEffect 在 persisted 为 null 时确实跑过），说明该结论只适用于渲染树内的 handler |


### lib/novel/anti-ai-candidate-pool.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 153 | `mean([])` → 0 | 唯一外部入参 `lengths` 来自 `detectParagraphLengthDist`，L595 `paragraphs.length < 3` 已提前返回 → 长度恒 ≥3 |
| 159 | `stddev([])` → 0 | 仅由 `coefficientOfVariation`(L169) 调用，入参同 `lengths` |
| 168 | `m === 0` → 0 | `splitParagraphs`(L134) 以 `.filter(p => p.length > 0)` 过滤空段 → `lengths` 全 > 0 → 均值恒 > 0 |
| 174 | `total === 0` → 0 | 唯一调用点 L462 传 `sentences.length`，而 L440 `sentences.length < 8` 已提前返回 |

### lib/novel/book-rules.ts（补充论证 2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 125-130 | `if (policy.pairing)` 内的配对检查块 | `pairing` 类型允许 `[string,string]`，但**全仓唯一赋值点是 L77 的 `null`**（`grep -rn "pairing:" src/` 只命中类型声明与默认值）；注释亦记「未配置配对时不判定（由 fanfic-canon-import 的 merge proposal 提供 pairing）」。待该 proposal 落地即自然可达 |


### components/skill-library/writing-skill-sidebar-panel.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 123-125 | `persist` `!project` | **第二道防线**：两个调用方 `handleCreateSkill`/`handleImportSkill` 已先查 project |
| 150 | `handleCreateSkill` `!config \|\| !project \|\| saving` | 与按钮 `disabled={!config \|\| !project \|\| saving}`（L368）**逐字等价** |
| 163 | `handleImportSkill` 同条件 | 与按钮 disabled（L376）**逐字等价** |


### components/novel/story-simulation/simulation-report-view.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 59 | `catch { return dateStr }` | `new Date(str)` 对任意字符串都不抛；Invalid Date 的 `toLocaleString` 返回 `"Invalid Date"` 而非抛错 |
| 92 / 215 | `if (typeof parsed === "string") return parsed.trim()` | 入参已被 `startsWith("[") && endsWith("]")` 约束，`JSON.parse` 不可能返回原始字符串（JSON 字符串字面量必以引号开头） |
| 175 / 200 | `onlyInB.has(...)` | **集合补集 vs 遍历源**：`onlyInB` 定义为「在 compareReport 而不在 report」，而调用点 L326/L374 遍历的正是 `report.characterAnalyses` / `report.branches` → 参数必属 report，恒不命中 |

### components/novel/corkboard-view.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 198 / 204 / 236 | `handleOpenChapter` / `handleCreateScene` / `handleDeleteChapter` 的 `if (!project) return` | **渲染前提**：组件在 L258 `if (!project) return null`，无 project 时整个渲染树不存在。注：同形的 L179 是 `useEffect`（project 为 null 时确实跑过）故已覆盖——该结论只适用于渲染树内 handler |

### components/novel/export-center-view.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 46 | `loadExportCenterSnapshot` 的 `catch { return { finalCount: 0 } }` | **永不抛的被调函数**：`countFinalChapters`（export.ts:325-330）自带 `try/catch { return 0 }`，故本 catch 是第二道防线 |
| 124 | 组件内 `loadExportCenterSnapshot(...).catch(...)` | 同上：被调函数内部吞掉一切，返回的 Promise 永不 reject |
| 135（未标注） | `handleExport` `if (exporting !== null \|\| projectPath === "") return` | **保留未标注**：`exporting !== null` 侧由 `disabled={!canExport}`（canExport 含 `exporting === null`）覆盖，但 `projectPath === ""` 侧与 `canExport` 的关系未经证明；L268 覆写确认按钮无 disabled，其时序亦未验证。留待补测 |

### components/backup/CloudBackupPanel.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 86 | `optionalRead` 的 `typeof read !== "function"` | **无调用方传 undefined**：3 个调用点（L171/190/193）一律传箭头函数字面量。形参的 undefined 分支是签名允许但无人使用的死守卫 |
| 96 | `optionalCall` 的同类守卫 | 唯一调用点 L620 传 async 箭头字面量 |
| 275（**未标注**） | `clearCredential` 的 `if (parsed === null)` | **可达，待补测**：按钮 `disabled={!secretControlsEnabled \|\| busy}`（L604）**不含** `parsedCredentialRef`，故「控件可用但无已解析凭据」时点清除即命中。不可标注 |

### lib/novel/budget-resume.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 136 | `stoppedBy = "suspended"` 的 else 分支 | `nextPendingTask`(L42) 保证任务**存在且未完成**，故 `completeBudgetTask` 只剩「预算不足」一种拒绝（L61-66），其 reason 恒含「预算不足」→ L133 恒真。L57（未知任务）与 L59（幂等拒绝）两条非预算拒绝路径在 `advanceBudgetBatch` 内不可达 |
| 143-145 | `if (current.status === "suspended")` | 接受路径 L76 只产 `done` / `in_progress`，永不产 `suspended` |

### lib/novel/mechanical-fingerprint.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 56 | `sentenceEntropy` 的 `lengths.length === 0` | 唯一调用点 L147 在 L103 `if (sentences.length === 0)` 提前返回之后 |
| 74 | `burstiness` 的 `mean === 0` | `splitSentences`(L51) 以 `.filter(s => s.length >= 2)` 过滤，每句长 ≥2 → mean ≥2 恒 > 0 |
| 81 | `percentile` 的 `sorted.length === 0` | `sorted` 来自同一 `lengths`，L103 已保证非空 |

### lib/novel/character-cognition.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 233 | `() => null as unknown as CognitionState`（`createAtomicJsonStore` 的 emptyCtor） | **死工厂**：同处传入 `onMissing:"null"` + `onCorrupt:"throw"`；projection-store 的 load 在缺文件 / 空文件时 `return null as T`、解析损坏时 throw，三条路径都不落到 `emptyCtor()` |
| 574-575 | `buildPovCognition` 函数体 | **已补测**：导出函数此前从未被调用。spec 用部分 mock 只替换 `canon-graph-client` 的 `getFactsKnownBy`，断言取数实参 `(proj, pov, chapter, true)` 与 `fromCanonGraph` 的投影结果 |

### lib/novel/deep-chapter-review-repair.ts L253-275（2026-11-06 结构性不可达，已坐实）

**结论：stage-5.5「返修后复审」块（L253-275，7 条语句）结构性不可达。**

控制流证明（`novelConfig.deepChapterReview === true` 是进入 L253 的必要条件）：

| 路径 | 条件 | gates 结果 |
|------|------|-----------|
| A | `!hasCheckpointReview(cp)` → L195 进 else（因 deepChapterReview 为真）| L213 `buildDecisionGates(...)` → **非 pending** |
| B | `hasCheckpointReview(cp)` 且 gates 为 pending | L241-242 重算 `buildDecisionGates(...)` → **非 pending** |
| C | `hasCheckpointReview(cp)` 且 gates 非 pending | 保持 → **非 pending** |

关键事实：`resolveOverallVerdict`（deep-chapter-decision-gates.ts L165-187）只返回
`manual_review` / `fail` / `warning` / `pass`，**永不返回 `pending`**。故三条路径穷尽后
L253 的 `decisionGates.overall === "pending"` 恒为假。

**既有行为锁已记录同一事实**：`deep-chapter-review-repair.spec.ts` L240-270 的用例名即
「after_revision 检查点且门控为 pending：门控先按 findings 重建，不再重复调用阶段5.5 复审」，
并断言 `thinking.join("
")).not.toContain("阶段5.5")` —— 即使传 `emptyDecisionGates()`
（pending）也进不去该块。

**为什么不能标注**：`p1-dedup-016-stage55.spec.ts`（ISS-20260708-016 回归护栏）断言
「阶段5.5：返修后复审」前 6 行（L249-254）不得含 `v8 ignore`。该护栏本身是**同义反复**
（只对两个字面量断言 `true && "pending" === "pending"`，从不调用生产函数），并不构成可达性证明。

**因此 statements 100% 在保留该死分支 + 保留该护栏的前提下不可达。** 三条出路都需人工决策：
1. 删除死分支（须同步删改 L240-270 行为锁与 p1-dedup-016 护栏）—— 改动生产代码，需批准；
2. 放宽 p1-dedup-016 护栏（改 `v8 ignore` 白名单）—— 削弱既有安全护栏，需批准；
3. 接受 statements 天花板 99.58%（= (74249-310)/74249）。

### lib/novel/mechanical-slop-core.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 264 | `occurrencePositions` 的 `if (!needle) return []` | 唯一调用点 L294 只喂 `TIER1_BANNED` / `TIER2_SUSPICIOUS`（两者全为字面中文词，实测 `""` 出现 0 次）或 `[]`（循环体不执行） |
| 282 | `regexOccurrencePositions` 的 `if (m.index === re.lastIndex) re.lastIndex++` | 唯一调用点 L295 只喂 `TIER3_FILLER`，该数组每条正则都含至少一个字面字符，无法匹配空串，故零宽推进永不触发 |
| 413 | `if (RAW_COUNT_FALLBACK)` 分支内的 `penalty = ...` | `RAW_COUNT_FALLBACK` 是 `export const ... = false`（L165）**编译期常量**，全仓无 spec / 运行时消费者可改写；保留是刻意的 A/B 回退与发版降级开关 |

### lib/novel/outline-model-parse.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 291 | `mergeList` 的 `if (!trimmed) continue` | 两侧输入都不含空串：`next` 来自 `collectListItems`（L198/L201 与 `splitInlineList` 均 `.filter(Boolean)`）；`existing` 只可能来自 `[]` 初值（L240-243）、`readStringArray`（`.filter(Boolean)`）或上一次 `mergeList` 结果。`fm.outline_model` 的 JSON 路径运行时不可达（frontmatter normalize 恒 stringify 化，spec 已钉死该守卫） |
| 380 | `clamp01` 的 `if (!Number.isFinite(value)) return 0` | 模块私有，仅 3 个调用点（L396/L397/L405）；`chapterCount` 经 `Math.max(...,1)` ≥ 1，两个分子是计数且被分母上界约束 → 实参恒有限 |
| 609 | `isVolumeTitleContinuation` 的 `VOLUME_HEADING_RE \|\| CHAPTER_HEADING_RE` 检查 | **被上游遮蔽**：唯一调用点 L674 的行在到达前已被 L644 `VOLUME_HEADING_RE.exec` / L653 `CHAPTER_HEADING_RE.exec` 分支命中并 `continue`（两分支已消费所有卷/章 heading） |
| 615 | `isVolumeTitleContinuation` 的 `INLINE_SECTION_RE` 检查 | **被同函数上方遮蔽**：L612 的 `/^\*\*.+\*\*\s*[:：]/` 无 `$` 锚点，匹配范围严格包含 `INLINE_SECTION_RE` 的同一前缀，能走到 L615 的行必已在 L612 `return false` |

### components/dashboard/doctor-panel.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 69 | `run` 的 `if (!projectPath) return` | 两个调用点都已前提阻断：挂载 effect 有独立 `if (!projectPath) return` 先判；刷新按钮 `disabled={running \|\| !projectPath}`。无项目时页面只渲染空态提示 |
| 85 | `heal` 的 `if (!projectPath \|\| healing) return` | 三个调用点（FTS / 向量压缩 / 向量对账按钮）全部 `disabled={!projectPath \|\| healing !== null}`，两个析取项都被 disabled 属性提前挡住 |

### components/canon-editor/canon-revision-viewer.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 160 | `if (b == null \|\| !revs.includes(b)) b = revs[revs.length - 1]` | **已补测**：B 下拉选空项（`onChange` 把 `""` 映射为 `null`）→ clamp 回退最大 revision |
| 162 | `if (a != null && !revs.includes(a)) a = null` | `revA` 非空时必属于 `revs`。两个来源：(a) A 下拉，选项恰为 `revs` 且 `onChange` 把 `""` 映射为 `null`；(b) `diffLoad` 用与 `setAllEdges` 同一份 `e` 算出的 `distinctRecordedRevisions`。无路径能在不重置 `revA` 的前提下改变 `revs` |

### components/novel/character-workstation-view.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 111 | `handleDraft` 的 `if (!activeCharacter) return` | **渲染前提**：`effectiveActiveId` 在 `characters` 非空时必回退 `firstId`（L100-101），故 `activeCharacter` 非空；`characters` 为空时既不渲染 textarea（L320）也无草稿编辑入口，`onDraftChange` 无从触发 |
| 201 | `moveFocus` 的 `else if (currentIdx < 0)` | **已补测**：受控传入未知 `activeCharacterId` 时 `activeId` 仍是该未知 id（`effectiveActiveId` 才回退），`tabs.findIndex` 为 -1 → 走该分支 |

### components/gate/ConfirmGateDialog.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 92 | `settle` 的 `if (!pending \|\| busy) return` | **已补测**：busy 中越过 deadline，自动裁决 effect（无 busy 判断）调 `settle(false)`，被 busy 守卫拦下 |
| 135 | Tab 陷阱的 `if (focusables.length === 0) return` | `focusables` 恒非空：对话框无条件渲染 `<details><summary>diff</summary>`（L227-228），`summary` 在 L133 的 focusable 选择器里且没有 `disabled` 属性——即使 busy 时所有按钮 disabled，summary 仍可聚焦 |

### lib/novel/task-router.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 532-533 | `第二章` / `第三章` 的 `return 2` / `return 3` | **被上游同义正则遮蔽**：L524 的 `/第\s*([123一二三两])\s*章/g` 是 `/第二章\|第\s*二\s*章/` 与 `/第三章\|第\s*三\s*章/` 的超集，用同一个 `isNegatedBefore` 逐处判否定，并在首个非否定匹配处 `return`。故 L532/L533 的模式若存在非否定匹配，L524 早已返回；能走到这里的第二章/第三章必然全被否定，条件恒 false（实测 `if` 条件覆盖 29 次、`return` 表达式 0 次） |
| 549 | `if (!raw) continue` | `CHAPTER_NUMBER_PATTERNS` 的 4 个模式全部带且仅带一个捕获组，量词均为 `+`（`\d+` 或中文数字字符类 `+`），故 `match[1]` 恒为非空字符串 |

### components/novel/diagnostics-center.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 510 | `handleRecover` 的 `if (!report \|\| recovering) return` | **渲染前提**：wrapper 在 `!report` 时提前返回 loading 态（L578-583），内层组件不挂载；`recovering` 侧被恢复按钮 `disabled={recovering !== null}`（L168）提前挡住 |
| 536 | `handlePreviewBundle` 的 `if (!report \|\| !projectPath) return` | **渲染前提**：wrapper 在 `!projectPath`（L569）与 `!report`（L578）时各自提前返回，按钮在两种情况下都不存在 |
| 555 | `handleExportBundle` 的 `if (!bundlePreview) return` | **渲染前提**：导出按钮位于 `{!preview ? … : …}` 的 else 分支内（L301 起），只有 `bundlePreview` 非空时才渲染 |

### components/gate/GateHost.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 62 | `handleResume` 的 `if (!haltRequestId) return` | `handleResume` 只经 `onResume={haltRequestId ? handleResume : undefined}`（L80）下传，`haltRequestId` 为 null 时根本不会传入 |


### components/novel/backup-export-view.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 491 | `handleCancel` 的 `if (isCancelling) return` | 唯一调用点是取消按钮，该按钮 `disabled={isCancelling}`（L595），`isCancelling` 为真时点击不触发 |


### components/skills/SkillPackPanel.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 90 | `exportWarningText` 的 `stripped_tool_fields` / `stripped_pack_fields` 分支 | 两个 code 在本组件里无法产生：组件固定调用 `buildPack(skills, { name, version })`（L68-75）不传 `tools`，而 `stripped_tool_fields` 只在 `options.tools` 非空且含凭据类键时产生；`stripped_pack_fields` 需 `stripCredentialKeys(pack)` 命中凭据类键名，但 pack 键固定为 schemaVersion/kind/name/version/author/tools/prompts/trustLevel，均不含 CREDENTIAL_KEY_PARTS 任一片段。故只会收到 `stripped_prompt_lines` |

### lib/agent/tool-call-parser.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 30 | `extractJsonCandidates` 的 `if (!trimmed) return []` | 唯一调用点是 `parseTextToolCalls`（L157），后者在 L152 已有 `if (!text.trim() \|\| ...)` 早退，传进来的 text 必然非空白 |

### components/novel/creative-hub-view.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 80 | `findingTone` 的 `return "neutral"` | 唯一调用点（L325）位于 `problems.map` 内，`problems` 在 L219 已把 findings 过滤为 `severity === "error" \|\| "warn"`，故 severity 只可能是 error/warn |

### components/novel/market-radar-view.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 77 | `.catch(() => { if (!cancelled) setSnapshot(null) })` | `loadMarketRadarSnapshot`（L46-53）是占位实现，无条件 `return` 字面量对象、不读盘不抛错，其 Promise 永不 reject |
| 118-132 | 榜单分支（`signals.map` → `<li>`） | 同一占位实现恒返回 `connected:false` 且 `signals:[]`，L117 的 `snapshot.connected && snapshot.signals.length > 0` 永不为真（块级 start/stop 标注） |

### lib/graph-relevance.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 161 | `resolveNodeTitle` 的 `if (headingMatch) return headingMatch[1].trim()` | 调用方 `parseFrontmatter`（L115-118）已用**完全相同的正则** `/^#\s+(.+)$/m` 在**同一个 content** 上预算过标题：H1 存在时 `fm.title` 必非空、L159 已早退；无 H1 时 `headingMatch` 必为 null。两条路径都到不了该分支 |

### lib/novel/closure-projection.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 317 | `loadNarrativeState(pp).catch(() => null)` | `loadNarrativeState`（narrative-state.ts L193）转调 `createAtomicJsonStore(...).load()`；该 store 未覆写默认值，而默认是 `onMissing="empty"`、`onCorrupt="empty"`、`isMissingError=()=>true`（projection-store.ts L106-108），读错误与解析错误一律返回空 store 不抛 |
| 318 | `loadTimeline(pp).catch(() => null)` | `loadTimeline`（timeline.ts L45-53）自带 try/catch，读盘失败与 JSON 解析失败全部吞掉并恒返回空 `TimelineFile`，Promise 永不 reject |

### lib/novel/volume.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 156-159 | `allocateVolumeArc` 的 `if (cursor <= chapterRangeEnd && result.length > 0)` 兜底 | 代数不可达：前三段 `floor(total*ratio/sum) ≥ 0`，第四段 = `total - 前三段`。若第四段 ≥ 0 则四段之和恰为 `total`，`cursor = start + total = end + 1`；若第四段 < 0 则被 `Math.max(…, 0)` 夹成 0，前三段之和 > `total`，`cursor > end + 1`。两种情形 `cursor <= chapterRangeEnd` 恒 false |

### components/novel/followup-center-view.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 69 | `gateLabel` 的 `return gate` 兜底 | 唯一调用点（L220）位于 `snapshot.blocked` 守卫内；`blocked` 定义为 `blockingGate !== null`（dashboard-evidence.ts L226），`blockingGate` 由 `GATE_PRIORITY_ORDER.find` 产出，而 `GateKey` 恰为 `consistency \| anti_ai \| quality`（audit-taxonomy.ts L78）——三个分支已全覆盖 |

### lib/agent/config.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 83 | `modelSupportsTools` 的 `if (!apiModeSupportsTools(apiMode)) return false` | `apiModeSupportsTools`（L66-75）对 `undefined`/`chat_completions`/`responses`/`anthropic_messages` 四种取值全部返回 true，而 `apiMode` 的静态类型恰是后三种 + `undefined`，故该早退不可达 |

### lib/lint.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 104 | 页面装载的 `catch { logger.warn(...) }` | 第二道防线：读盘失败已在同函数上方 L94-97 由 `!read.ok` 处理并 `continue`，进入 try 体后只剩 `extractWikilinks`/`getRelativePath` 这类对字符串不会抛的操作 |
| 370 | 摘要装载的 `catch { logger.warn(...) }` | 同上：L360-363 的 `!read.ok` 已处理读失败，try 体内只剩 `slice`/`getRelativePath` |

### lib/chat-request-budget.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 157 | `trimSystemMessagePreservingCachedBlocks` 的 `if (target >= mutableChars) return null` | 唯一调用点（L289）传入的 `excess = totalLength(next) - maxChars`，而循环条件（L274）保证 `totalLength(next) > maxChars`，故 `excess >= 1`，`target = mutableChars - excess` 恒 < `mutableChars` |
| 293 | Pass 3 的 `if (isLeadingSystemMessage(next, i)) continue` | 到达该行时 `current.role` 必非 `system`（L288 已 `continue`）；而 `isLeadingSystemMessage`（L97-105）首条判据就是 `messages[index]?.role === "system"`，故恒 false |


### components/novel/data-manager-view.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 110, 142 | `doClearDomain` / `doResetAll` 的 `if (!projectPath) return` | 渲染前提：L207 的 `if (!projectPath)` 早退整块空态，`projectPath` 为空时清空域/整项目重置按钮根本不渲染，两个 handler 无从触发 |


### components/novel/pipeline-motion-view.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 84 | `tick` 开头的 `if (cancelled) return` | `tick` 的唯一来源是 L113 的 `setTimeout` 与 L117 的首次调用；前者在 cleanup（L120）被 `clearTimeout`，后者在挂载时 `cancelled` 必为 false。定时器回调开始执行时 cleanup 尚未跑，`cancelled` 仍为 false |
| 112 | 排下一轮前的 `if (cancelled) return` | `cancelled` 只可能在 await 期间被 cleanup 置真，而 await 之后的 L90/L100 已先行 return；从 L90 到 L112 之间无任何 await，`cancelled` 不会变化 |

### lib/novel/deep-chapter-review.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 198-199 | `switch (sixDimOutcome)` 的 `default: assertNeverSixDimOutcome(...)` | 编译期 exhaustiveness 断言：`SixDimOutcome` 的三个成员（success/failure/skipped）已在上面全部显式处理，`assertNever` 的参数类型是 `never`，运行期不可达 |

### lib/novel/markdown-quality-pipeline.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 237 | `if (lastMarkerIndex === undefined) return content` | 上一行已对偶数个标记早退（`markerIndices.length % 2 === 0`），到达此处时 length 必为奇数且 >= 1，末元素必然存在 |

### lib/novel/anti-ai-corpus-fs.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 19 | `resolveDefaultCorpusRoot` 的 `catch { return null }` | webview 专用兜底：Node/vitest 下 `import.meta.url` 恒为 `file://`，`fileURLToPath` 不会抛 `ERR_INVALID_URL`，只有 `tauri://` 宿主会走到 |

### lib/novel/context-engine.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 424 | `loadReferenceBindings(pp).catch(() => null)` 的回退体 | `loadReferenceBindings`（reference-binding.ts L47-51）直委 `createAtomicJsonStore.load`，后者对缺失/损坏一律降级 `emptyCtor`，从不 reject |
| 491 | `loadUserMemoryForProject(pp).catch(() => null)` 的回退体 | `loadUserMemoryForProject`（user-memory/session.ts L39-51）内部 `loadUserMemory`（store.ts L15-35）自带 try/catch，读失败/解析失败一律返回 `createDefaultStore`，从不 reject |

### lib/novel/search-strategy.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 567-568 | MMR 平票内的 `u < bestIdx` 分支体 | `unselected` 升序插入，`bestIdx` 在同一轮升序迭代中被先出现的 `u` 赋值，后续 `u` 恒 > `bestIdx`，故条件恒假（与 L554 同机制）。注：`/* v8 ignore next 2 */` 在此只覆盖一条，必须用 start/stop 块 |


### lib/novel/numeric-fact-checker.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 81 | `cnToNumber` 内 `if (v === undefined) return null` | `cnToNumber` 的唯一调用点（L140）传入 `CN_NUM_RE` 的捕获组，其字符集（一二三四五六七八九十百千万两）恰是 `CN_NUM_MAP` 的全部键 |
| 141 | `if (value === null) continue` | 同 L81：`cnToNumber` 对正则捕获组恒返回数值 |

### lib/novel/relationship-migration.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 72 | `if (!conservation.conserved) throw` | `derived` 由 `buildLibraryArtifact` 用同一 `stableStringify` 同输入算出 `contentHash`，`verifyLibraryConservation` 用同一函数重算，故 `conserved` 恒真；此处是第二道防线 |


### lib/novel/prompt-injection-auditor.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 129 | 零宽匹配防死循环 `if (m[0].length === 0) rule.re.lastIndex++` | `INJECTION_RULES` 的全部内置规则正则都以字面量或必填捕获组开头，最短匹配长度 >= 1，`exec` 不可能返回零宽匹配 |

### lib/novel/style-radar-projection.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 115 | `clampScore` 的 `if (n === null) return null` | 两个调用点都来自 `assessDimension` 及其均值；`scoreDimension` 对 `charCount <= 0` 早退、各分母用 `Math.max(1, ...)` 兜底，分值恒为有限数；且投影只在 `hasText` 时计算 |

### lib/novel/work-heatmap-projection.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 139 | `codePointCompare` 的 `if (a === b) return 0` | 两个调用源都是「stage 唯一」的集合：L280 是 `new Set` 展开、L314 是 `Map.entries()`，故 `a === b` 恒假 |
| 264 | 聚合循环内的 `if (anchor === null) break` | `inWindow`（L224-226）在 `anchorMs === null` 时直接取 `[]`，`anchor` 为 null 时循环体一次都不进 |

### components/novel/workflow-editor-view.tsx（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 148 | `.catch(() => { if (!cancelled) setSnapshot(null) })` 的 catch 体 | `loadWorkflowSnapshot`（L82-116）整体包在 try/catch 内，任何读盘/解析失败都在内部转成带 `ledgerError` 的快照返回，永不 reject；此处是第二道防线 |

### lib/novel/story-simulation/story-extractor.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 404 | `extractCharactersFromChapters` 的 `if (chapterContents.length === 0) return new Map()` | 唯一调用点（L514）外层条件已是 `chapterContents.length > 0`，此处是第二道防线 |
| 456 | `if (!Array.isArray(parsed)) return new Map()` | `jsonMatch` 由 `/\[[\s\S]*\]/` 取出，必然以 `[` 开头，合法 JSON 解析结果必为数组；非数组只可能是畸形 JSON，那会在上一行 `JSON.parse` 直接抛出 |


### lib/novel/search-adapter.ts（2026-11-06）

| 行 | 守卫 | 机制 |
|----|------|------|
| 726 | `trustLookup` 的 `if (!params.trustGrades) return undefined` | 两个调用点（L734/L735）都在 `if (params.trustFilterEnabled && params.trustGrades)` 内，`trustGrades` 必为真 |
| 767 | `if (collection === "tech") continue` | `routeByQueryIntent` 的 `collections` 按 K-11 安全不变量恒不含 `tech`（见 search-strategy.ts L147 注释），此处是出口兜底 |

### 2026-11-06 第五批（lib 长尾）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| lib/context-budget.ts:222 | `if (total === 0) return CJK_CHARS_PER_TOKEN` | 上一行 `if (!text)` 已拦下空串；非空字符串的 `for...of` 迭代次数 >= 1，`total` 恒 >= 1 |
| lib/agent/tools/outline-list-helpers.ts:25 | `scalarFrontmatterString` 的数值分支 | 唯一两个调用点传的是 `parseFrontmatter` 的 `type`/`outline_type`，YAML 解析已把标量统一成字符串 |
| lib/agent/tools/read-memory.ts:49 | `if (seen.has(entry.fileName)) return false` | `MEMORY_ALIAS_FILES` 的 7 条 `fileName` 互不相同，`matches` 不可能出现重复 |
| lib/agent/activity-trace.ts:221 | `webSourceRefsFromResults` 的 `if (!Array.isArray(value)) return []` | 两个调用点（L201/L209）都被 `Array.isArray` 守卫，非数组入参不可达 |
| lib/agent/capability-retrieval.ts:231 | `if (!doc) continue` | `ranked` 来自 `rankByBm25(query, index)`，`index` 与 `docById` 同源同序构建，`ranked` 的 id 必然在 `docById` 中 |
| lib/cache-hit-harness.ts:129 | `cjkText` 的 `if (targetChars <= 0) return ""` | 全部调用点传的是字面量 600/900/1500 或 `runCacheHitHarness` 内固定正数（userCharsPerRound=120、assistantCharsPerRound=640） |

### 2026-11-06 第六批（lib 长尾续）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| lib/novel/anti-ai-telemetry-sink.ts:226 | 默认 deps 的 `readFile: async () => ""` | `TelemetrySinkDeps.readFile` 只在 L90 声明，全文件无任何调用点，默认实现是死代码 |

### 2026-11-06 第七批（novel 长尾）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| lib/novel/chapter-typography.ts:85 | `if (value === undefined) return null` | L66 正则已把 `raw` 限制在 `[0-9零〇一二两三四五六七八九十百千]`，纯数字在 L67 提前返回，剩余字符必在 `CNY_DIGITS` 中 |
| lib/novel/curation-gate.ts:139 | `isEmpty` 的兜底 `return false` | 唯一调用点 L156 的 entry 先过 `CURATION_BATCH_SCHEMA.safeParse`，必填字段类型被契约限制为 `string \| string[]` |
| lib/novel/chapter-ingest-utils.ts:36 | `if (typeof v === "number" ...) return v` | `parseFrontmatter` 的 `normalize` 用 `stringifyScalar` 把所有标量转成 string（frontmatter.ts L174-190），`v` 恒为 string |
| lib/novel/de-ai-selfcheck.ts:84 | `if (mean === 0) return 0.5` | `paragraphs` 已先过滤 `length > 0` 且要求 >= 3 段，每段长度 >= 1，`mean` 恒 > 0 |

### 2026-11-06 第八批（protocol/守卫型兜底）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| lib/novel/de-ai-adapter.ts:412 | `if (!Array.isArray(parsed)) ...` | `jsonText` 来自 `extractReviewRewriteJsonArray`（review-rewrite-plan.ts L173-178），必以 `[` 开头、`]` 结尾，合法 JSON 解析结果必为数组 |
| lib/novel/de-ai-preserve-lock.ts:87 | `if (m.index === r.lastIndex) r.lastIndex++` | `collectMatches` 的三个正则（URL_RE/NUMBER_RE/QUOTE_RE）都要求至少一个字符，零长度匹配不存在 |
| lib/novel/director-followup.ts:119 | `if (current === undefined) break` | 外层 `while (queued.length > 0)` 保证 `shift()` 必返回元素 |
| lib/novel/context-engine-prompt.ts:245 | `if (!config) return ""` | `canonRules` 是 `FIELD_CONFIGS` 的静态成员（同文件 L105），`find` 恒命中 |
| lib/novel/context-engine-technique-sources.ts:151 | `if (next === undefined) return blocks` | `idx` 在上一行被夹到 `[0, remaining.length-1]`，`remaining[idx]` 恒存在 |

### 2026-11-06 第九批（守卫/回退面）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| lib/novel/canon-revision-diff.ts:171-172 | `...invalidated.map(...)` 的 map 回调 | `invalidated` 在上一行被显式置为本波恒空（同段注释记录 limitation），回调不可达（`v8 ignore start/stop` 块） |
| lib/novel/director-auto-advance.ts:297 | `loadStageArtifacts(...).catch(...)` | `loadStageArtifacts`（同文件 L53-60）自带 try/catch 恒返回对象，永不 reject；此处是第二道防线 |

### 2026-11-06 第十批（协议/桩）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| lib/novel/outline-next-step.ts:114 | `if (!payload \|\| typeof payload !== "object" \|\| Array.isArray(payload)) return null` | `payload` 来自 `JSON.parse(extractJsonObject(...))`，`extractJsonObject` 必以 `{` 开头、`}` 结尾，解析成功即普通对象 |
| lib/novel/main-control.ts:377-378 | `getSkillConfig: () => null` / `getChatConversations: () => []` | 白名单 12 项不含 `read_chat_history`/`apply_skill`，两桩无工具实例调用（`v8 ignore start/stop` 块，修 L376 单行 `ignore next` 只吃一条的记账问题） |

### 2026-11-06 第十一批（quality / 工具面）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| lib/token-estimator.ts:207 | `if (tokens <= 0) return maxTokens` | 上一行 `if (chars === 0)` 已拦下空内容，`chars > 0` 时 `estimateMessagesTokens` 必返回正数 |

### 2026-11-06 第十二批（协议分支）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| lib/novel/outline-result-protocol.ts:144 | `if (!contentMarkdown) return { ok: false, error: parsed.error }` | L130 的 `if (!text.trim())` 已拦下空文本，L143 的 `contentMarkdown = text.trim()` 与它同源，恒非空 |

### 2026-11-06 第十三批（组件渲染前提 + 穷尽性 default）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| components/briefing/BriefingPanel.tsx:142 | `if (!onWritePatch) return;` | 触发按钮同条件禁用在 L139（`disabled={!patchOptIn \|\| !onWritePatch \|\| patchState === "busy"}`） |
| components/canon-editor/canon-editor.tsx:412 | `if (!selected \|\| saving) return` | 保存按钮 `disabled={saving \|\| !correctionDirty}`（L786），而 `correctionDirty` 在 `!selected` 时恒 false（L351 早退）；两分支都被渲染前提挡住 |
| components/dashboard/capability-replay-drawer.tsx:20 | `if (!projectPath) return` | 触发按钮 `disabled={!projectPath}`（L40），`load` 不可能在无 projectPath 时被调用 |
| components/canon-editor/canon-fact-table.tsx:77 | `default: return col` | `columnLabel` 入参类型是 `(typeof COLUMNS)[number]`，10 个成员逐一无遗漏列出，`default` 是编译期穷尽性兜底 |
| components/chat/chat-message.tsx:409 | `if (oldest === undefined) break` | 外层 `while (size > CITED_PAGE_IMAGE_CACHE_MAX)`（MAX=200 >= 0）保证进入循环时 Map 非空，`keys().next().value` 恒有值 |
| components/layout/planned-views.ts:29 | `PLANNED_VIEWS.map(...)` 的 map 回调 | `PLANNED_VIEWS` 为空表（同文件注释：WaveC 毕业后 15 个灰卡视图全部落地为真视图） |

### 2026-11-06 第十四批（确认块渲染前提）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| components/novel/cover-generate-card.tsx:33 | `if (!port \|\| !projectPath \|\| !meta) return` | 触发按钮同条件禁用（L68） |
| components/novel/main-control-gate-rerun-block.tsx:138 | `if (busyId) return` | 重跑按钮 `disabled={busyId !== null}`（L191） |
| components/novel/anti-ai-rules-view.tsx:121 | `if (!config \|\| savingId !== null) return` | config 缺失时技能列表恒空（L107）无触发按钮；savingId 非空时按钮 disabled（L233） |
| components/layout/chapter-draft-dock.tsx:81 | `if (!pending \|\| busy) return` | 确认块整体在 `{pending ? ...}` 内（L155）；`busy` 由 `disabled={busy}`（L166）挡住 |
| components/novel/main-control-draft-adopt-block.tsx:92 | `if (!pending \|\| busy) return` | 同上（确认块 L154，disabled L166） |

### 2026-11-06 第十五批（渲染守卫 + 常量非空）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| components/layout/activity-panel.tsx:29 | `if (!raw) return ""` | 两处调用点带前置守卫（L269 `{fileSyncError && ...}`、L463 `task.status === "failed" && task.error && ...`），raw 恒非空 |
| components/novel/pipeline-motion-panel.tsx:354 | `if (total === 0) return` | `demoEvents()` 恒返回 8 条（L131-144），sourceEvents 为空时 total=8、非空时 total=length>0，两分支互补 |

### 2026-11-06 第十六批（定时器/上游过滤）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| lib/user-memory-learning/learning-service.ts:152 | `if (!batch) return` | flush 只由定时器或满批触发；每次入队都 clearTimeout 旧定时器（L157），条目只被 flush 自身删除，触发的定时器必能找到条目 |
| lib/novel/skill-pack/pack-export.ts:154 | `if (cleanedPack.stripped.length > 0)` | 同一 stripCredentialKeys 已在上游 tools 循环剔除含凭据键的工具；prompts 只含 id/body；pack 其余键均不匹配 CREDENTIAL_KEY_PARTS |

### 2026-11-06 第十七批（上游过滤 + 死赋值路径）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| lib/novel/deep-chapter-decision-gates.ts:243 | `if (finding.severity !== "warning" && ...) continue` | 上游 `collectRepairIssues`（L225-229）只收 `severity === "warning"` 的 finding |
| lib/ingest-queue.ts:339-341、373-378 | `if (sweepAbortController) { sweepAbortController.abort() }` | `sweepAbortController` 全仓只有 null 初始化（L45）与置 null，无任何赋值点，sweep 中止分支为死路径 |

### 2026-11-06 第十八批（搜索必达 + 过滤后非空）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| lib/novel/diff.ts:105-107 | `if (bestD < 0) return computeLcsDiff(...)` | bestD 初值 -1，d=maxD=n+m 的内层循环必达终点（x>=n && y>=m）赋非负值，外层 `if (bestD >= 0) break` 后不可能仍为负 |
| lib/novel/story-simulation/story-framework-generator.ts:379 | `if (total <= 0) return "起"` | normalizeNodes 里 `total = list.length` 且循环条件 `i < total`，derivePhase 只在 total > 0 时被调用 |
| lib/novel/packs/shared-text-features.ts:118 | `if (mean === 0) return 0` | 两个调用方的 lengths 都经 `filter(s => s.length > 0)`，元素恒 > 0，均值不可能为 0 |

### 2026-11-06 第十九批（组件渲染前提续）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| components/novel/timeline-view.tsx:45 | `if (!project) return` | 组件在 L50 `if (!project) return null` 整体不渲染，章节行不存在即不可点 |
| components/novel/plotgrid-view.tsx:113 | `if (!project) return` | 组件在 L118 `if (!project) return null` 整体不渲染 |
| components/novel/foreshadowing-panel.tsx:134 | `if (!project) return` | 组件在 L143 `if (!project)` 走空态，章节行不存在即不可点 |
| components/chat/chat-panel.tsx:426 | `if (typeof subscribeStatusJson !== "function") return` | 静态 ESM 导入绑定，typeof 恒为 function（旧 mock 兼容护栏） |
| components/ui/status-visuals.tsx:7 | `if (!Number.isFinite(value)) return "0"` | formatMeterValue 仅被 MeterBar（L51-52）调用，实参已经过 Number.isFinite 消毒 |

### 2026-11-06 第二十批（设置页按钮同条件禁用）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| components/settings/sections/external-control-section.tsx:211 | `if (!status) return` | 复制端点按钮 `disabled={!status}`（L348） |
| components/settings/sections/vector-health-card.tsx:44 | `if (!project \|\| busy) return` | 三个触发按钮均 `disabled={!project \|\| busy !== null}`（L106/111/119/127） |
| components/settings/sections/data-management-section.tsx:142 | `if (!currentProject?.path) return` | 清理旧行按钮 `disabled={!currentProject?.path \|\| ...}`（L668 相邻） |
| components/settings/sections/llm-provider-cli-pills.tsx:375 | `if (!status?.managed) return` | 停止按钮整体在 `{status?.managed && (...)}` 内渲染（L457） |

### 2026-11-06 第二十一批（渲染前提续二）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| components/novel/story-simulation/branch-manager-panel.tsx:81 | `if (!editingId) return;` | 只挂在 L228 的 onBlur，输入框在 `{editingId === branch.id ? ...}`（L222）内渲染 |
| components/novel/story-simulation/framework-confirm-panel.tsx:83 | `if (!onSave) return;` | 保存按钮在 `{onSave && (...)}`（L234）内渲染 |
| components/novel/translation-workbench-view.tsx:70 | `if (!projectPath \|\| !port) return` | 批量按钮 `disabled={running \|\| !port \|\| !projectPath}`（L183） |
| components/settings/settings-view.tsx:680 | `if (!c) return null` | 侧栏分组是静态常量，categories 的每个 id 都在 CATEGORIES 中（当前零漂移），仅防未来表漂移 |
| components/novel/export-center-view.tsx:137 | `if (exporting !== null \|\| projectPath === "") return` | projectPath 为空走空态不渲染按钮；exporting 由 `disabled={!canExport}`（L288/297）挡住 |

### 2026-11-06 第二十二批（时序覆盖 + JSON 解析域）

| 文件:行 | 守卫 | 机制 |
|---------|------|------|
| lib/novel/narrative-state.ts:139 | `if (validFrom > storyTime) continue` | rel 与 targetDecls 都经 isTemporallyCovering（要求 validFrom <= storyTime）过滤，max(...) 必 <= storyTime；撤销回填分支又设为 storyTime |
| components/novel/character-workstation-view.tsx:111 | `if (!activeCharacter) return` | handleDraft 只经 CharacterStation 的 onDraftChange 触发，而它仅在 activeCharacter 非空时渲染（L146 三元） |
| lib/novel/story-simulation/simulation-report-agent.ts:318 | `if (typeof parsed === "string") return ...` | 该行前提是 trimmed 以 { 或 [ 开头，JSON.parse 对这类文本只产出对象/数组 |

## 附录：v8-ignore 全量清单（v2.4.9 覆盖率 100% 收口）

> 以下 155 个文件包含 `/* v8 ignore */` 注释，均经论证为「可证明不可达 / 死代码 / v8 伪分支 / 防御性回退」，符合 P15 策略（仅在可证明不可达处加注释；可达缺口补真实测试）。详细论证见上方代表性条目；同类模式（数组 `.pop() ??` 回退、内部 try/catch 使外层 catch 死亡、类型保证的 `?? fallback`、批量 setState 非函数侧等）按既有判例处理。

### 死代码模式分类（本批次判例归纳）

1. **`.split(x).pop() ?? fallback`** — `pop()` 对任意数组恒返回元素（空串输入返回 `""`），`?? fallback` 不可达。
2. **外层 `.catch(() => …)` 包裹内部 try/catch 的函数** — 被包裹函数已有内部 `try { … } catch { return … }` 全量兜底，永不 reject → 外层 catch 死亡。
3. **类型保证的 `?? fallback`** — `Record<UnionType,…>` / 已 `||` 赋值的属性 / loader 校验过的数组，查表必命中。
4. **批量 setState 的非函数侧** — 内部所有调用点均传 updater 函数，`typeof next === "function" ? next(prev) : next` 的非函数侧不可达。
5. **UI 状态门控的 falsy 侧** — `if (!open)` 在受控 Dialog `onOpenChange`（Radix 仅触发 false）、`loading ? spin : ""` 在 batched `setLoading+setError` 卸载的错误块。
6. **`throw error` 在前置 guard 之后** — SyntaxError 守卫后的 `throw error` 重抛死亡（前置已抛）。
7. **`?? 0` / `?? 1` on ensureSnapshotIdentity 保证的 revision** — revision 恒已赋值。
8. **switch default 全覆盖** — 所有 `case` 值穷举 union，default 不可达。
9. **信号/超时三元的无信号侧** — 可选 `signal` 参数缺省时走安全超时默认（零失败语义，按 P15 边界接受）。
10. **v2 适配层硬 `return null` 形成的整段死代码** — 通道下线后 `ensureWorker` 首调即置失败旗并返回 null，后续全部 `postMessage`/超时/pending 逻辑恒不可达（use-simulation-worker 判例；该残留已于 s6 整体删除，模式保留作判例）。
11. **运行时分区代码** — `import.meta.glob` 在 vitest 下恒可用，fs-walk 回退分支不执行；但该分支在 Node 脚本运行时（tsx）真实生效并加载全部 75 个 Skill，不是死代码，仅在 vitest 分区下不可达（skill-hub-seed 判例）。
12. **字面量 `null` 占位实参使纯函数守卫恒假** — 调用点传字面量 `null`，被调函数首行即 `=== null` 早退；待 TODO 接入真实来源后自然可达（campaign-runner/arc-settlement 判例）。
13. **挂载/禁用门控下的第二层防御守卫** — handler 内 `!project`/`!config` 永假，因为按钮 `disabled` 拦截点击、详情区按选中态条件渲染、配置随 projectPath 变更即清空（skill-library 两视图 / webhook-section 判例）。
14. **`new Date(string)` 的 catch 回退** — 构造器对任意输入永不抛错（非法串得 Invalid Date），`toLocaleString` 参数固定合法 → catch 不可达（simulation-report-view / interview-history-view 判例）。

### 完整文件清单（153）

- `components/chat/chat-message.tsx`
- `components/chat/chat-panel.tsx`
- `components/chat/chat-resume.ts`
- `components/chat/file-edit-preview.tsx`
- `components/dashboard/dashboard-view.tsx`
- `components/editor/file-preview.tsx`
- `components/editor/frontmatter-panel.tsx`
- `components/editor/wiki-editor.tsx`
- `components/editor/wiki-reader.tsx`
- `components/graph/graph-view.tsx`
- `components/layout/activity-panel.tsx`
- `components/layout/app-layout.tsx`
- `components/layout/book-analysis-sidebar-panel.tsx`
- ~~`components/layout/file-tree.tsx`~~（2026-10-30 UX 审计批次四 T4 已删除）
- `components/layout/knowledge-tree.tsx`
- `components/layout/preview-panel.tsx`
- `components/layout/sidebar-panel.tsx`
- `components/layout/soul-sidebar-panel.tsx`
- `components/layout/trash-panel.tsx`
- `components/lint/lint-view.tsx`
- `components/novel/book-analysis-result-viewer.tsx`
- `components/novel/book-analysis-view.tsx`
- `components/novel/story-simulation/branch-compare-view.tsx`
- `components/novel/chapter-selection-panel.tsx`
- `components/novel/character-aura-view.tsx`
- `components/novel/de-ai-skill-editor.tsx`
- `components/novel/dismantling-view.tsx`
- `components/novel/foreshadowing-panel.tsx`
- `components/novel/hooks/use-character-extraction.ts`
- `components/novel/hooks/use-library-operations.ts`
- `components/novel/memory-center-view.tsx`
- `components/novel/review-job-status-strip.tsx`
- `components/novel/snapshot-viewer.tsx`
- `components/novel/story-simulation/interview-history-view.tsx`
- `components/novel/story-simulation/simulation-report-view.tsx`
- `components/project/create-project-dialog.tsx`
- `components/review/review-center-view.tsx`
- `components/review/review-view.tsx`
- `components/search/search-view.tsx`
- `components/settings/hooks/use-batch-model-test.ts`
- `components/settings/llm-presets.ts`
- `components/settings/sections/about-section.tsx`
- `components/settings/sections/changelog-section.tsx`
- `components/settings/sections/custom-provider-cards.tsx`
- `components/settings/sections/embedding-section.tsx`
- `components/settings/sections/feedback-section.tsx`
- `components/settings/sections/llm-provider-section.tsx`
- `components/settings/sections/maintenance-section.tsx`
- `components/settings/sections/multimodal-section.tsx`
- `components/settings/sections/rerank-section.tsx`
- `components/settings/sections/saved-models-manager.tsx`
- `components/settings/sections/web-search-section.tsx`
- `components/settings/sections/webhook-section.tsx`
- `components/skill-library/writing-skill-library-view.tsx`
- `components/skill-library/writing-skill-sidebar-panel.tsx`
- `components/skills/SkillPackPanel.tsx`
- `components/sources/outline-chat-panel.tsx`
- `components/sources/outline-generator-dialog.tsx`
- `components/sources/source-sidebar.tsx`
- `lib/analytics.ts`
- `lib/agent/plugins/select-skills-plugin.ts`
- `lib/chat-copy-content.ts`
- `lib/chat-request-budget.ts`
- `lib/claude-cli-transport.ts`
- `lib/codex-cli-transport.ts`
- `lib/dashboard-issue-actions.ts`
- `lib/dedup-runner.ts`
- `lib/dedup.ts`
- `lib/diagnostics/health-check.ts`
- `lib/deep-thinking-stream.ts`
- `lib/endpoint-normalizer.ts`
- `lib/enrich-wikilinks.ts`
- `lib/extract-source-images.ts`
- `lib/file-types.ts`
- `lib/frontmatter.ts`
- `lib/graph-insights.ts`
- `lib/graph-readable.ts`
- `lib/graph-relevance.ts`
- `lib/ingest-queue.ts`
- `lib/ingest.ts`
- `lib/llm-client.ts`
- `lib/llm-providers.ts`
- `lib/novel/aura-evolution.ts`
- `lib/novel/behavior-state-machine.ts`
- `lib/novel/bindable-characters.ts`
- `lib/novel/book-analysis/six-dimension-engine.ts`
- `lib/novel/campaign-runner.ts`
- `lib/novel/ced-report.ts`
- `lib/novel/chapter-content-cleanup.ts`
- `lib/novel/chapter-edit-file.ts`
- `lib/novel/chapter-import.ts`
- `lib/novel/chapter-ingest-output.ts`
- `lib/novel/chapter-ingest.ts`
- `lib/novel/chapter-utils.ts`
- `lib/novel/character-aura-context.ts`
- `lib/novel/character-aura-document.ts`
- `lib/novel/character-aura-research.ts`
- `lib/novel/character-aura.ts`
- `lib/novel/chat-edit-mode.ts`
- `lib/novel/community-summary.ts`
- `lib/novel/context-data-sources.ts`
- `lib/novel/context-engine.ts`
- `lib/novel/de-ai-dual-pass.ts`
- `lib/novel/de-ai-rules.ts`
- `lib/novel/de-ai-skill-library.ts`
- `lib/novel/deep-chapter-generation.ts`
- `lib/novel/deep-chapter-task-brief.ts`
- `lib/novel/delete-source-memory.ts`
- `lib/novel/deterministic-continuity-engine.ts`
- `lib/novel/dimension-review-adapter.ts`
- `lib/novel/director-auto-advance.ts`
- `lib/novel/dismantling.ts`
- `lib/novel/evidence-chain.ts`
- `lib/novel/export.ts`
- `lib/novel/fact-snapshot.ts`
- `lib/novel/foreshadowing-cleanup.ts`
- `lib/novel/format-normalizer.ts`
- `lib/novel/gate-v2-scoring.ts`
- `lib/novel/graph-adapter.ts`
- `lib/novel/lint.ts`
- `lib/novel/main-control.ts`
- `lib/novel/mechanical-slop-detector.ts`
- `lib/novel/memory-center.ts`
- `lib/novel/model-resolver.ts`
- `lib/novel/novel-session-status.ts`
- `lib/novel/outline-generation.ts`
- `lib/novel/outline-import.ts`
- `lib/novel/outline-multi-agent-orchestrator.ts`
- `lib/novel/residual-campaign.ts`
- `lib/novel/review-adapter.ts`
- `lib/novel/review-scoring.ts`
- `lib/novel/scene-breakdown.ts`
- `lib/novel/search-adapter.ts`
- `lib/novel/search-strategy.ts`
- `lib/novel/skill-hub-seed.ts`
- `lib/novel/state-delta-light-check.ts`
- `lib/novel/story-simulation/simulation-engine.ts`
- `lib/novel/structure-first-rewrite.ts`
- `lib/novel/task-router.ts`
- `lib/novel/track-b-multi-objective.ts`
- `lib/path-utils.ts`
- `lib/project-file-sync.ts`
- `lib/proxy-config.ts`
- `lib/rerank-api.ts`
- `lib/review-rewrite-plan.ts`
- `lib/scheduled-import.ts`
- `lib/settings-model-list.ts`
- `lib/source-lifecycle.ts`
- `lib/source-watch-config.ts`
- `lib/sweep-reviews.ts`
- `lib/text-chunker.ts`
- `lib/web-search.ts`
- `lib/wiki-cleanup.ts`
- `lib/wiki-graph.ts`

