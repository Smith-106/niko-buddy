/** C4 冒烟覆盖：src/stores/wiki-store.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DEFAULT_RERANK_CONFIG, TASK_PROMPT_KEYS, DEFAULT_NOVEL_CONFIG, confirmDiscardSkillLibraryDraft, useWikiStore } from "./wiki-store"
import { resolveAiWorkflowMode } from "@/lib/agent/workflow-mode"
describe("wiki-store.ts smoke", () => {
  it("exports DEFAULT_RERANK_CONFIG", () => {
    expect(DEFAULT_RERANK_CONFIG).toBeDefined()
  })
  it("exports TASK_PROMPT_KEYS", () => {
    expect(TASK_PROMPT_KEYS).toBeDefined()
  })
  it("exports DEFAULT_NOVEL_CONFIG", () => {
    expect(DEFAULT_NOVEL_CONFIG).toBeDefined()
  })
  it("confirmDiscardSkillLibraryDraft() executes", async () => {
    await (confirmDiscardSkillLibraryDraft() as unknown as Promise<unknown>)
  })
  it("exports useWikiStore", () => {
    expect(useWikiStore).toBeDefined()
  })
})

describe("aiWorkflowMode（D1=A 全局设置项）", () => {
  it("初始值为 DEFAULT_AI_WORKFLOW_MODE", () => {
    expect(useWikiStore.getState().aiWorkflowMode).toBe("standard")
  })
  it("setAiWorkflowMode 更新 state", () => {
    useWikiStore.getState().setAiWorkflowMode("strict")
    expect(useWikiStore.getState().aiWorkflowMode).toBe("strict")
    useWikiStore.getState().setAiWorkflowMode("fast")
    expect(useWikiStore.getState().aiWorkflowMode).toBe("fast")
    useWikiStore.getState().setAiWorkflowMode("standard")
  })
  it("非法持久值经 resolveAiWorkflowMode 回落 standard", () => {
    useWikiStore.getState().setAiWorkflowMode(resolveAiWorkflowMode("bogus"))
    expect(useWikiStore.getState().aiWorkflowMode).toBe("standard")
  })
})
