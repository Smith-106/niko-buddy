# Niko Buddy 全局只读诊断报告（REFACTOR_AUDIT.md）

- 审计对象：`QMAI/`（niko-buddy，Tauri2 + React + TS + Rust），基线 `c1da7a60`（含四阶段重构 + 错误处理收敛，均已 push smith/master）
- 模式：**纯只读**。四路专家并行扫描（58+ 发现），未修改任何项目文件。本文件是目标明确要求的报告落盘，非代码改动。
- 排序：按“收益高、回归风险低”排序；每项含【文件路径+行号】【具体症状】【建议重构方案】【预估影响范围】。
- 已修排除（不再列入派工）：types/saved-model.ts 删除、web-search 错误模板收敛、65 处 err 文案归一、graph 定时器、chat 滚动 hook、embedding 串行改并行。
- 红线（来自第四步准则，派工时强制遵守）：Monaco 生产 Worker/静态资源路径不得随意更改；`#[tauri::command]` 函数名/参数/序列化字段锁死（只允许**加法兼容**，如 serde alias）；最小化变更；禁 `any`/`ts-ignore` 掩盖门禁。

## 一、代码冗余与重复造轮子

1. 【`src/lib/ingest.ts` 等 137 处 vs canonical `src/lib/utils.ts:18`】症状：`err instanceof Error ? err.message : String(err)` 裸写 137 命中，仅约 30 处已用 `toErrorMessage`。方案：codemod 全量替换（PAT-DC1 脱敏点保留在 canonical 内）。影响：全 src 错误文案上游归一；纯机械，回归风险极低。收益最高。
2. 【`src/lib/agent/capability-trace-store.ts:62` 私刻 `normalizePath` vs canonical `src/lib/path-utils.ts:7`】症状：私刻多 `.replace(/\/+$/,"")`，语义分叉（尾斜杠）。方案：删私刻，调 canonical＋显式去尾斜杠。影响：仅 2 调用点；消分叉 bug 源。
3. 【`src/lib/graph-node-page.ts:27` `fileNameFromLabel`、`src/lib/outline-save.ts:45` `sanitizeTitle` vs canonical `src/lib/wiki-filename.ts:34` `makeSafeFileSlug`】症状：三套非法字符类各写一遍，graph 版无截断/NFKC。方案：改为 `makeSafeFileSlug` 薄包装（保留各自 fallback 默认值）。影响：建页 3～4 调用点；统一跨平台文件名行为。
4. 【`src/lib/novel/outline-import.spec.ts:46`、`source-outline-import.spec.ts:37` 私刻 yaml 转义 vs canonical `src/lib/wiki-filename.ts:80` `yamlEscape`】症状：mock 漏 backslash 转义，单引号/backslash 用例静默失真。方案：spec 直引 canonical。影响：2 spec 文件；零生产风险。
5. 【今日戳 `new Date().toISOString().slice(0,10)` 14 处（如 `review-view.tsx:880,954`、`ingest.ts:647,1365`、`graph-node-page.ts:44`、`dedup.ts:594`）＋2 私有名（`composition-root.ts:39`、`page-merge.ts:198`）】症状：同一语义 14 拷贝。方案：新增 `todayStamp(d?)`（落 `utils.ts` 旁）并全量替换。影响：16 点；时区/可 mock 性提升。
6. 【字节→hex 7 处（`crypto.ts:51`、`fingerprint.ts:4`、`ingest-cache.ts:25` 等）＋fnv-hex 6 处（`conformal-gate.ts:33` 等）】症状：两簇同形。方案：新增 `bytesToHex`＋`fnv1aHex`（落 `crypto.ts`/`utils.ts`）。影响：约 13 点纯函数，易单测。
7. 【`localStorage.getItem` 防御式读 4 处（`backup/export.ts:24`、`crypto.ts:47`、`web-store.ts:21`、`depth-preference.ts:30`）】症状：try/SSR 守卫各写一遍。方案：新增 `safeStorageGet(key)`。影响：配置/指纹读路径；SSR 崩溃面缩小。
8. 【`String(n).padStart(2,"0")` 时间补零 4 处（`trash.ts:66`、`module-heatmap-view.tsx:63`、`backup-export-view.tsx:156`、`graph-view.tsx:970`）vs canonical `utils.ts:13` `pad()`】症状：utils 头注自认未合并。方案：后三处收敛到 `pad()`；graph hex 色值保留加注（语义不同）。影响：4 点；极低风险。
9. 【`capability-trace-store.ts` 同模块动态 `await import("@/lib/path-utils")` 3 处（`task-breakpoint.ts:62,73,90` 同文件三连）】症状：同一函数 import 三次。方案：提顶层静态 import。影响：1 文件。
10. 【`formatUpdateErrorMessage`（`update-error-message.ts:1`）vs `formatOperationError` 语义重叠，仅 `changelog-section.tsx:54,91` 2 用】症状：两入口并存。方案：前者改为后者特化包装（保留空串兜底）。影响：1 文件。
11. 【scripts `readJson/ensureDir` 散装（`sync-kb-view-to-niko-buddy.mjs:143`、`corpus-guard.mjs:12,38` 等，`readFileSync|writeFileSync|mkdirSync` 合计 406 命中）】症状：每脚本自带。方案：`scripts/lib/fs-json.mjs` 集中三函数，逐个迁移。影响：scripts 可维护性；不碰生产 bundle。
- Not found：死代码零引用抽查（8 候选）均存活；frontmatter 已收敛 `frontmatter.ts:198`；`package.json` 无多余依赖实证（全量 dep-graph 需 `madge/ts-prune` follow-up）。

## 二、结构与职责耦合（巨型文件）

1. 【`chat-panel.tsx:778,950,1735,2265`（2900 行，82 函数）】症状：`handleSend` 内联路由/深章节会话/三次 `streamChat`/打分/写盘，import 拉 40+ novel 函数。方案：下沉 `useChatSend`＋`useDeepChapterSession` 到 `chat/hooks/`，`streamChat` 收敛 `send-service.ts`。影响：仅 chat 发送/续写/深章节三路径。
2. 【✅完成 2026-10-21 `preview-panel.tsx`（1762→1604 行，-158；commit `2f32851c`）】纯层下沉 `preview-panel-helpers.ts`（165：15 纯函数＋4 常量），逐字节一致；PreviewPanel/sources-view/spec 零改动。
3. 【✅完成 2026-10-20 `review-view.tsx`（1626→1368 行，-258；commit `30829131`）】cards 下沉 `review-cards.tsx`（278：typeConfig＋2 纯函数＋PreviewDialog＋Badge＋ReviewCard），七段逐字节一致（顺序微调）；ReviewView/review-center/spec 零改动。
4. 【✅二期完成 2026-10-20 `graph-view.tsx`（2104→1119 行，-985；commit `73120ad3`）】子视图 verbatim 下沉：sigma-graph-views.tsx（337）＋document-graph-view.tsx（606）＋mindmap-views.tsx（75），三文件逐字节一致；GraphView 主体与 Hook 时序零改动，对外仅导出 GraphView 不变。累计首阶段 `52d12949`（2198→2104）。
5. 【✅完成 2026-10-21 `story-simulation-view.tsx`（2151→1505 行，-646；commit `3f7a78a8`）】debug 面板下沉 `simulation-debug-panels.tsx`（657：PROGRESS_PHASES＋Timeline/Debug/Agent 三面板），五段逐字节一致；debug.spec 白盒路径跟随（断言内容不变）。
6. 【✅完成 2026-10-20 `canon-editor.tsx`（993→799 行，-194；commit `90f8baa0`）】校正纯层下沉 `canon-correction.ts`（173，5 函数＋5 类型逐字节一致）＋`buildFilter`/`parseChapterInput` 并入 `canon-editor-client.ts`；原文件保留 re-export，对外 export 100% 不变，barrel/spec 零改动。
7. 【✅完成 2026-10-20 `writing-skill-library-view.tsx`（1200→1027 行，-173；commit `81a5d535`）】helpers 下沉 `writing-skill-helpers.ts`（35：3 纯函数）＋widgets verbatim `writing-skill-widgets.tsx`（149：OptionCheckbox＋SortableCategoryItem），两段逐字节一致；useWritingSkillConfig 留守，两导出面板/unified/spec 零改动。
8. 【✅完成 2026-10-20 `llm-provider-section.tsx`（1453→131 行，-1322；commit `6a818fd0`）】widgets 下沉 `llm-provider-widgets.tsx`（1331：PresetRow＋EndpointField＋ModelPicker＋三 CLI pill＋CursorProxy＋两导出控件），三段逐字节一致；HttpTimeoutControls/ReasoningControls 经 re-export 保底（custom-provider-cards/spec/settings-view 零改动）。
9. 【✅完成 2026-10-20 `dashboard-view.tsx`（971→889 行，-82；commit `e84df596`）】事项纯层下沉 `dashboard-items.ts`（88：3 类型＋2 label 映射＋5 函数，两段逐字节一致）；SEVERITY_CONFIG 图标配置留守，DashboardView 对外不变，review-center/spec 零改动。
10. 【✅完成 2026-10-20 `chat-message.tsx`（1205→922 行，-283；commit `dbb706a4`）】内容解析纯层下沉 `chat-message-content.ts`（291：标记/状态识别＋thinking 管线＋processContent，三段逐字节一致）；ACTION_BUTTON_BASE 留守，两组件 export 不变，spec 零改动。
11. 【✅完成 2026-10-20 `sidebar-panel.tsx`（1142→996 行，-146；commit `92e467eb`）】helpers 下沉 `sidebar-helpers.ts`（83：推断/计数/IO＋3 类型）＋子面板 verbatim `sidebar-panels.tsx`（75），五段逐字节一致；MEMORY_ICONS/USAGE_GUIDE_URL 留守，SidebarPanel 对外不变，app-layout/spec 零改动。全量门禁附带一次偶发单用例失败（连续两次复跑全绿，判 flaky）。
12. 【✅完成 2026-10-21 `knowledge-tree.tsx`（1490→1162 行，-328；commit `a2f21675`）】helpers 下沉 `knowledge-tree-helpers.tsx`（340：3 接口＋13 纯函数＋DeleteButton），四段逐字节一致；KnowledgeTree/RawSourcesSection/source-sidebar/spec 零改动。
13. 【✅完成 2026-10-21 `wiki-store.ts`（1087→468 行，-619；commit `04b5c8be`）】配置层下沉 `wiki-store-config.ts`（644：存储键＋配置类型/默认值＋readStored＋confirmDiscard），排序后 588 行与原段一致；28 外部名 re-export 保底，useWikiStore/WikiState 路径不变。
14. 【✅完成 2026-10-21 `character-aura-view.tsx`（1045→616 行，-429；commit `f1f45922`）】面板下沉 `character-aura-panels.tsx`（442：表单纯层＋AuraDetails/CustomAuraForm/Detail/Field/TextField），412 行逐字节一致；`character-aura.ts` 算法库不动。

## 三、卡顿与性能瓶颈（重点）

P0（高收益/低风险）：
1. 【`monaco-loader.ts:19-27`】Worker 与 `vs` 全走 CDN，离线/弱网白屏。方案：本地 `?worker` 构建＋`getWorker` 本地路径，CDN 仅降级；`loader.config` 全局 once。影响：Diff 预览首开与离线可用。⚠️ 落地必须遵守 Monaco 路径红线（只加 fallback，不动已调通的生产路径）。
2. 【`monaco-diff-editor.tsx:35-38`】`onDidChangeModelContent` disposable 被丢弃，model 重建不 dispose。方案：`onMount` 存 disposable 并在 unmount dispose；`editor.getModel()?.dispose()`。影响：三处复用组件内存泄漏。
3. 【`chat-store.ts:221-227`＋`chat-panel.tsx:957,1724,1743`】`appendStreamToken` 逐 token 全量对象扩散＋O(n²) 拼接。方案：store 内 32ms/1KB 批刷（rAF/setTimeout），引用稳定。影响：所有 chat 流式帧率。
4. 【`outline-chat-panel.tsx:321-323,362`】`appendToResult` 逐 token 全量替换。方案：同上 rAF 批刷。影响：大纲流式卡顿；单文件。
5. 【`story-simulation-view.tsx:1031-1043`】逐 token 全数组拷贝＋整列表重渲染。方案：rAF 节流刷 placeholder；末条独立更新。影响：访谈流；单视图。
6. 【`outline-chat-panel.tsx:639,128-135`】流式 `streamingContent` 每 token 全量 remark 解析＋`require()` 同步解析。方案：流式区 150ms 快照＋纯文本渲染，完成后再全量解析；顶层 import。影响：大纲流 CPU。
7. 【`chat-panel.tsx:1081,1139,2000,2079`】deep-thinking 每次回调全量替换。方案：与项 3 共用批刷。影响：深度长文生成。
P1（中高收益/低风险）：
8. 【`chat-message.tsx:786,794-800,750`】流式气泡全链重算（memo 挡不住 content 变）。方案：流式轻量 `<pre>` 渲染，finalize 后全量 Markdown。影响：长回答流式。
9. 【`novel-session-status.ts:2114`】`return listen(...)` 的 unlisten 未被调用方保存，切项目泄漏订阅。方案：封装返回 `UnlistenFn` 并在 cleanup 调用（照抄 chat-panel:753-768 模式）。影响：跨项目事件堆积。
10. 【`antigravity_cli.rs:56-66`、`claude_cli.rs:281-289`、`codex_cli.rs:51-59`】每 stdout chunk 即 `emit`，前端每 emit 一次 onToken。方案：后端 16–32ms 聚合刷，`emit_done` 不变。影响：三路 CLI 流 IPC 数量级下降；纯后端。
11. 【`epub_export.rs:247-261`、`docx_export.rs:158-172`】async 内同步大构建＋假进度空转。方案：`spawn_blocking`＋构建侧分片进度。影响：大书导出 UI 阻塞；签名不变。
12. 【`backup.rs:748-800,834-892`】async 内同步 zip 编解码＋`unwrap()` 可 panic 崩 worker。方案：`spawn_blocking`＋`map_err`。影响：大项目备份卡死。
13. 【`cursor_cli.rs:316,352`】async 链上同步读 rc/auth。方案：`tokio::fs` 或缓存＋TTL。影响：代理启动延迟。
14. 【`docx_export.rs:158`/`epub_export.rs:247` 参数 `chapters: Vec<NovelChapter>`】全书正文一次性过桥（数 MB 复制）。方案：落盘传路径/分批 invoke，向后兼容保留小书直传。影响：大书导出内存峰值。
15. 【`monaco-diff-editor.tsx:29-33`＋`monaco-loader.ts:25`】多实例重复 `loader.config`。方案：模块级 once 守卫＋入口调用一次。影响：loader 稳定性。
- Not found：循环内高频 invoke（除 CLI spawn/kill 配对）未见；其余 listen 均已配对 cleanup；`batch_replace.rs` 同步 fs 均在测试/同步 helper 非热路径。

## 四、类型与测试脆弱点

1. 【`proxy.rs:429,439`】`ProxyConfig` 双格式兼容靠 `allow(non_snake_case)` 掩盖。方案：Rust 加 `serde(alias)` 去 allow，TS 只用 camel。影响：仅代理配置。⚠️ 加法兼容，禁改字段名。
2. 【`commands/backup.rs:56`】全仓唯一 kebab-case 结构。方案：统一 camel＋alias 兼容旧值。影响：备份面板。
3. 【`agent_gate.rs:48,70,101`】`RebuildClass/GateActor/Decision` snake_case，前端易按 camel 误写。方案：TS 字面联合镜像＋surface-contract 断言。影响：门禁/审计链路。
4. 【`canon/types.rs:70,112,147,174,193,214`】`EdgeKind/Modality` snake，前端多 camel，直传落脏数据。方案：复用 `as_str()` 字面量＋未知值回退单测。影响：canon 读写。
5. 【`canon/search.rs:111` vs `canon/export.rs`】同一域 snake/camel 各一半。方案：search 加 alias 或统一，前端分命名空间。影响：搜索＋导出。
6. 【`mcp_remote.rs:103`】snake 载荷直连审计门，传 camel 被拒难定位。方案：请求层显式映射＋拒绝回显期望 key。影响：MCP 入库。
7. 【`claude_cli.rs:332-338`】`rename` 大小写混排。方案：抽 TS 类型＋JSON 样例单测。影响：Claude 传输。
8. 【`extract_images.rs:341-349`】camelCase 靠注释保障。方案：转 surface-contract 自动断言。影响：图片 IPC。
9. 【`epub_export.rs:64-67`】返回值隐式 camel，无 TS 契约。方案：生成接口＋快照测试。影响：EPUB 导出。
10. 【`ipc-contract.spec.ts:7,26-50`】`INVOKE_RE` 正则扫调用点，换行/嵌套即漏误报。方案：改 ts-morph/AST 提取。影响：仅测试守卫。
11. 【`chat-panel.tsx:103`】`{} as Record<string,AbortController>` 共享，多实例串话。方案：`useRef<Map>`＋清理，消 `as`。影响：停止/重发。
12. 【`chat-panel.tsx:630,908,1382`】三处关键 `Promise.all` 任一 reject 全失败。方案：`allSettled`/独立 try/catch 部分成功。影响：聊天/摄取稳定性。
13. 【`chat-panel.tsx:945,1055,1709,1991`】4×`new AbortController`＋`void Promise.all(kill)` 火忘。方案：收敛 `streamSessionGuard`，kill 加 await＋catch。影响：停止/切换竞态。
14. 【`antigravity-cli-transport.ts:30-67`】`unknown→as` 四连断言，上游加层即崩。方案：zod 窄化＋降级。影响：单文件。
15. 【`activity-trace.ts:208,220-267`】手工窄化漂移不报错。方案：辨别联合＋`parseJsonObject` 守卫。影响：轨迹渲染。
16. 【`component-test-utils.tsx:43,75,78,84`】全局垫片掩盖 DOM 缺口。方案：类型安全垫片＋`MockInstance`。影响：仅测试基建。
17. 【`chat-panel.spec.tsx`（4834 行）】巨型单测＋`any` 重灾，门禁最慢最脆。方案：按流/存储/深章节/选择拆 4 文件，抽 `mockStreamChat` 工厂。影响：门禁稳定性；零生产回归。
18. 【`App.spec.tsx:28,71-203`】17+ `vi.mock` 不用 hoisted 工厂。方案：统一 `mockImportActual`＋`vi.hoisted`。影响：App 壳测试。
19. 【`setup-i18n-mock.ts:15-16`】全局与文件级 i18n mock 叠加。方案：只留全局，删文件级重复。影响：多语言测试。
20. 【`app-updater.ts:7-8`】`Record<string,unknown>`＋`Promise<unknown>` 泄漏 10+ 调用方。方案：收窄具体类型。影响：更新弹窗。
21. 【`canon-editor.tsx:175`】`readonly unknown[]` 逃避 `ActorId` 联合。方案：复用镜像类型。影响：单 prop。
22. 【`types/wiki.ts:19`】`frontmatter: Record<string,unknown>` 无 schema。方案：结构化类型＋ingest 边界 zod。影响：摄取/合并。
- Not found：非测试文件显式 `any` 已清零；`vi.mock` 缺 hoisted 暂无 failing 实证；`useFakeTimers` 全仓无使用。

## 五、派工建议顺序（S2/S3）

1. S2 首批（卡顿，每次一模块）：三 P0-2（monaco dispose）→ P0-9（listen 泄漏）→ P0-3（流式批刷）→ P0-10（后端聚合刷）。
2. S3 首批（冗余解耦）：一-1（137 处 codemod）→ 一-5（今日戳）→ 二-6（二-4 的纯函数下沉先行）→ 二-4（graph 拆分）。
3. Rust 改动（P1-10/11/12/13、四-1～9）每次必跑 `cargo fmt --check`＋`cargo check`；其余每次必跑 typecheck＋vitest。

## 六、活账本维护约定

本文件是活账本，不必一次性清完：平时每开发完一个新特性、有多余 Token 时，顺手从上文挑 2 个低风险项消掉，并在对应条目注明 commit 与行数对比。
