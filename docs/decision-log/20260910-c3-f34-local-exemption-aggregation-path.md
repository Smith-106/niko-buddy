# 2026-09-10 — C3 两项人类决策闭合（F-34 本地默认豁免 + 书级跨项目聚合路径归属）

## 一、decision-log 条目（2 条）

### 条目 1：F-34 本地默认豁免裁决

| 字段 | 值 |
|------|------|
| date | 2026-09-10 |
| task_id | 残量 R7（exec-plan-20260908 工程收敛批次收尾残量，登记簿 consensus-todo-register-20260909 C3） |
| decision_type | U-裁决（统计口径适用性） |
| value | **本地默认形态豁免 ≥200 章遥测口径：`antiAiTelemetryConsent` 默认 off（零 IO、数据不出机、无跨项目流动）的产品形态，判为不适用「书级 ≥200 章 anti-ai 遥测」证据要求。** 理由：① F-34 产品承诺即「本地匿名 + 默认关 + 显式同意」（蓝图 T34 / 2026-09-02 b66234e1 接线），默认形态零采集是设计内行为而非缺证据；② C3 的 ≥200 章要求是**运营期数据佐证**口径（F-34 数据飞轮运营期任务，thrill-retention-correlate N≥200 复验口径），不是 Track A 发版硬门；③ 强行以「默认关 = 0/200」为阻塞，等于要求产品以违背隐私承诺的方式凑证据。生效：C3 由 DUE-BUT-BLOCKED 转 **本地豁免 · 书面留痕**，Track A anti-ai 关联以本文为书面记录落地，tag 前置链 C3 侧闭合；C3 月级时钟**不启动**（保留为可选运营项，若未来默认形态改变或聚合/外流路径上线，触发器见三）。 |
| evidence_ref | `QMAI/src/lib/novel/anti-ai-telemetry-wiring.ts`（`loadAntiAiTelemetryConsent` 应用级键默认 `?? false`）；`QMAI/src/lib/novel/anti-ai-shadow-telemetry.ts:36`（`if (!sink) return` 守卫，零 IO）；`.workflow/harvest-staging/consensus-todo-register-20260909.md` C3 行（三席 MERGED：BLOCKS-TRACK-A=YES + UNBLOCK-CMD=二决策闭合即解除）；用户裁决（ask-user-question 2026-09-10，选项 A）。 |

### 条目 2：书级跨项目聚合路径归属（双轨）

| 字段 | 值 |
|------|------|
| date | 2026-09-10 |
| task_id | 残量 R7（同上，C3 第二决策） |
| decision_type | U-xx 定稿（数据路径） |
| value | **双轨归属：原始遥测维持项目级落盘（`{projectPath}/.novel/telemetry/anti-ai/`，现状不变、不新增跨项目读取）；应用级仅存匿名派生统计（不含书稿正文/项目名等可识别信息，默认关，须显式同意 + 该派生层 schema 冻结后才上线）。** 理由：① 项目级原始与 2026-09-09 consent-scope 裁决（应用级同意键 + 项目级数据文件）一致，删除项目即删除数据；② 书级/跨项目比较确有需求（C2 判官池 κ、F-34 飞轮 N≥200 复验），纯项目级会让跨书统计永远手工；③ 应用级直存原始数据会扩大隐私面且违「数据不出机」直觉，故应用级**只存匿名派生**。边界：派生层**未上线前**，任何跨书统计 = 用户显式导出后离线合并（维持现状）；派生层上线须走本文 supersede，且其 schema 新增任何非匿名字段即触发 20260909-consent-scope.md 的粒度重裁决。 |
| evidence_ref | `QMAI/src/lib/novel/anti-ai-telemetry-wiring.ts`（sink init 以 projectPath 锚定）；`QMAI/docs/decision-log/20260909-consent-scope.md`（数据文件项目级 + 应用级键同意粒度先例与触发器）；monitoring-state.md 修正 1 衍生缺口（「跨项目汇总到书级 ≥200 章的收集路径无人定义」——本条目即该路径的归属定案）；用户裁决（ask-user-question 2026-09-10，选项 C）。 |

## 二、边界声明（防止误读）

1. **豁免 ≠ 废弃机制**：anti-ai 遥测机制（sink/shadow/consent UI/init 接线）全部保留可用；豁免仅指「默认关形态不欠 ≥200 章证据债」。
2. **豁免范围限于本地默认形态**：consent=on 的自愿采集、任何跨项目聚合、导出、共享路径不因此豁免；那些路径（如上线匿名派生层）须显式同意 + 满足 N≥200 才可宣称（`thrill-retention-correlate` 运营期复验口径）。
3. **应用级匿名派生层当前不存在**：本条目是归属定案（架构方向），不是「已上线」声明；上线前不新增任何应用级遥测数据面。
4. **Track A 关联落地方式**：anti-ai 在 Track A 的关联（Consistency(P0) > Anti-AI(P1) 优先级不变）经本文书面留痕承载（B1 前置链「豁免即 Track A 关联转书面留痕放行」条款）。

## 三、后续触发条件（非债，为升级/回滚触发器）

- 默认 consent 形态改变（默认 on / 引导开启）→ 豁免自动失效，C3 恢复 ≥200 章待证。
- 匿名派生层 schema 新增非匿名字段 → 触发 20260909-consent-scope.md 粒度重裁决 + 本文 supersede。
- 未来版本若将 anti-ai 遥测宣称为产品能力（非本地匿名诊断）→ 重开 C3 证据要求。
