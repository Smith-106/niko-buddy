// @vitest-environment jsdom
/** F4-5 冒烟覆盖：agent-chat-panel.tsx（自 story-simulation-view 剥离的角色对话面板） */
import { describe, expect, it } from "vitest"
import { AgentChatPanel } from "./agent-chat-panel"
import { render } from "@/test-helpers/component-test-utils"
import { createRef } from "react"
describe("agent-chat-panel.tsx smoke", () => {
  it("空消息渲染 hint；有消息渲染气泡", () => {
    const ref = createRef<HTMLDivElement>()
    const base = {
      agentName: "甲",
      input: "",
      onInputChange: () => {},
      onSend: () => {},
      onClose: () => {},
      onExport: () => {},
      onSave: () => {},
      sending: false,
      exporting: false,
      saving: false,
      chatLogRef: ref,
    }
    const { unmount } = render(<AgentChatPanel {...base} messages={[]} />)
    expect(document.body.textContent ?? "").toContain("甲")
    unmount()
    const { unmount: u2 } = render(
      <AgentChatPanel
        {...base}
        messages={[{ id: "m1", role: "user", content: "你好世界UNIQUE-CHAT-405" } as never]}
      />,
    )
    expect(document.body.textContent ?? "").toContain("你好世界UNIQUE-CHAT-405")
    u2()
  })
})
