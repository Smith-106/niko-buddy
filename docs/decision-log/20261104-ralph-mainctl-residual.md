# 20261104 主控残余收口（ralph-mainctl-residual）

> 范围：Session `20261104-ralph-mainctl-residual`（W1 章节路由契约 / W2 runner 兜底顺序 + 计划持久化 / W3 观测与门控落盘 / W4 `writingModel` 真删 / 波 1 复核修复）。
> 代码面：
> `src/lib/novel/task-router.ts`（章节路由两处契约缺口）、
> `src/lib/agent/runner.ts`（必调工具 nudge 预算 + 「nudge 先、兜底后」顺序）、
> `src/lib/novel/confirmed-plan-store.ts` + `run-chapter-workflow.ts` + `main-control-view.tsx`（RV-03 计划持久化复用）、
> `src/lib/project-store.ts`（`normalizeNovelConfig` 白名单重建 + 废弃键一次性迁移日志）、
> `src/lib/llm/model-resolver.ts` + `deep-chapter-route-shell.ts` + `premium-execution.ts`（`writingModel` 删除波及面）、
> `src/main.tsx` + `src/stores/module-heat-store.ts` + `module-heat-persist.ts`（热力图埋点三段接线）、
> `src/lib/novel/main-control-gate-rerun.ts` + `deep-chapter-gate-evidence.ts`（重跑结论落盘与防污染）、
> `src/components/review/review-center-view.tsx`（六维雷达图接线）。
> 引用纪律：只用**符号引用**（函数 / 常量 / 字段名），不写行号（行号随实现漂移会让复核空转）。

## 一、决策条目（DEC-R1–DEC-R6 最终选择）

| 编号 | 主题 | decision_type | 最终选择 | evidence_ref |
|------|------|---------------|----------|--------------|
| DEC-R1 | 必调工具未调用时的兜底顺序 | 裁决人 | **A：nudge 先、兜底后，并给 nudge 加预算上限**。原顺序是「本轮零 toolCalls → 直接确定性兜底 → success/error 即 return」，nudge 永远被跳过；模型那一轮的散文只进 `workingMessages`、从不 `onText`，用户实际看到的是「静默确定性代跑」，与「拦截 → nudge → 重试 → 诊断」的设计意图不符。改为模型先看到 nudge、有机会在下一轮自己补上工具，仍不调才交兜底；**确定性兜底路径一条未删**。同时新增 `REQUIRED_TOOL_NUDGE_MAX = 2`：`run_chapter_workflow` 是 `executeTimeoutMs: 0` 的整章级生成，nudge 不设上限会把「必调工具永不调用」的成本从「1 轮 + 兜底」放大到「maxRounds 轮整章级生成 + 兜底」；预算用尽立刻交兜底，最坏情况固定为 1+2=3 次模型调用，与 `maxRounds` 解耦 | `runner.ts` `REQUIRED_TOOL_NUDGE_MAX` / `requiredToolNudgesUsed` / `missingRequiredToolsOnce`；`runner.spec.ts` 两条行为级断言（nudge 后成功不走兜底 / nudge 后仍失败走兜底，已验证在旧实现上会失败） |
| DEC-R2 | `writingModel` 的处置方式 | 裁决人 | **A：真删除**（既不标 `@deprecated`、也不仅在 UI 隐藏）。该字段**是活的**（`model-resolver` 的 writer / reviser 映射真实参与解析）但**没有任何生产写入口**；且删除对线上行为零变化——`deep-chapter-route-shell` 的 `configuredWriting` 只在 `routeShellMode` 为 route / authoritative 时可达，而 `resolveRouteShellMode` 生产恒返回 `legacy`，该分支不可达；`premium-execution.ts` 零生产调用方（全仓仅 spec 引用）。删除后 writer / reviser 在 `ROLE_TO_CONFIG_FIELD` 中显式为 `null`，`resolveRoleModel` 返回空串、调用方回退到会话模型——与删除前的默认「全角色单模型」等价。本决定**覆盖并升级** `20261104-mainctl-3tier-powers.md` 的 D2=C（当时判定为「不暴露的死字段」，字段本体仍在）；`model-resolver` 中那段「writingModel 没有被移除 / writer-reviser 映射是活代码」的历史注记（R11 / NF-04，DEC-03）随本任务作废并重写，否则注释与代码互相打脸 | `model-resolver.ts` `ROLE_TO_CONFIG_FIELD` / `resolveRouteShellMode`；`deep-chapter-route-shell.ts`（`configuredWriting` 已移除）；`premium-execution.ts`（`projectConfig.writingConfig: LlmConfig` 替换原先四处把模型名塞进 `provider` 的误用）；`agent-studio-projection.spec.ts` 反向探针（断言字段不得复活） |
| DEC-R3 | 真机 UAT 的执行路径 | 裁决人 | **A：逐级降级尝试**：`tauri dev` → `tauri build --no-bundle` → portable 包 → `vite` + 浏览器。前三级都被用户**已安装应用**持有的 single-instance mutex 拦住（同一 app identifier 只允许一个实例），需用户先关闭实例才能继续。**本轮实际只跑到最后一级（`vite` + 浏览器）**，全量 Tauri IPC UAT 未完成，按实况记债（DEBT-20261104-residual-02），不把未做的真机验证写成已完成 | 用户环境反馈（single-instance mutex 拦截）；`src-tauri/tauri.conf.json` `identifier`；本文「三、明确不做的范围」第 4 条 |
| DEC-R4 | RV-03「计划持久化」的语义 | 裁决人 | **A：只做「模型自带计划的持久化复用」**。产品上**不存在**「用户确认过的计划」这一实体：计划协议只活在提示词文本里（`normalizePlanBlueprint` 解析模型输出），相关 plan 类插件零生产调用，所有 store 无计划字段。因此 `confirmed-plan-store.ts` 持久化的是**模型在本章带过的计划**，**不是用户确认的计划**；落盘位置 `.novel/plans/chapter-<N>.md`，原子写读回。写点：`run-chapter-workflow.ts` 在 `normalizePlanBlueprint` 成功之后（写失败不致命，不阻断正文）；读点：`main-control-view.tsx` 在 `runMainControlAgent` 之前 `await` 读入闭包（`getPlanBlueprint` 是同步签名，必须先读后传）。计划确认 UI 属 `out_of_scope`，需产品先定义实体，见「三、明确不做」第 1 条 | `confirmed-plan-store.ts` `saveConfirmedPlan` / `loadConfirmedPlan` / `confirmedPlanPath` / `CONFIRMED_PLAN_DIR`；`confirmed-plan-store.spec.ts` |
| DEC-R5 | 旧配置键的处置与提示方式 | 裁决人 | **A：真删 + 一次性迁移日志**。`normalizeNovelConfig` 是白名单式重建，旧库里残留的 `writingModel` 键会被**静默丢弃**、用户无从得知——因此命中旧键时 `console.warn` 并计数，**只告警不阻断**（不 throw、不改返回值、不改载入流程），按作用域（项目文件路径 / 项目 ID / 全局）进程内去重，避免每次载入刷屏。检测看的是**键是否存在**（`hasOwnProperty`）而不是值——旧版本会主动落盘 `writingModel: ""`，空串同样算旧数据。告警文案明确指向替代项（按角色指定模型请用 `reviewModel`）。**不提供自动迁移**，理由见「二、BREAKING CHANGE」 | `project-store.ts` `normalizeNovelConfig` / `warnDeprecatedWritingModel` / `DEPRECATED_NOVEL_CONFIG_KEY` / `warnedDeprecatedWritingModelScopes` / `__resetWritingModelDeprecationWarningsForTest`；6 条迁移日志覆盖用例 |
| DEC-R6 | F15 的修复范围 | 裁决人 | **A：只修雷达图（「永不渲染」）**。`review-center-view.tsx` 挂载 `<ThrillDashboard />` 时不传任何 props，而该组件在 `result` 为空时渲染空态，于是六维雷达块**永不渲染**；改为从 `reviewRun.dimensionResults` 派生 `sixDimScores` 并传入。**不做**「主控复用 reviewCenter 缓存」：`dimension_results` 的形态是 `Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>`——按**维度键**分桶、不含章节键，跨章节取用会被 schema 直接阻断；要解锁得先改 `status.json` 的 schema，本波不动 | `review-center-view.tsx`（`<ThrillDashboard sixDimScores=... />`）；`thrill-dashboard.tsx`（`result` 为空即空态）；`deep-chapter-generation.ts` `dimensionResults` 类型；`review-center-view.spec.tsx` |

## 二、⚠ BREAKING CHANGE：`writingModel` 字段真删除

> 这是本 session 唯一的对外不兼容变更。发版说明、评审与升级引导必须显式列出，不得只在代码注释里留痕。

- **用户可见后果**：旧配置里的 `writingModel` 键**在载入时被静默丢弃**（`normalizeNovelConfig` 是白名单式重建，不在白名单里的键不会进入返回值）；用户**下一次保存即从磁盘上抹除**该键，不可回滚、不可撤销。
- **已给的提示**：命中旧键时打一条 `console.warn`（同一作用域进程内仅一次），内容含：被丢弃的具体值、字段已从 `NovelConfig` 删除、正文始终使用 AI 会话当前模型、如需按角色指定模型请用 `reviewModel`。
- **不提供自动迁移**，依据：
  1. 该字段**从未有 UI 写入口**（设置页与主控设置块都没有控件，主控设置块只保留一行「已移除」只读说明），落盘值绝大多数来自旧版本的默认写盘，**实际非空值极少**；
  2. 唯一可能的写入范式就是「全角色单模型」（把会话模型原样抄一份），把它迁到 `reviewModel` 等于把一个隐式等价关系固化成显式的项目级审稿模型，反而制造新的误解；
  3. 迁移需要额外的落盘点与版本探测，收益远低于风险。
- **行为不变的部分**：删除前 writer / reviser 的解析在线上即等价于「回退到会话模型」（`resolveRouteShellMode` 恒 `legacy`、`premium-execution` 零生产调用方），故**正文写作在生产路径上零变化**——变的是「配置里不再存在这个键」。
- **替代口径**：正文写作固定使用 AI 会话当前模型；需要按角色分模型时，`ROLE_TO_CONFIG_FIELD` 里仍绑定字段的三个角色（`critic` / `arbiter` / `judge`）继续读 `reviewModel`。
- **禁止复活**：`agent-studio-projection.spec.ts` 保留反向探针断言「`writingModel` 不得作为配置字段重新出现」；`project-store.ts` 只保留字符串常量 `DEPRECATED_NOVEL_CONFIG_KEY` 用于迁移告警，不保留任何字段级类型。

## 三、明确不做的范围（out of scope，勿再重复讨论）

| # | 不做的事 | 为什么现在不做 | 解锁条件 |
|---|----------|----------------|----------|
| 1 | 计划确认 UI（用户可点「按此计划写」并生成实体） | 产品上没有「用户确认过的计划」这一实体：计划协议只在提示词文本里，相关插件零生产调用，所有 store 无计划字段（DEC-R4=A） | 产品先定义计划实体与确认交互（schema + store 字段 + 协议落盘），再谈 UI |
| 2 | `dimension_results` 改按章节键分桶 | 现形态是维度键分桶（`Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>`），改键会波及 `status.json` 契约、六维聚合与首页证据看板（DEC-R6=A） | 出现「跨章节评审计分」的真实需求时，作为独立 schema 版本升级做 |
| 3 | 扩 `task-router.ts` 的否定守卫词表 | 新的交接模板（「为「第N章 X」生成本章草稿」）靠**尾部全锚定**（`\s*[。！!]?\s*$`）排除问句与元提问，已够用；再往否定词表堆词会让两套机制对同一形态各自判定、互相打架。守卫族（`hasUnnegatedPatternMatch` / `firstUnnegatedChapterNumber` / `NEGATED_OPENING_RE`）口径不动 | 出现全锚定挡不住的新误命中形态时，**先补反例**（含「加前缀孪生」）再决定是否扩表 |
| 4 | 全量 Tauri IPC UAT | 前三级启动方式被用户已安装实例的 single-instance mutex 拦住，需用户关闭实例（DEC-R3=A） | 用户关闭已安装实例后，按 `tauri dev` → `build --no-bundle` → portable 重跑 |
| 5 | v3.x 架构改造与 `reference/` 只读参考仓改动 | 本波只收口主控残余缺陷，不承担架构迁移；`reference/` 下为只读参考仓，不承接本仓口径变更 | 独立的 v3.x 迁移任务；第三方仓上游变更 |

## 四、不变量（后续改动不得绕过）

- 必调工具未调用时，**确定性兜底路径必须完整保留**：nudge 只是「先给模型一次机会」，不是替代兜底；nudge 次数不得超过 `REQUIRED_TOOL_NUDGE_MAX`。
- `writingModel` 不得复活：无字段、无 UI 控件、无默认写盘；迁移告警只走 `DEPRECATED_NOVEL_CONFIG_KEY` 一个常量。
- `normalizeNovelConfig` 的白名单重建语义不变：未知键一律丢弃，不因新增告警而放行任何键。
- 主控重跑门控只**记录**结论（`recordChapterGateEvidence`，`intent: main-control-rerun`），判定唯一真源仍是 `buildDecisionGates`；`isAuthoritativeGateRun` 过滤不得放宽——否则首页证据看板会被未采纳草稿的结论污染。
- 计划持久化只是**缓存模型自带的计划**，不构成「用户已确认」的授权，`draft-manager.ts` 的 `if (!input.confirmed) throw` 不受影响。
- `dimension_results` schema 不变；`reviewCenter` 与主控之间不新增隐式缓存共享。

## 五、债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261104-residual-01 | `nudgesUsed` 未进 `RequiredToolRunDiagnostics`（要改 `types.ts`，本轮文件所有权只覆盖 `runner.ts` / `runner.spec.ts`），诊断面板暂时看不到 nudge 次数 | 诊断面板需要展示 nudge 次数时才可观测 | 下一次 runner 诊断字段改动收口 |
| DEBT-20261104-residual-02 | 全量真机 Tauri IPC UAT 未完成（DEC-R3 只跑到 `vite` + 浏览器一级），前三级启动被已安装实例的 single-instance mutex 拦住 | 用户关闭已安装实例后可重跑 | 发布前最后一波 |
| DEBT-20261104-residual-03 | 「用户确认过的计划」实体与计划确认 UI 缺产品定义（DEC-R4=A 只能持久化模型自带计划） | 产品定义计划实体与确认交互 | 主控计划流二期 |

## 六、验证（本波次实跑 / 未跑）

- `rm -f tsconfig.tsbuildinfo && npx tsc --build --force`：**0 error TS**。波 1 起门禁固定走全量——`tsc --build` 的增量缓存曾让「0 错误」是假的（B1 教训）。
- `npx vitest run`（W1–W4 与波 1 改动相关 spec + `module-heat`）：提交时全绿，见 `8a95a3c5` / `bf325fac` / `deeeab2d` 三条提交的门禁记录。
- **未跑**：全量真机 Tauri IPC UAT（DEBT-20261104-residual-02）。
- **未测**：真实上游多模型成本测量——`REQUIRED_TOOL_NUDGE_MAX = 2` 是按「每次 nudge 都是一次整章级调用」的调用次数推算出来的上界，没有做线上成本实测。
- 补录说明：本文件是本次改动的**唯一权威留痕**。`src/lib/changelog.ts` 的条目**有意不在这里写**：该文件与版本四源同步属发版步骤（`PARALLEL-PACT` P16 单写者红线 + `scripts/bump-version.mjs` 的既定顺序：目标版本先登记在 `ENTRIES`，再同步版本源），而本次并未发版（`package.json` 仍为 `2.26.4`）。补录时曾尝试直接加一条 `2.26.5` 条目，但造成两处不一致——`changelog.spec.ts` 硬编码的头部发布链（期望以 `2.26.4` 开头）变红、`npm run consistency` 的 `version/single-source` 报「changelog 到 2.26.5 而 package 仍 2.26.4」——且本质上是**编造一个不存在的发布版本**。已整体回退，`changelog.spec.ts` 恢复 38/38。发版时必须把本文件的六条 DEC 与 BREAKING CHANGE 落成对应 `ENTRIES` 条目。

---

## 七、遗留台账清偿（20261104-ralph-residual-debt）

本节清偿上一 Session 的 4 项遗留。全部结论以真机或机械门禁为证，未测项照旧记「未测」。

### 7.1 DEBT-20261104-residual-02 —— 真机 UAT 已可做，且已通过

**原结论被推翻。** 上一轮判定「computer-use 不可用 ⇒ 5 条交互路径无法验证」，这是错的。可靠通道是：

1. 应用没有 React Router，视图切换走 zustand 的 `useWikiStore.setActiveView`；
2. **Vite dev 的 ESM 模块图与页面共享** —— `import("/src/stores/wiki-store.ts")` 拿到的就是页面正在用的那个实例。

于是可以 `setActiveView("mainControl")` 直接切视图、`import("/src/lib/novel/module-heat.ts").recordModuleHit(hit)` 直接打埋点，完全绕开「无 `data-testid` + 折叠分组」的侧边栏。通道为 WebView2 远程调试（`--remote-debugging-port=9222`）+ Playwright `connectOverCDP`，真机身份实测 `isTauri === true`、`hasInvoke === true`。

真机已通过：

| 路径 | 证据 |
|---|---|
| F12 热力图全链 | `recordModuleHit ok` → `hitsAfterEmit=2` → `flush ok` → 盘上 `.novel/telemetry/module-heat.json` 出现合法 `ModuleHit`；`hydratedFor` 为正确项目路径，证明 per-project 生效 |
| TASK-001 路由 | 6/6 符合预期，含问句→`general_chat`、陈述→`write_chapter`、`生成大纲草稿`→`outline`、中文数字章号 |
| 主控视图 | `setActiveView('mainControl')` 后 `[data-testid^="main-control"]` 命中 28 个节点 |

**仍记为未测**：主控门控重跑回读（F14/B9）与首页证据看板防污染（B3）需先有一份 `main-control-rerun` 账本记录，本轮没有构造，不做推测性声称。

### 7.2 新发现并修复：A-04 读盘侧不校验命中条目

`module-heat-persist.ts` 的 `loadHeatSnapshot` 原本只校验容器（`fileVersion === 1` 与 `Array.isArray(hits)`），不校验元素。后果链：

```
盘上一条非 ModuleHit 记录 → hydrate 并入 live store → 渲染 toHeatLog
→ moduleLabel(undefined).replace → TypeError → ErrorBoundary → 热力图视图渲染不出来且不自愈
```

`module-heat.json` 是**用户磁盘状态**，可能因历史版本、手工编辑、部分写或磁盘异常而污染，而用户没有任何线索知道该删哪个文件。

修法：读盘侧逐条过滤，仅保留 `path` 为非空 string 且 `at` 为有限 number 的记录；坏条目丢弃而非让整份快照失效。不移动 `fileVersion` 契约。回归见 `module-heat-store.spec.ts` 的两条 `A-04` 用例。

> 诚实说明：该崩溃是测试时误传字符串 `hit` 才暴露的（`record` 收的是 `ModuleHit` 对象）。所以**崩溃本身不是产品缺陷**，但**读盘侧缺校验是真问题**。被污染的用户真实项目文件已按创建时间核对（测试期间生成）并删除，恢复原状。

### 7.3 DEBT-20261104-residual-04 —— 用户拍板：接受切换，留痕 + 告知

真实项目 `C:/QM-BOOK/身体都是租的，你让我修仙？` 的 `novelConfig` 里该键为**非空真值** `deepseek/muse-spark-1.3-contributor-free`。用户选择：保留 DEC-R2=A 的真删除，但**留痕 + 告知**。

| 动作 | 落点 |
|---|---|
| 留痕 | 新增叶模块 `src/lib/discarded-writing-config-notice.ts` 承载登记表（进程内 Map），`project-store.ts` 在 `warnDeprecatedWritingModel` 里记录被丢弃的原始值。**key 契约：一律由 `noticeKeyForProject(projectPath)` 产出（归一化项目路径，无路径时落全局哨兵 `__global__`），读侧必须用同一函数** —— 第一版写侧用「项目文件 <path>」这类人类可读串当 key、读侧用裸路径查，两两不可能相等，横幅在生产环境永不渲染；人类可读作用域已降级为登记里的 `label` 字段，只用于诊断 |
| 告知 | 设置页新增 `DiscardedWritingConfigNoticeBanner`（`data-testid="novel-writing-model-discarded-notice"`），当作用域有非空丢弃值时显示原值并说明「正文现在始终使用 AI 会话当前模型」，可关闭；关闭态存 localStorage，不新增配置项 |
| 不做的 | 不重新引入可配置写作模型（不推翻 DEC-R2=A）；不为一次性提示新增 schema 字段 |

已观察到的真实丢弃值（备查）：`deepseek/muse-spark-1.3-contributor-free`（项目 `C:/QM-BOOK/身体都是租的，你让我修仙？`）。

i18n 键成对落地：`mainControl.settingsWritingModelDiscardedTitle` / `mainControl.settingsWritingModelDiscardedBody`（zh + en，`{{value}}` 插值）。

### 7.4 RVF-12 —— 消息形态不变量已约束，真实 provider 接受度仍未验证

**必须先说清边界**：真实 provider 凭据在本环境实测 `401`（同一配置在应用内手动生成同样失败），因此**没有**、也不得声称做过「真调一次」的验证。

本轮做的是可主动约束的部分 —— 把协议级不变量固化成测试（`runner.spec.ts` 的 `RVF-12` 两条用例）：

- `nudge` 的 `system` 消息内容非空（空 content 会被多家 provider 直接 400）；
- 相邻消息**不得同角色**（`system` 相邻、`user` 相邻、`assistant` 相邻都算违规）。

同时读码确认适配层已把 `role: "system"` 从会话中摘出：`llm-providers.ts` 的 `buildAnthropicBody` 走顶层 `system`（`toAnthropicSystem`）、`buildGoogleBody` 走 `systemInstruction`、OpenAI 系原位保留。**这是读码确认，不是运行时验证。**

> 上一轮曾担心「`role:"system"` 在 Anthropic 的 messages 数组里非法」——该风险在适配层已被消解。但「某家 provider 的真实服务端是否接受 nudge 这组具体措辞与轮次」仍属未验证，灰度时观察 400/协议错误。

### 7.5 changelog 条目 —— 内容已备好，插入必须随发版

**修正上一轮的一个过严判断**，同时修正本轮 analyze 的一个不可行计划：

- 本轮 analyze 原计划「用 Unreleased 段落落地」**不可行**：`changelog.spec.ts` 对 `ENTRIES[].version` 做 semver 硬校验（`split(".").map(Number)`），无版本号的条目会产出 `NaN` 比较；仓库也没有任何 draft/unreleased 机制。
- 上一轮的「整体回退」判断在方向上仍然正确：`ENTRIES` 头部与 `package.json` 属版本四源同步，由 `scripts/bump-version.mjs` 按既定顺序写入（`PARALLEL-PACT` P16 单写者红线）。

因此本轮**不修改** `src/lib/changelog.ts`，而是把**可直接粘贴的条目**备在这里，发版时按 `bump-version.mjs` 的顺序插入：

```ts
// 2.26.5（发版时填日期）：主控路由/兜底顺序/计划持久化/热力落盘/门控账本收口；BREAKING：写作模型不再可配置。
{
  version: "2.26.5",
  date: "<发版日 YYYY-MM-DD>",
  highlights: {
    en: [
      "Breaking: the writing model is no longer configurable. The writingModel field was removed from NovelConfig — body text always uses the current AI chat model. Projects whose saved config still carried a non-empty value will see that value discarded; the settings page shows the discarded value once with a dismissible per-project notice, and existing configs are never blocked from loading. Use reviewModel to pin a model for review.",
      "Fixed: task routing no longer drops the chapter number on the general-chat early exit, and the handoff template pattern is anchored at the end so questions such as 「为「第12章 旧梦」生成本章草稿吗？」 stay general chat. Chinese numerals are recognised when extracting chapter numbers.",
      "Changed: required-tool enforcement nudges the model first and only falls back to the deterministic path when the nudge budget (2) or the last round is exhausted, so a model that complies on the second attempt produces its own text instead of a silently substituted chapter.",
      "New: chapter plans are persisted to .novel/plans/chapter-<N>.md and read back on the next run; the plan source (user-supplied vs model-drafted) drives the wording of the constraint.",
      "Fixed: module heat is installed at app start and flushed by an app-level loop, so campaign-runner / incubator / director hits are no longer dropped when the heatmap view is closed. Snapshots are written atomically, hydrated per project before any overwrite, and read-side filtering now drops malformed entries instead of letting them crash the heatmap view.",
      "Fixed: gate-run conclusions are now recorded to the ledger and read back in main control. A single authority filter (isAuthoritativeGateRun) is shared by every reader, so draft runs can no longer pollute coverage, lineage or repair-cost figures, and the rerun block distinguishes this run from history.",
      "Fixed: the review radar chart is fed real six-dimension scores instead of rendering an unreachable empty branch.",
    ],
    zh: [
      "破坏性变更：写作模型不再可配置。writingModel 字段已从 NovelConfig 删除，正文始终使用 AI 会话当前模型。旧配置里仍带非空值的项目会看到该值被丢弃；设置页会就该项目显示一次被丢弃的原值并提供可关闭的通知（关闭态按项目隔离），配置载入从不因此被阻断。若需为审稿指定模型，请用 reviewModel。",
      "修复：任务路由不再在通用对话早退时丢掉章号，交接模板正则补了尾部锚定，像「为「第12章 旧梦」生成本章草稿吗？」这样的问句仍归通用对话；提取章号时也识别中文数字。",
      "变更：必调工具门控改为先 nudge 模型，只有在 nudge 预算（2 次）用尽或已到末轮时才走确定性兜底，因此第二次就配合的模型会产出自己的正文，而不是被静默替换。",
      "新增：章节计划持久化到 .novel/plans/chapter-<N>.md，并在下次运行时读回；计划来源（用户给定 vs 模型自拟）决定约束措辞的强弱。",
      "修复：模块热力在应用启动时即安装、由应用级循环落盘，热力图视图关闭时 campaign-runner / incubator / director 的埋点不再丢失；快照改为原子写、按项目先回填再覆盖写，读盘侧新增逐条过滤，坏条目不再让热力图视图崩溃。",
      "修复：门控运行结论现在落账并在主控回读。所有读端共用同一个权威过滤器（isAuthoritativeGateRun），草稿运行不再污染覆盖率、血缘率与重跑成本，重跑块也区分本次与历史。",
      "修复：审查雷达图接入真实六维分数，不再渲染一条永远走不到的空分支。",
    ],
  },
},
```


### 7.6 s3-review 复核后的修正（RV-001 … RV-011）

独立 reviewer 对 `c1a360b0` 判 `reject_until_fixed`，本轮已修：

| 项 | 缺陷 | 修法 |
|---|---|---|
| RV-001 | 新增 `src/lib/*` 模块却没跑 `gen:atlas`，`check-generated` 实测 5/6 FAIL，而提交正文写了「漂移闸全绿」 | 重新生成 `module-atlas.generated.json`，`gen:check` 恢复 6/6 PASS |
| RV-002 | 留痕写侧 key 是「项目文件 <path>」等人类可读串，读侧用裸项目路径查，两两不可能相等 ⇒ 横幅在生产环境**永不渲染**，「留痕 + 告知」两条都是空转 | key 契约统一由 `noticeKeyForProject()` 产出；写侧传真实 `projectPath`；组件 spec 不再自造 key，并新增 `project-store.spec.ts` 里走 `loadNovelConfig` 的**跨模块**用例（含分隔符/尾斜杠归一化、全局哨兵、项目间隔离、空串值） |
| RV-003 | `isUsableHit` 只校验 `path`/`at`，而视图把 `detail`/`ms` 也当 React child 渲染，一条 `detail` 为对象的记录同样把热力图打成永久崩溃 | 判据扩到 `ok` 为 boolean、`ms` 为有限 number、`detail` 为 string；新增 `module-heat-persist.spec.ts` 直测 8 条（含 `detail`/`ms` 为对象、`ok` 非布尔、容器字段原样透传） |
| RV-004 | 「相邻不得同角色」是**错误**不变量：`runner.ts` 在 `for (const tc of …)` 里 push `role:"tool"`，一轮两个 tool call 就产生相邻 tool；上一版只因脚本不产 toolCalls 才恒真，对 nudge 零判别力 | 不变量收窄为「`system` 不紧跟 `system`」；新增一条**有并行工具调用**的用例，先断言消息流里真的出现相邻 `tool`，再跑不变量 |
| RV-005 | 注释写「放在去重闸之前」实为闸之后，且两层 first-wins 叠加使该动机不成立；`__reset…` 只清 Set 不清 Map | 调用真正移到闸前并改注释说明真实理由（留痕按路径自身 first-wins，日志按 scope 去重，两件事粒度不同）；`__reset…` 同时清留痕 |
| RV-006 | 横幅读非响应式 Map，靠挂载顺序侥幸成立；关闭态单 key 跨项目共享 | 登记表加版本号 + `subscribe`，UI 用 `useSyncExternalStore`；关闭 key 改为 `<prefix>.<noticeKey>`；新增两条用例（A 项目关闭不影响 B、留痕晚于首渲染写入仍出现） |
| RV-007 | 7.5 的 changelog 备文写「设置页现在会显示被丢弃的原值」，受 RV-002 影响实际不会显示；7.3 把登记表说成 `project-store.ts` 新增 | 本节已改：文案与已实现行为一致（并补上「按项目隔离」），7.3 补 key 契约 |
| RV-008 | 声称「测的是接线本身」的 spec 根本没 import `project-store`，写侧 0 覆盖 | 见 RV-002：补 `project-store.spec.ts` 的跨模块用例，覆盖写读 key 对齐 |
| RV-009 | 提交正文报 `it.skip` 为 8 未写口径 | 口径固定（实测，两棵树一致）：**纯 `it.skip(` = 5、`describe.skip(` = 0，均与 base 相同**；另有 `it.skipIf(` = 3（条件跳过，不是新增跳过）；文本含 `it.skip` / `describe.skip` 的子串匹配总数 = 22。第一版把 8（= 5 纯 + 3 条件）标成「纯 it.skip」是标签错误 |
| RV-010 | `loadHeatSnapshot` 无直测，容器字段透传契约无断言 | 新增 `src/lib/novel/module-heat-persist.spec.ts`（8 条） |
| RV-011 | `listDiscardedWritingConfigs` 零调用方而 doc 有承诺 | 删除该函数与对应承诺，不留未接线的「供诊断」入口 |

### 7.7 第二轮独立复核后的修正（RV2-001 … RV2-006）

第二轮 reviewer 对 `01284a7d` 判 `approve_with_concerns`，确认两条 blocking 真修（并做了 8 组变异实验证明新用例不是自证），同时指出**修复的持久性仍有缺口**。本轮已修：

| 项 | 缺陷 | 修法 |
|---|---|---|
| RV2-001（high） | 3 个写侧调用点只有**文件分支**被测试钉住；变异实验证明让「项目 store 分支」或「全局回退分支」漏传 `projectPath`，整套 spec 依然全绿。而全局回退恰是**最常见生产路径**（项目从未落过 novel 配置文件时走它），一旦漏传，留痕落到 `__global__` 哨兵、横幅用真实项目路径查 ⇒ **永不渲染**，与 RV-002 同一 failure mode 且测试全绿 | 补 2 条用例各钉一个分支；并自行做变异实验验证：让 `:536` 或 `:543` 漏传，**各精确红 1 条** |
| RV2-002（medium） | 收窄后的不变量「system 不紧跟 system」**被 `runner.ts` 的真实路径打破**（reviewer 用临时探针实测复现）：assistant 的 push 是有条件的（有文本/推理/思考块才 push），而 nudge 原本无条件 push，两轮空输出就产生相邻 system | 生产代码改为 **nudge 并入尾部已有 system**（`runner.ts` 的注入点），并补一条「连续空输出、两次 nudge」用例；变异验证：把 merge 改回无条件 push，该用例**精确红** |
| RV2-003（medium） | 7.6 里 `it.skip` 口径数字标签不准 | 见上表 RV-009 行，已用实测口径重写（纯 5 / 条件 3 / 子串 22） |
| RV2-004（medium） | `noteDiscardedWritingConfig(projectPath, raw, label)` 第一与第三参同为 string，把 `(path, discarded, scope)` 误写成 `(scope, discarded, scope)` 时**类型检查不拦**、运行时静默退化成全局哨兵 —— 正是那个 blocking 缺陷本身 | 签名改为**具名对象** `{ projectPath, raw, label? }`，误传在类型上不可表达；生产点与全部 spec 调用点同步更新 |
| RV2-005（low） | 新 spec 的 mock 工厂键与真实导入名不符（写的是 `createDir`/`renameFile`/`removeFile`，实际导入 `createDirectory`/`writeFileAtomic`） | 对齐为 `readFile` / `writeFileAtomic` / `createDirectory` |
| RV2-006（low） | `detail` 与 `ms` 两个守卫共用同一条杀手用例 | 拆成两条独立用例，任一守卫被删都精确指向自己 |
