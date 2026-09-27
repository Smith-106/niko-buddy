/** C4 冒烟覆盖：src/stores/chat-store.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { useChatStore, chatMessagesToLLM } from "./chat-store"
describe("chat-store.ts smoke", () => {
  it("exports useChatStore", () => {
    expect(useChatStore).toBeDefined()
  })
  it("exports chatMessagesToLLM", () => {
    expect(chatMessagesToLLM).toBeDefined()
  })
})
