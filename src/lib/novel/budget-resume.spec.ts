import { describe, expect, it } from "vitest"
import {
  budgetRunSummary,
  completeBudgetTask,
  createBudgetRun,
  nextPendingTask,
  resumeBudgetRun,
  type BudgetTask,
} from "./budget-resume"

const TASKS: BudgetTask[] = [
  { taskId: "outline", cost: 10 },
  { taskId: "ch1", cost: 30 },
  { taskId: "ch2", cost: 30 },
]

describe("budget-resume（吸收累积残余：拆书预算断点续跑模式）", () => {
  it("createBudgetRun：初始 in_progress；空任务即 done", () => {
    expect(createBudgetRun("r1", TASKS, 100).status).toBe("in_progress")
    expect(createBudgetRun("r2", [], 50).status).toBe("done")
  })

  it("逐任务扣减预算；全部完成 → done", () => {
    let state = createBudgetRun("r1", TASKS, 100)
    state = completeBudgetTask(state, "outline").state
    expect(state.remainingBudget).toBe(90)
    expect(state.completedTaskIds).toEqual(["outline"])
    state = completeBudgetTask(state, "ch1").state
    state = completeBudgetTask(state, "ch2").state
    expect(state.status).toBe("done")
    expect(state.remainingBudget).toBe(30)
  })

  it("预算不足 → suspended 不执行；resume 注入预算后从断点续跑", () => {
    let state = createBudgetRun("r1", TASKS, 15)
    state = completeBudgetTask(state, "outline").state
    const blocked = completeBudgetTask(state, "ch1")
    expect(blocked.accepted).toBe(false)
    expect(blocked.reason).toContain("预算不足")
    expect(blocked.state.status).toBe("suspended")
    expect(blocked.state.remainingBudget).toBe(5)
    // 恢复：注入 30 预算 → 从 ch1 断点续跑（outline 不重做）
    state = resumeBudgetRun(blocked.state, 30)
    expect(state.status).toBe("in_progress")
    expect(state.remainingBudget).toBe(35)
    state = completeBudgetTask(state, "ch1").state
    expect(state.completedTaskIds).toEqual(["outline", "ch1"])
    expect(state.status).toBe("in_progress")
  })

  it("幂等：已完成任务重复提交拒绝；未知任务拒绝", () => {
    let state = createBudgetRun("r1", TASKS, 100)
    state = completeBudgetTask(state, "outline").state
    const dup = completeBudgetTask(state, "outline")
    expect(dup.accepted).toBe(false)
    expect(dup.reason).toContain("幂等")
    expect(completeBudgetTask(state, "ghost").reason).toContain("未知任务")
  })

  it("nextPendingTask 跳过已完成；全无待办返回 undefined", () => {
    let state = createBudgetRun("r1", TASKS, 100)
    expect(nextPendingTask(state)?.taskId).toBe("outline")
    state = completeBudgetTask(state, "outline").state
    expect(nextPendingTask(state)?.taskId).toBe("ch1")
    const doneState = state.tasks.reduce((s, t) => completeBudgetTask(s, t.taskId).state, state)
    expect(nextPendingTask(doneState)).toBeUndefined()
  })

  it("resumeBudgetRun 非 suspended 状态不动；summary 渲染进度与断点", () => {
    let state = createBudgetRun("r1", TASKS, 15)
    state = completeBudgetTask(state, "outline").state
    state = completeBudgetTask(state, "ch1").state // → suspended
    expect(resumeBudgetRun(state, 10).status).toBe("in_progress")
    const summary = budgetRunSummary(state)
    expect(summary).toContain("1/3 完成")
    expect(summary).toContain("下一个待办：ch1")
  })

  it("确定性：同输入双跑全等", () => {
    const a = completeBudgetTask(createBudgetRun("r1", TASKS, 15), "outline")
    const b = completeBudgetTask(createBudgetRun("r1", TASKS, 15), "outline")
    expect(a.accepted).toBe(b.accepted)
    expect(a.state.remainingBudget).toBe(b.state.remainingBudget)
  })
})
