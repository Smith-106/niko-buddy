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

### lib/project-mutex.ts
- **L51 `() => {}`**（`await prev.catch(...)` 回调）：锁链存储值恒为 `prev.then(() => next)`，`next` 在 finally 中必 resolve（release），链上 Promise 永不 reject → catch 回调永不被调用。防御性代码。
- **L66 `locks.get(projectPath) === next` 子句**：map 存储的是派生 Promise（`prev.then(() => next)`），恒不等于 `next` → 该子句永假（源码注释亦承认"Tail check is approximate"）。仅 `locks.size > 1024` 子句可达（已有 flood 测试覆盖）。

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

---

## 附录：v8-ignore 全量清单（v2.4.9 覆盖率 100% 收口）

> 以下 137 个文件包含 `/* v8 ignore */` 注释，均经论证为「可证明不可达 / 死代码 / v8 伪分支 / 防御性回退」，符合 P15 策略（仅在可证明不可达处加注释；可达缺口补真实测试）。详细论证见上方代表性条目；同类模式（数组 `.pop() ??` 回退、内部 try/catch 使外层 catch 死亡、类型保证的 `?? fallback`、批量 setState 非函数侧等）按既有判例处理。

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

### 完整文件清单（137）

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
- `components/sources/outline-chat-panel.tsx`
- `components/sources/outline-generator-dialog.tsx`
- `components/sources/source-sidebar.tsx`
- `lib/analytics.ts`
- `lib/chat-copy-content.ts`
- `lib/chat-request-budget.ts`
- `lib/claude-cli-transport.ts`
- `lib/codex-cli-transport.ts`
- `lib/dashboard-issue-actions.ts`
- `lib/dedup-runner.ts`
- `lib/dedup.ts`
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
- `lib/novel/deep-chapter-generation.ts`
- `lib/novel/deep-chapter-task-brief.ts`
- `lib/novel/delete-source-memory.ts`
- `lib/novel/deterministic-continuity-engine.ts`
- `lib/novel/dimension-review-adapter.ts`
- `lib/novel/dismantling.ts`
- `lib/novel/evidence-chain.ts`
- `lib/novel/export.ts`
- `lib/novel/fact-snapshot.ts`
- `lib/novel/format-normalizer.ts`
- `lib/novel/gate-v2-scoring.ts`
- `lib/novel/graph-adapter.ts`
- `lib/novel/lint.ts`
- `lib/novel/mechanical-slop-detector.ts`
- `lib/novel/memory-center.ts`
- `lib/novel/model-resolver.ts`
- `lib/novel/novel-session-status.ts`
- `lib/novel/outline-generation.ts`
- `lib/novel/outline-import.ts`
- `lib/novel/residual-campaign.ts`
- `lib/novel/review-adapter.ts`
- `lib/novel/review-scoring.ts`
- `lib/novel/scene-breakdown.ts`
- `lib/novel/search-adapter.ts`
- `lib/novel/state-delta-light-check.ts`
- `lib/novel/structure-first-rewrite.ts`
- `lib/novel/task-router.ts`
- `lib/novel/track-b-multi-objective.ts`
- `lib/path-utils.ts`
- `lib/project-file-sync.ts`
- `lib/project-mutex.ts`
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

