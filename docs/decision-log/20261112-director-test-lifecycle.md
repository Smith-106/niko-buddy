# 2026-11-12 — DirectorView 组件测试生命周期修正（测试面：渲染根所有权 + 推进完成信号）

> task_id：S3 单件修正（run-fe6288c0ce65 / session 20261109-ralph-expert-residuals）
> status：**Proposed — 本地聚焦用例 GREEN 已实测（31/31 既有用例 + 文件级所有权守卫，exit 0，0 条 act 警告）；远端 CI 尚未在修正提交上重跑，不得据此宣称 CI 异常已修复**
> 依据：诊断发布 `agent://bb94638c-5f86-42f0-95ae-04d6b8591880`（复用，未重做诊断/基线）、`runs/run-fe6288c0ce65/work/ci-director-teardown-authority.json`（authorized_bounded_test_lifecycle_correction）
> 基线：`snapshot-baseline=69d52302167cbe83377cfc3b070ecf903a5276c9`
> 范围：**仅测试面** —— `QMAI/src/components/novel/director-view.spec.tsx` + 本文件；零运行时/产品/helper/配置/依赖改动

## 一、决策条目

| 字段 | 值 |
|------|----|
| date | 2026-11-12 |
| task_id | S3-director-test-lifecycle（DT-001/DT-002/DT-003） |
| decision_type | U-裁决（测试面口径） |
| value | **测试文件自行承担渲染根所有权，不依赖 RTL 隐式自动 cleanup**：① 文件级 `afterEach(() => cleanup())`（沿用既有 `@testing-library/react` 的 `cleanup` 导入）作为文件级统一卸载归属点（与既有四处 `beforeEach cleanup()` 并存，不改其行为）；② 文件级 `afterAll` 所有权守卫断言 `document.body.childElementCount === 0`（并列断言 body 子元素清单为空，使失败信息直接指出残留的渲染容器标签）；③ 末例「非立意阶段推进」的等待条件从「`advanceMock.fn` 被调用」改为**真实完成 UI 信号**：`director-phase-status[data-status="advanced"]`（`setProgress` 在全部 await 之后写入）且 `director-advance` 退出 busy（组件 `disabled={busy}`，`busy` 仅在 `finally` 复位）。三者均保持既有断言与四个 `describe` 的 `beforeEach` `cleanup()` 原样。 |
| evidence_ref | `QMAI/src/components/novel/director-view.spec.tsx`（文件级 `afterEach`/`afterAll` 守卫、末例 await 完成信号）；完成契约源 `QMAI/src/components/novel/director-view.tsx` `handleAdvance`（`setBusy(false)` 在 `finally`；`setProgress({status:"advanced"})` 在 `saveDirectorPersisted`/`refreshArtifacts`/`refreshSnapshot` 之后）；`QMAI/src/components/novel/director-panel.tsx:174`（`disabled={busy}`）+ `:112`（`data-testid="director-phase-status"`） |
| 不变式依据 | `QMAI/src/test-helpers/component-test-utils.tsx` 只设 `IS_REACT_ACT_ENVIRONMENT` 与 DOM 垫片，**未注册 `cleanup`**；`vite.config.ts` **未启用 `globals: true`** ⇒ RTL 自动 cleanup（依赖全局 `afterEach`）在本仓未安装，故显式归属是必要且充分的修正点 |

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261112-DIRECTOR-TEARDOWN | 远端 CI run `43197817628`（job `131113192230`，1400 files / 22170 tests passed、0 assertion failure、**1 条 unhandled `ReferenceError: window is not defined`**）被归因到本 spec；但**具体是哪次调度回调/setState 落在用例结束后仍为推断，未插桩观测**。本修正消灭了「用例结束不卸载 + 只等 mock 入口」这一可复现的生命周期缺口，不等于已观测到该 CI 异常消失。 | 自动 CI 在含本修正的提交上给出终态结论（要求 0 unhandled error、0 not-wrapped-in-act 警告）；本地证据不足以替代远端 CI 终态。 | 该 CI 修复段落收口前 |

## 二、本地实测证据（同一文件，各跑一次）

| 阶段 | 命令 | 退出码 | 结果 | 证据（相对 `runs/run-fe6288c0ce65/`） |
|------|------|--------|------|------|
| 基线（诊断方，非本次重跑） | `npx vitest run src/components/novel/director-view.spec.tsx --reporter=verbose` | 0 | 31/31 passed；**2 条** file-level not-wrapped-in-act 警告 | `work/evidence/analyst-director-view-teardown-baseline-69d5230.log` |
| **受控负向回归 RED**（仅加 `afterAll` 守卫，未加 `afterEach`） | 同上 | **1** | 31/31 用例仍 passed，文件级 `afterAll` 断言失败：`渲染容器在文件结束后仍残留于 document.body: expected [ '<div>' ] to deeply equal []`；2 条 act 警告（与基线一致） | `work/evidence/director-teardown-ownership-red.log` / `.stderr.log` / `.exit` |
| **GREEN**（`afterEach(cleanup)` + 末例完成信号） | 同上 | **0** | 31/31 passed + 所有权守卫通过；**0** act 警告；0 unhandled error；stderr 仅剩 47 条既有 `[Chapter Ingest] silent-degrade` 噪声（与基线同量）与既有 vite 原生警告提示 | `work/evidence/director-teardown-green.log` / `.stderr.log` / `.exit` |

- RED 是**受控负向回归**（证明守卫能捕获残留渲染容器），**不是**通过的门；GREEN 的无效化者（invalidator）= 新增的 `afterEach(cleanup)` 所有权归属 + 末例完成信号等待。
- 基线、RED、GREEN 的既有用例数一致（31），未增删用例、未加 skip/retry/timeout/console 抑制/catch/垫片。

## 三、观测 vs 推断边界

1. **已观测**：本仓未安装 RTL 自动 cleanup（无 `globals: true`、helper 不注册 cleanup）；未修正态下文件结束后 `document.body` 实测残留 1 个 `<div>` 渲染容器；加上文件级 `afterEach(cleanup)` 后残留降为 0；基线 2 条 act 警告在 GREEN 中降为 0。
2. **属推断（未观测）**：CI `43197817628` 中那条 `ReferenceError: window is not defined` 的**具体调用点/setState**；本次修正与该 CI 异常的因果关系**未经远端 CI 观测确认**。
3. **未验证**：远端 CI 未重跑（不手动触发、只看修正提交上的自动 CI 结论）；未做产品有效性/EFFECTIVENESS/L9 标定结论；未宣称任何语义层面的缺陷已闭合（`DT-PRODUCT` 保持 deferred —— 无独立产品故障证据）。

## 四、边界声明（防止误读）

1. **纯测试面**：零产品/运行时/helper/配置/版本/CHANGELOG/generated/依赖改动；未新增 `window` 垫片、未动 `vite.config.ts`、未动 `component-test-utils.tsx`。
2. **断言只增不减**：既有 31 个用例的断言与四个 `describe` 的 `beforeEach cleanup()` 原样保留；末例仅把「等 mock 入口」替换为「等完成 UI 信号」，并保留 `advanceMock.fn` 调用计数与 gap/status 断言。
3. **不代替独立复核**：本文与上述日志为执行证据；语义裁决、独立差量复核、类型检查与提交由主控负责（本次未提交、未推送、未跑 typecheck/lint/全量/gen/build）。
4. **无关既有资产保持有效**：scorer-prompt spec（85/85）等未触碰，仍按原结论有效。
