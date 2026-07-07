# QMAI — 长篇写作主基底

> 本文件是 QMAI 会话级执行纪律。详细规范见交付文档包 `@../docs/qmai-codex-delivery/`。

## 身份与边界

- **QMAI 是 niko-hub 唯一主基底**。外部项目（novel-harness / ainovel-cli / NovelForge / novel-tool / maestro-flow）只贡献**模式、契约、规则**，不做整仓迁移，不接管主程序。
- **禁止 clean-room 重写**。已有锚点能承载职责就不新开平行实现。
- 桌面架构固定 `Tauri 2 + React + Rust`；IPC 走直 invoke，不引入 Node gateway；向量存储沿用 LanceDB。

## 三条不可退让的硬约束

1. **`status.json` 是运行时唯一真源** — `.novel/status.json`，编排层与生成层共同读取、分层写入。禁止新建第二份会话状态文件替代它，禁止用临时 Markdown 清单替代状态契约。
2. **Draft-first 是写作安全边界** — 所有 AI 输出先进 pending/ready 草稿，accept 后才回填正式正文与正式记忆。accept 前禁止污染正式层。
3. **门控优先级固定** — `Consistency(P0) > Anti-AI(P1) > Quality(P2)`。Quality 不得覆盖 Consistency 的失败；机械层检测先于语义层。

## 主链文件锚点（现行）

修改前先确认目标落在哪个锚点。**只改下列已存在的文件**：

| 能力 | 锚点 |
|------|------|
| 意图路由 | `src/lib/novel/task-router.ts` |
| 上下文装配 | `src/lib/novel/context-engine.ts` + `context-data-sources.ts` |
| 章节生成 | `src/lib/novel/deep-chapter-generation.ts` + `deep-chapter-prompts.ts` |
| 草稿/会话状态 | `src/lib/novel/novel-session-status.ts` + `chapter-save-strategy.ts` |
| 审查/门控写回 | `src/lib/novel/review-adapter.ts` + `start-review-run.ts` + `start-six-dimension-review-run.ts` |
| Anti-AI | `src/lib/novel/de-ai-rules.ts` + `de-ai-adapter.ts` |
| 角色认知 | `src/lib/novel/character-cognition.ts` + `character-state.ts` |
| UI 闭环 | `src/components/chat/chat-panel.tsx` + `chat-message.tsx` + `chat-resume.ts` |

完整映射见 `@../docs/qmai-codex-delivery/10-file-mapping.md`。

## 条件性目标锚点（当前不存在，勿当现行）

`src-tauri/src/novel/status_schema.rs`、`decision_gate.rs`、`consistency_gate.rs`、`src-tauri/src/commands/status_commands.rs`、`gate_commands.rs` — 这些是 **Stage 3 目标层**，仅当 Stage 2 gap audit 证明现有 TS 主链锚点不足时才进入。当前仓库不存在它们，修改时不得冒充现行锚点，只能在文档中标记为目标。

## 修改优先顺序

1. `task-router` / `context-engine` / `deep-chapter-generation`
2. `novel-session-status` / `chapter-save-strategy` / `review-adapter`（未来补 `status_schema`/`decision_gate` 仍归此层）
3. `chat-panel` / `chat-resume`
4. 最后才补 `sidecar-client` 一类增强文件（Stage 4-5）

## 禁止做法

1. 在 `src/lib/novel/` 之外平行复制一套 novel 主链。
2. 新建第二份会话状态文件替代 `.novel/status.json`。
3. 用临时 Markdown 清单替代状态契约作为运行真源。

## 当前执行视图

按 Stage 推进（旧 Phase 仅作历史来源）：`1 Authority Realignment → 2 Release Readiness → 3 Core Stabilization → 4 High-ROI Enhancements → 5 Optional Sidecar`。当前 Stage 2 已 strict PASS（b51ab03，v2.2.24 已发布）；Stage 3 仅在暴露主链缺口时回补。详见 `@../.workflow/project.md` 与 `@../docs/qmai-codex-delivery/09-implementation-plan.md`。

## 验收与证据

- 交付验收标准见 `@../docs/qmai-codex-delivery/11-test-plan.md`，绑定写作质量目标而非仅编译通过。
- 发布证据链见 `12-acceptance-evidence-*.md`（最新 `2026-07-06-release-complete`）。
- 缺陷台账见 `15-release-defect-ledger.md`。
