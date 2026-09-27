/** C4 冒烟覆盖：src/stores/wiki-store.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DEFAULT_RERANK_CONFIG, TASK_PROMPT_KEYS, DEFAULT_NOVEL_CONFIG, confirmDiscardSkillLibraryDraft, useWikiStore } from "./wiki-store"
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
