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
