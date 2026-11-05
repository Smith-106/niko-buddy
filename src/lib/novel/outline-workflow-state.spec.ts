/** C4 冒烟覆盖：src/lib/novel/outline-workflow-state.ts（自动生成，核心行为由专项 spec 加深）
 *
 * B2（守门四件套接线 · 显式登记，非删除）：
 * - 现状：本模块（15 阶段大纲向导状态机）生产零消费，本 spec 是其唯一引用方。
 * - 接线决策（保守档不删文件）：暂不接入 outline 生产流程。原因：大纲向导链
 *   路线（outline-generation.ts / outline-generation-store.ts）使用自有 5 态内存
 *   状态，本 15 阶段模型与之无映射；硬接会制造「纸面接线」假覆盖。
 * - 恢复条件：大纲流程引入确定性阶段门时，按 stage-vocabulary 映射方式
 *   （mapCheckpointStageToCanonical 模式）接入本状态机并删除本条登记。
 * - 审计溯源：swarm run-65559216952f（O5 / I0+S0）。
 */
import { describe, expect, it } from "vitest"
import { createInitialOutlineWorkflowState, canTransitionOutlineWorkflow, transitionOutlineWorkflow } from "./outline-workflow-state"
describe("outline-workflow-state.ts smoke", () => {
  it("createInitialOutlineWorkflowState() executes", async () => {
    await (createInitialOutlineWorkflowState() as unknown as Promise<unknown>)
  })
  it("exports canTransitionOutlineWorkflow", () => {
    expect(canTransitionOutlineWorkflow).toBeDefined()
  })
  it("exports transitionOutlineWorkflow", () => {
    expect(transitionOutlineWorkflow).toBeDefined()
  })
})

describe("outline-workflow-state 阶段门行为", () => {
  it("初始状态为 idle，history 以 idle 为起点且带时间戳", () => {
    const before = Date.now()
    const state = createInitialOutlineWorkflowState()
    expect(state.stage).toBe("idle")
    expect(state.history).toEqual(["idle"])
    expect(state.updatedAt).toBeGreaterThanOrEqual(before)
    expect(state.updatedAt).toBeLessThanOrEqual(Date.now())
  })

  it("迁移表内的目标放行，表外目标拒绝", () => {
    expect(canTransitionOutlineWorkflow("idle", "intent_analysis")).toBe(true)
    expect(canTransitionOutlineWorkflow("idle", "collecting_requirements")).toBe(true)
    expect(canTransitionOutlineWorkflow("saved", "idle")).toBe(false)
    expect(canTransitionOutlineWorkflow("idle", "saved")).toBe(false)
  })

  it("合法迁移推进 stage、追加 history，且不原地修改旧状态", () => {
    const initial = createInitialOutlineWorkflowState()
    const next = transitionOutlineWorkflow(initial, "intent_analysis")
    expect(next.stage).toBe("intent_analysis")
    expect(next.history).toEqual(["idle", "intent_analysis"])
    expect(initial.history).toEqual(["idle"])
    expect(next.updatedAt).toBeGreaterThanOrEqual(initial.updatedAt)
  })

  it("全链路阶段序列可达 saved（每一跳都在迁移表内）", () => {
    const stages = [
      "intent_analysis",
      "sufficiency_check",
      "generation_plan",
      "waiting_user_confirm",
      "multi_agent_planning",
      "running_subagents",
      "merging_results",
      "quality_check",
      "preview",
      "waiting_save_confirm",
      "saved",
    ] as const
    let state = createInitialOutlineWorkflowState()
    for (const stage of stages) state = transitionOutlineWorkflow(state, stage)
    expect(state.stage).toBe("saved")
    expect(state.history).toEqual(["idle", ...stages])
  })

  it("表外跳转 fail-loud，错误消息点明 from/to", () => {
    const initial = createInitialOutlineWorkflowState()
    expect(() => transitionOutlineWorkflow(initial, "saved")).toThrow(
      /不能从「idle」跳转到「saved」/,
    )
  })
})
