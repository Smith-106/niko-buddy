/**
 * R-allrepo-5 (29 全仓吸收落地): BudgetResume — 任务预算与断点续跑状态机.
 *
 * 吸收来源：累积残余 roadmap（29 号三模型 3/3 residual value 7；对应
 * ANWA bookAnalysis 的 publish/budget/watchdog 断点续跑模式）。
 *
 * 定位：长任务的确定性断点续跑——任务清单 + 预算扣减 + 已完成集合 +
 * 恢复游标。崩溃后从「最后未完成任务」恢复，不重做已完成项、不超预算。
 */

export interface BudgetTask {
  taskId: string
  /** 本任务预算成本（任意单位，如 token 估算）。 */
  cost: number
}

export interface BudgetRunState {
  runId: string
  tasks: BudgetTask[]
  /** 已完成任务 id 集合（输入序）。 */
  completedTaskIds: string[]
  /** 剩余预算。 */
  remainingBudget: number
  /** 预算耗尽而中断 → suspended；全部完成 → done；否则 → in_progress。 */
  status: "in_progress" | "suspended" | "done"
  lastUpdatedAt: string
}

export function createBudgetRun(runId: string, tasks: BudgetTask[], totalBudget: number): BudgetRunState {
  return {
    runId,
    tasks,
    completedTaskIds: [],
    remainingBudget: totalBudget,
    status: tasks.length === 0 ? "done" : "in_progress",
    lastUpdatedAt: new Date().toISOString(),
  }
}

/** 下一个待办任务（按输入序，跳过已完成）；无 → undefined。 */
export function nextPendingTask(state: BudgetRunState): BudgetTask | undefined {
  return state.tasks.find((t) => !state.completedTaskIds.includes(t.taskId))
}

export interface BudgetAdvanceResult {
  state: BudgetRunState
  accepted: boolean
  reason?: string
}

/**
 * 完成一个任务：扣减预算并记入 completed；预算不足 → suspended（不执行，
 * 状态保持可恢复）。已完成任务重复提交 → 幂等拒绝。纯函数。
 */
export function completeBudgetTask(state: BudgetRunState, taskId: string): BudgetAdvanceResult {
  const task = state.tasks.find((t) => t.taskId === taskId)
  if (!task) return { state, accepted: false, reason: `未知任务：${taskId}` }
  if (state.completedTaskIds.includes(taskId)) {
    return { state, accepted: false, reason: `任务已完成（幂等拒绝）：${taskId}` }
  }
  if (state.remainingBudget < task.cost) {
    return {
      state: { ...state, status: "suspended", lastUpdatedAt: new Date().toISOString() },
      accepted: false,
      reason: `预算不足：剩余 ${state.remainingBudget} < 任务 ${taskId} 成本 ${task.cost}，挂起待续`,
    }
  }
  const completedTaskIds = [...state.completedTaskIds, taskId]
  const remainingBudget = state.remainingBudget - task.cost
  const allDone = state.tasks.every((t) => completedTaskIds.includes(t.taskId))
  return {
    state: {
      ...state,
      completedTaskIds,
      remainingBudget,
      status: allDone ? "done" : "in_progress",
      lastUpdatedAt: new Date().toISOString(),
    },
    accepted: true,
  }
}

/** 恢复挂起的运行（注入新预算）：suspended → in_progress；其余状态不动。 */
export function resumeBudgetRun(state: BudgetRunState, additionalBudget: number): BudgetRunState {
  if (state.status !== "suspended") return state
  return {
    ...state,
    remainingBudget: state.remainingBudget + additionalBudget,
    status: "in_progress",
    lastUpdatedAt: new Date().toISOString(),
  }
}

/** 恢复游标摘要：进度 + 下一个待办 + 预算余量。 */
export function budgetRunSummary(state: BudgetRunState): string {
  const done = state.completedTaskIds.length
  const total = state.tasks.length
  const next = nextPendingTask(state)
  return [
    `运行 ${state.runId}：${done}/${total} 完成，预算余 ${state.remainingBudget}，状态 ${state.status}`,
    next ? `下一个待办：${next.taskId}（成本 ${next.cost}）` : "无待办",
  ].join("\n")
}
