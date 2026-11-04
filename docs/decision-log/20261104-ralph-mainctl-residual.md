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
