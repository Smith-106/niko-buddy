# Niko Buddy v2.36.0 Wave 1：缓存命中优化、工具收敛与新手上路（A-34 决策日志）

> **路径**：`docs/decision-log/20261128-v236-wave1-cache-onboarding.md`
> **分支与工作树**：在独占工作树 `QMAI-v236-wave1` 合流纯净 `PR #32`（CI `46130890627` **7/7 全绿**），经 `--rebase` 合入 `smith/master`（`fa175d83`），全程未触碰主仓 `QMAI/`（保留其 96 项外部 WIP），分叉工作树 `QMAI-v234-autonomy` 中的外部 WeKnora 提交已无损迁至独立分支 `feat/weknora-bridge`。

## 一、常规决策条目（Wave 1 `TASK-001`–`TASK-006`）

| date | task_id | decision_type | value | evidence_ref |
|---|---|---|---|---|
| 2026-11-28 | TASK-001 | 裁决人 | 将 `CLAUDE.md` 由 `45,489` B 精简至 `<= 20 KB`，归档历史锚点至 `docs/anchors/historical-anchors.md` 与 `docs/history/execution-view-log.md` 并在 `.gitignore` 放行；新增 `verify:fast` 编码内环脚本，保持 `typecheck:force` 与 `test:mocks` 全量门禁不变。 | `CLAUDE.md`、`package.json`、`.gitignore`、`docs/anchors/historical-anchors.md`、`docs/history/execution-view-log.md` |
| 2026-11-28 | TASK-002 | 裁决人 | 在 `toAnthropicTools` 末尾工具加注 `ephemeral` 断点并以 `clampAnthropicCacheBreakpoints` 严格限制 `<= 4` 断点；重构 `stripWireAgnosticOverrides` 为出站白名单并为 OpenAI / 合规兼容端点映射 `prompt_cache_key`；`llm-stream-parsers.ts` 新增 DeepSeek `prompt_cache_hit_tokens` 回退；`llm-request-trace.ts` 保持禁用 `antigravity-cli` 并补充隐式前缀描述器；`llm-client.ts` 导出只读 `getLlmRequestTraceSnapshot()`；新增 `LlmCacheStatsCard` 并挂载于 `LlmProviderSection`（守恒 `settings-model-categories.spec.ts`）。 | `src/lib/llm-{providers,stream-parsers,request-trace,client}.*`、`src/components/settings/llm-cache-stats-card.*`、`src/components/settings/sections/llm-provider-section.tsx` |
| 2026-11-28 | TASK-003 | 裁决人 | 在 `toOpenAITools` 与 `AgentRunner` 出站及可调用工具过滤 `category !== "virtual"`（保留 `taskContract` splice 原状以避让 WIP）；移除 `apply_skill` 动态技能名清单实现 Schema 逐字节稳定；在 `task-router.ts` 与 `main-control.ts` 落地 `read_plan`/`write_edit`/`full` 三档按字典序冻结的主控工具掩码（严格排除 `write_memory` 等禁用工具），通过 `RunMainControlOptions.intentToolMask` 经 `@/lib/novel` barrel 派生。 | `src/lib/agent/{tools-schema,runner,tools/apply-skill}.*`、`src/lib/novel/{main-control,task-router}.*`、`src/components/novel/main-control-view.*` |
| 2026-11-28 | TASK-004 | 裁决人 | 接通 `WelcomeScreen` 第 2 步配置回调与 `App.tsx` 双分支跳转；`CreateProjectDialog` 支持往返模型设置保留草稿、修正 4 步进度指示、经 `formatOperationError` 统一格式化错误，并新增零 Key「创建并打开 Antigravity (ACP)」交互路径（`landingView: "antigravityAcp"`）；在 `DirectorView` `llmBlocked` 新增 ACP CTA、在 `AutonomousIncubatorDialog` 接入 `assessLlmHealth` 前置守卫、在 `LlmProviderSection` 新增 `!project` 全局配置横幅。 | `src/App.*`、`src/components/project/{welcome-screen,create-project-dialog}.*`、`src/lib/{composition-root,format-operation-error}.*`、`src/components/novel/{director-view,autonomous-incubator-dialog}.*`、`src/components/settings/sections/llm-provider-section.*` |
| 2026-11-28 | TASK-005 | 裁决人 | 对照 `src-tauri/src/mcp_server/registry.rs` 将外部控制 4 档工具数精确校准为 `full-legacy=50`、`writer-sub=36`、`architect=28`、`reviewer=25`，UI 默认选中切换至 `writer-sub`，同步修正 `session.rs` 注释、`antigravity-acp-view.spec.tsx` 与中英双语 i18n。 | `src/components/settings/sections/external-control-section.*`、`src-tauri/src/mcp_server/session.rs`、`src/components/novel/antigravity-acp-view.spec.tsx`、`src/i18n/{zh,en}.json` |
| 2026-11-28 | Release | 用户裁决 | 用户于 `2026-11-28` 明确授权「全部同意并完成」：以 `--rebase` 合并 PR #32 并推进 `v2.36.0` 正式版本构建与 `Latest` 发布；因与当日早先发布的 `v2.35.0` 属同周/同日/30 日窗口（不同 Tag），按 `RELEASING.md` 在 `release-cadence-exemptions.json` 登记 `v2.36.0` 豁免并完整执行全套工程门禁、签名构建与更新源实测。 | `package.json`、`CHANGELOG.md`、`src/lib/changelog.ts`、`release-cadence-exemptions.json` |

## 二、推迟项说明（避让主仓 `QMAI/` 外部 WIP）

- Roadmap 1.2 中涉及 `deep-chapter-generation.ts`、`dimension-review-adapter.ts`、`deep-chapter-context-assembly.ts`、`stable-prefix.ts`、`src/lib/novel/index.ts`、`mcp-section.tsx`、`novel-section.tsx`、`wiki-store-config.ts` 的改动推迟至后续波次。
- Roadmap 1.4 中 `src/lib/agent/runner.ts` 的 `taskContract` splice 重排推迟至后续波次。
