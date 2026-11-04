# 20261104 主控三档权能补全（mainctl-3tier-powers）

> 范围：Session `20261104-ralph-mainctl-complete`（G1 配置 / G2 采纳·门控重跑 / G3 观测 / G4 三档权能核查）。
> 代码面：
> `src/lib/novel/main-control.ts`（主控 Agent 编排 + `MainControlResult.activities` 通道）、
> `src/lib/novel/main-control-settings.ts` + `novel-config-persist.ts`（G1 配置视图与唯一落盘入口）、
> `src/lib/novel/accept-draft-with-ingest.ts` + `main-control-draft-actions.ts`（G2 采纳 + 记忆回填）、
> `src/lib/novel/chapter-gate-evaluation.ts` + `main-control-gate-rerun.ts`（G2 门控重跑，判定仍归 `deep-chapter-decision-gates.ts`）、
> `src/lib/novel/main-control-trace.ts`（G3 快照投影）、
> `src/lib/novel/chapter-title-generator.ts` + `deep-chapter-prompts.ts`（G3 标题生成真接线）、
> `src/lib/agent/tools/run-chapter-workflow.ts`（G3 阶段产出 / 共识轨迹发射点）、
> `src/components/novel/main-control-view.tsx` + `main-control-draft-adopt-block.tsx`（面板消费）。
> 引用纪律：只用**符号引用**（函数 / 常量 / 字段名），不写行号（行号随实现漂移会让复核空转）。

## 一、决策条目（D1–D5 最终选择）

| 编号 | 主题 | decision_type | 最终选择 | evidence_ref |
|------|------|---------------|----------|--------------|
| D1 | `aiWorkflowMode` 的归属 | 裁决人 | **落 project-store 全局单键**，范式同 `saveOutputLanguage`：`project-store` 读写 + `wiki-store` 字段 + `composition-root` 打开项目时载入。理由：工作流强度不是「单次运行参数」，而是项目级偏好；放主控局部 state 会让「设置页改了、主控没变」重演。主控内 `MainControlSettingsBlock` 与设置页共用同一份配置（同一 `persistNovelConfigPatch` 写入口），不做第二套真源 | `main-control-settings.ts` `projectMainControlSettings` / `clampChapterTargetChars`；`novel-config-persist.ts` `persistNovelConfigPatch`；`settings/sections/novel-base-settings-section.tsx` |
| D2 | `writingModel` 是否暴露 | 裁决人 | **C：不暴露（死字段）**。`model-resolver.ts` 的写作分支返回空串并注释「写作模型已移除」，写作链路根本不读它；暴露成可改控件等于造一个「改了没用」的假真源（与「不写假数据」冲突）。主控设置块只显示 `settingsWritingModelRemoved` 一行说明（写作始终用 AI 会话当前模型），不放控件、不落盘、不参与 `MainControlSettingsView` | `main-control-settings.ts` `MainControlSettingsView`（无 writingModel 字段）；`src/i18n/{zh,en}.json` `mainControl.settingsWritingModelRemoved` |
| D3 | `preWriteGateMode` 在主控的地位 | 裁决人 | **可配置但不在此执法**：写前门控的执法点是正式库写入（canon 双写 / 批量替换），主控只写草稿不经过它。控件旁必须写明「生效于正式库写入；主控草稿阶段不拦」，避免用户以为主控内改完立刻生效 | `main-control-settings.ts` `MainControlPreWriteGateMode`；`canon-dual-write.ts`；i18n `mainControl.settingsPreWriteGateModeHint` |
| D4 | 重跑门控的上下文来源 | 裁决人 | **C：优先复用本次运行的 contextPack，缺失则 `buildContextPack` 现场构建**（并提示耗时）。判定零复制：`evaluateChapterGates` 只做「取内容 → 调 `buildDecisionGates` → 映射 pass/fail/skipped」薄编排，不复制任何 severity/verdict 规则；未评估的维度/门落 `skipped` 而非 `pass`（`UNASSESSED_DIMENSION_CHAPTER_CONTRACT` / `UNASSESSED_DIMENSION_AI_REVIEW`） | `chapter-gate-evaluation.ts` `evaluateChapterGates` / `emptyDecisionGates`；`deep-chapter-decision-gates.ts` `buildDecisionGates`（唯一真源）；`deep-chapter-gate-evidence.ts` `mapDecisionGateToRunStatus` |
| D5 | 四项观测的承载方式 | 裁决人 | **A：新增 `MainControlResult.activities` 独立通道**，不伪造 `MainControlStep`（否则污染 `steps` / toolCalls 语义与热力图统计）。快照侧 `buildTraceSnapshot` 增 `activities` 投影（只留 kind/title/summary/at，content 截断 240 字，R-08 体积纪律），`fileVersion: 2` 且读取端仍接受 v1 旧快照 | `main-control.ts` `MainControlResult.activities`；`main-control-trace.ts` `MainControlTraceSnapshot` / `MainControlTraceActivity` / `buildTraceSnapshot` |

## 二、G3 观测通道的落地口径（四项 → 同一通道）

D5=A 的通道建立后，四项观测都必须有**真实生产发射点**，不得只留「类型可用」：

| 观测项 | 发射点（生产） | 事件类别 | 备注 |
|--------|----------------|----------|------|
| 深章阶段产出 | `run-chapter-workflow.ts` `onThinking` → `onActivityEvent` | `stage_output` | 内容截断 240 字，与 trace 同口径 |
| 共识写作 | `run-chapter-workflow.ts` 第 5 参 `onConsensusTrace` → `onActivityEvent` | `analysis` | 只搬运 `ConsensusTrace`（席位/互评轮次/胜出稿/失败席位），胜者仍由 `consensus-aggregate` 定 |
| 记忆回填 | `main-control-draft-adopt-block.tsx` → `buildIngestActivity` → 面板 `onActivityEvent` | `extract_result`（ok）/ `analysis`（skip）/ `error`（failed） | ingest 语义不变（顺序与降级分类仍归 `acceptDraftAndIngest`） |
| 标题生成 | `deep-chapter-generation.ts` 阶段 7.5 → `ensureChapterTitle` | 走 `onThinking`（`stage_output`） | 见第三节 |

纪律：事件标题与状态文案**一律走 i18n 键**（`mainControl.consensus*` / `mainControl.draftIngest*` / `mainControl.activityIngestTitle` / `mainControl.draftTitle*`），不得硬编码中文；面板 `ACTIVITY_KIND_LABEL_KEYS` 用固定映射表而非模板字面量拼 key（拼 key 未命中会渲染原始 key，且 i18n 前缀校验覆盖不到）。

## 三、`autoGenerateChapterTitle` 从「恒真」改为真开关（RV-001）

旧状态是双缺口：`generateChapterTitle` 零生产调用方，`autoGenerateChapterTitle` 零消费者（提示词里的标题要求恒开）。定档「修好它」而不是移除，理由是**章节名是目录/预览的可用性前提**（裸「第N章」在目录里不可分辨）。

落地口径：

1. **开关单源**：`ensureChapterTitle` 的 `autoGenerateChapterTitle` 必填且不在函数内兜默认值——在消费者里再默认成 `true` 就等于把「用户关了」重新变成恒真。
2. **只多跑一次、且可失败**：仅当「开关开 + 有章号 + 正文里没有富标题」时才调 `generateChapterTitle`；正文自带富标题时零额外调用（`source: "content"`）。
3. **失败必须降级，绝不阻断**：任何异常/空串 → `source: "fallback"`，补 `# 第N章` 后照常交付正文。标题是附加信息，不能成为正文生成的失败点。
4. **提示词同步**：`buildDeepChapterDraftPrompt` / `Revision` / `Expansion` / `FinalPolish` / `LengthRewrite` 的标题要求全部由同一开关控制（关 → 「不要输出章节标题」），否则「关了自动标题」仍会被模型自带 H1 打穿。
5. **已知边界**：`buildDeepChapterLengthRewritePrompt` 当前**零生产调用方**（全仓仅 spec 引用），因此「在调用点传参」这一条无法在本次交付；该函数已统一到同一开关名 `autoGenerateChapterTitle`，等超长正文重写阶段真正接线时按同一口径传 `novelConfig` 真值。

## 四、不变量（本波次未动，后续改动不得绕过）

- 门控判定唯一真源仍是 `buildDecisionGates`（`deep-chapter-decision-gates.ts`）；主控只编排不复制。
- `draft-manager.ts` 的 `if (!input.confirmed) throw` 不绕过：主控采纳是两步确认（第一步只解析目标 + 探占用，零写盘）。
- 主控工具白名单 13+3 不扩大：G1 配置 / G2 采纳与重跑门控都是 UI 动作 + 落盘函数，不新增 settings 工具。
- `writingModel` 不暴露为控件（D2=C）。
- Draft-first 不破：主控只写 pending 草稿，正式正文必须经 accept。

## 五、债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261104-mainctl-01 | `buildDeepChapterLengthRewritePrompt` 仍是零生产调用方（超长正文重写阶段未接线），其 `autoGenerateChapterTitle` 开关暂时只有 spec 覆盖 | 超长正文重写阶段接线时（或该函数被删除时） | 下一次深章生成链改动收口 |
| DEBT-20261104-mainctl-02 | 主控面板的观测事件为「运行内（stage_output/consensus）+ 运行后（ingest）」两段合并；运行后事件只在面板打开且当次运行存在时落快照，冷启动直接采纳不落快照 | 需要「无运行也能回放采纳」时补独立落盘 | 观测面板二期 |

## 六、验证（本波次实跑）

- `npm run typecheck`：PASS
- `npx eslint <改动文件>`：PASS（0 error / 0 warning）
- `npx vitest run`（改动相关 8 个 spec + 主控面板 spec）：PASS
- `node scripts/check-consistency.mjs`：14/14 PASS
- `node scripts/check-generated.mjs`：6/6 PASS（`module-atlas.generated.json` 已重生）
- `node scripts/check-boundaries.mjs`：5/5 PASS
