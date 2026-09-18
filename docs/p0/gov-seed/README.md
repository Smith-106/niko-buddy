# Gov-Seed 评测与影子期双臂采集（SOP）

> 关联：ADR-47（弹性口径判定式 + 失效回退）、ADR-48（decay 裁决）、P1 终评口径限定 #3（检索维机制分 → 影子期实测解锁）。

## 一、状态（2026-09-08）

- **种子 110 例已 ready**：`gov-seed-v1.jsonl`（OBL 60 / PSN 30 / VIO 20；trap P-1..P-6 各≥3），`eval-gate.spec` 钉死 `status=ready + 0 scaleViolations + verdict=PASS`，seal 固化 commit `8a019a7a`。
- **检索精度 = `BLOCKED(metric-unavailable)`**：`eval-gov-gate.mjs` 在纯 node 进程内 `retrieval_adapter_available=false`（flag 存 Tauri 应用态 useWikiStore，进程内不可翻转）→ 如实 pending，**绝不静默合成**（E-06 C-7）。
- **影子双臂（shadow arms）**：三 flag（`dualKbRoutingEnabled` / `hardInject` / `usefulnessRerank`）开/关对照报告管线已在 `eval-gov-gate.mjs` 实现；真实双臂数据待 Tauri 运行时采集。

## 二、触发时机

| 时机 | 动作 |
|---|---|
| 每次 PR / 发布 ceremony | `npm run eval:gov` → reports/judgment 落盘 `docs/p0/gov-seed/reports/` → verdict 检查 |
| P1 复评 | 三模型 sealed 复评前重跑同命令（消费最新 HEAD + 种子） |
| 影子期双臂采集解锁后 | 带 `--shadow-input <dir>` 重跑（下方 §四） |

## 三、流程

```text
种子 110（gov-seed-v1.jsonl）
  → npm run eval:gov
  → reports/judgment.json 落盘（shadow_arms: pending/collected；BLOCKED 记 retrieval_adapter_unavailable）
  → verdict：seed ready 且三判据可达 → PASS；metric-unavailable → BLOCKED(metric-unavailable)（非失败，如实）
  → IMP-06/07/08 接线后重跑同命令：pending 转实采
```

## 四、影子期双臂采集（Tauri 运行时，运行期前置）

**采集器已接入（kb-shadow-wiring，2026-09-08）**：`runKbShadowArmsIfConsented`（同意门复用 antiAiTelemetryConsent + 串行互斥 + 双臂 flag 翻转经 `runKbShadowArmRetrieval`，finally 恢复 store）→ `recordKbShadowArms` 落 `{项目}/.novel/telemetry/kb-shadow/dual-arm-*.jsonl`。**UI 触发入口**：设置→小说→「KB 影子采集（R5 双臂）」→ 开始采集（golden 34 × 双臂，coverageOf 逐臂现算）；需先开同意。接入后：

```text
npm run eval:gov -- --shadow-input <shadow-dir>
→ judgment arms.baseline/experiment 填实测（非占位），missing 记 per-arm 缺失
→ 检索维单点复评（ADR-47 判定式）
```

**ADR-47 判定式挂钩**：影子期双臂复评检索维「无已知缺陷」≡ 存量确定缺陷清零 ∧ 回归防线常驻（tsc `--build --force` / 生成器 `--check` 入 CI / 锚点符号校验 `verify-governance-anchors.mjs` / vitest 全绿）∧ 双臂对照不引入新确定缺陷。达标 → 检索维解除机制分（实测分替换）；不达标 → 按 ADR-47 弹性口径降回字面口径并**重议 95**。

**node 侧实测 harness（KB_SHADOW_HARNESS=1 门控，2026-09-09）**：

```text
KB_SHADOW_HARNESS=1 npx vitest run src/lib/novel/kb-shadow-harness.spec.ts
→ 真实码路面（routeByQueryIntent/rankByBm25/reorderByUsefulness + kb-routing-view.generated.json）
  golden 34 双臂（baseline BM25 / experiment +usefulness rerank，paired 全集合命中数不变）
→ shadow 落盘 .novel/harness-project/.novel/telemetry/kb-shadow/（与运行时目录分离，测量面不混淆）
→ 报告 .novel/telemetry/kb-shadow-harness/harness-report.json
→ npm run eval:gov -- --shadow-input .novel/harness-project/.novel/telemetry/kb-shadow
```

诚实口径：harness 实测 = channel-B 检索纯逻辑 + 真实生成视图（node/vitest 面）；channel-A（canon RRF/硬注入，invoke/Rust 层）由 Tauri 运行时影子期采集覆盖；检索机制分引用本面证据，精度分（golden 34 命中率）同面引用并标注「node 实测，未覆盖 invoke/Rust 层」。

**数据隔离注记（三视角审计 2026-09-09）**：影子 JSONL 按项目目录隔离（{项目}/.novel/telemetry/kb-shadow）；harness 落盘独立根（.novel/harness-project）；同意键为应用级（本机匿名遥测开关；**显式裁决见 docs/decision-log/20260909-consent-scope.md**：同意应用级、数据文件项目级，升级触发器已定），数据文件按项目落盘；Tauri `tauri-plugin-single-instance` 已启用（单实例，双开不产生跨项目写入串扰）；章索引/社区摘要/时序事实三缓存均按规范化 projectPath 键控 + 按项目失效。

**判别力压力臂（2026-09-09，CI 常态断言层）**：golden-34 真实面 baseline 已饱和（hitRate/top3/coverage 1.000，双臂全等只证非劣化）→ 压力臂补判别力：每查询注入 6 合成毒化干扰条目（token 密集 + 【冲突】canon_conflict 标记，**合成压力面非真实语料**），实测 rerank canon_consistency 否决语义（真实码路）：受毒化影响 22/34 例、experiment（否决毒条目）覆盖恢复 22/34、coverage 均值 delta +64.7pp；断言层（experiment ≥ baseline 恒成立 + 压力可分离 fail-loud）入 test:mocks 常态套件（零 IO，仅工件写入门控）。

**翻默认**：任一 flag 翻默认仍走 `docs/kb-flag-promotion-flow.md` 双臂证据门（ADR-48：裁决≠开启）。

## 五、Schema（双臂记录）

| 字段 | 类型 | 说明 |
|---|---|---|---|
| `ts` | ISO8601 | 采集时戳 |
| `caseId` | string | 种子 caseId（--shadow-input join 硬键） |
| `arm` | "baseline"\|"experiment" | 对照臂 |
| `flags` | {dualKbRoutingEnabled, hardInjectEnabled, usefulnessRerank} | 本臂生效 flag 状态（baseline=全关 counterfactual） |
| `query` | string | 脱敏后 query（≤200 字符） |
| `hitIds` | string[] | 命中的 canon id（检索失败为空） |
| `scaleViolation` | boolean | 是否触发 scale 违规 |
| `obligationCoverage` | number\|null | 义务覆盖（检索失败为 null；gate 将 null 解释为未测非 0 分） |
| `desensitized` | true | 脱敏硬门（未脱敏禁止落盘） |
| `status` | "ok"\|"retrieval_error" | 检索状态（错误码无自由文本） |
| `schemaVersion` | "qm-kb-shadow/1.0" | 行 schema 版本 |

脱敏：query 仅保留 caseId 关联 + 截断（≤200 字符）；不落正文内容。
