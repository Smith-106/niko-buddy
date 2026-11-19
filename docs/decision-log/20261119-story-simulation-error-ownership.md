# StorySimulation 错误归属限定执行记录

| 字段 | 值 |
|------|----|
| date | 2026-11-19 |
| task_id | Session `20261109-ralph-expert-residuals` / Run `run-fe6288c0ce65` |
| decision_type | 外部佐证引用 |
| value | 执行冻结方案与独立准入 A1–A8；新增 `errorRevision` 与 additive `setTransientError`，沿用原共享 store 与父视图本地 timer。 |
| evidence_ref | `.workflow/sessions/20261109-ralph-expert-residuals/runs/run-fe6288c0ce65/outputs/engineering-error-ownership-plan.json`、同目录 `engineering-error-ownership-plan-review.json`；本批证据位于下述工作目录。 |

工作目录：`.workflow/sessions/20261109-ralph-expert-residuals/runs/run-fe6288c0ce65/work/error-ownership-20261119`（路径以 niko-hub 为根）。

原设计让采访历史错误在 3000 ms 后清除，草稿导出/导入错误在 5000 ms 后清除，空选错误为 3000 ms；父视图已有 timer identity、generation、mounted、signal 与文本守卫。缺陷特异 RED 使用原公开 `setError`，7 个用例在旧 callback 执行断言通过后，因新 error 变为 null 才失败；不同写入者的相同文本无法靠字符串区分。证据：`defect-red.json`、`executor-checks/red-2/`。

`setError` 与 `reset` 在发布状态前取消并释放 store TTL，原子发布 error 与递增版本；相同文本、null 和重复 reset 都推进版本。`setTransientError` 在 setter 前预取 expected revision，setter 返回后核对归属再排 timer；到期先核对 revision/handle，清除前释放自身引用，保留同步 subscriber 新建的 TTL。父视图追加同样的 revision 归属检查，保留原守卫。

两子视图只替换 5 + 3 个 error 配对入口。机械对照确认原 JSX、import、业务 IO、info/copied timer、reset 原字段值与 `initWithPreset` 保持，父 `handleSaveChat` 开始及成功路径逐字不变。证据：`production-source-edits.json`、`mechanical-invariants.json`。

直接 4 个 spec 共 204 个 tests 通过；`npm run typecheck -- --pretty false` 的输出为真实 `tsc --build --force`，退出码 0；8 文件既有 ESLint 退出码 0。同步 subscriber 再写 manual/transient error、清除过程中建立新 TTL、强制已取消 callback 与原 t=0 失败 / t=1000 成功 / t=5000 清理回归均在本批 spec 中验证。证据：`executor-checks/green-1/`、`typecheck-1/`、`lint-1/`。

同类 sweep 的精确 non-spec `useStorySimulationStore.setState` 仅发现父视图写 `agentChatMessages`，未发现直接 error 属性写入。白名单外静态候选：`simulation-report-view.tsx:496` 的 `setError` 来自同一 store，`:526–527` 仍为导出失败后裸 5000 ms 清理；该文件未修改，建议独立审核后决定是否另签限定修复。证据：`executor-sweeps/source-sweep.json`、`executor-sweeps/inline-error-timers.stdout.log`。

本条只记录执行事实与原设计/改动理由，不提供最终语义 verdict。独立 Reviewer、root 生成 atlas 和整工程门仍待执行；书稿 L9/P0、当前源码 Windows 包与 live MCP 门不因本批机械通过而闭合。
