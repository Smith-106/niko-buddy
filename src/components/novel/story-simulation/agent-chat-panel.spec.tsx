// @vitest-environment jsdom
/** F4-5 冒烟覆盖：agent-chat-panel.tsx（自 story-simulation-view 剥离的角色对话面板） */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { AgentChatPanel } from "./agent-chat-panel"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function inputBase(overrides: Record<string, unknown> = {}) {
  return {
    agentName: "甲",
    messages: [],
    input: "",
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onClose: vi.fn(),
    onExport: vi.fn(),
    onSave: vi.fn(),
    sending: false,
    exporting: false,
    saving: false,
    chatLogRef: createRef<HTMLDivElement>(),
    ...overrides,
  }
}

describe("agent-chat-panel 输入区", () => {
  it("输入框变更透出 onInputChange", () => {
    const props = inputBase({ input: "" })
    render(<AgentChatPanel {...props} />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "追问 UNIQUE-CHAT-IN-1" } })
    expect(props.onInputChange).toHaveBeenCalledWith("追问 UNIQUE-CHAT-IN-1")
  })

  it("Enter 发送；Shift+Enter 不发送", () => {
    const props = inputBase({ input: "有内容" })
    render(<AgentChatPanel {...props} />)
    const box = screen.getByRole("textbox")
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true })
    expect(props.onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: "Enter" })
    expect(props.onSend).toHaveBeenCalledTimes(1)
  })

  it("IME 组合中 Enter 不发送", () => {
    const props = inputBase({ input: "拼音" })
    render(<AgentChatPanel {...props} />)
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", keyCode: 229 })
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it("Escape 清空输入", () => {
    const props = inputBase({ input: "待清空" })
    render(<AgentChatPanel {...props} />)
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" })
    expect(props.onInputChange).toHaveBeenCalledWith("")
  })

  it("发送按钮：空白/sending 禁用；有内容可点并回调", () => {
    const empty = inputBase({ input: "   " })
    const { unmount } = render(<AgentChatPanel {...empty} />)
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true)
    unmount()
    const r2 = render(<AgentChatPanel {...inputBase({ input: "有内容", sending: true })} />)
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true)
    r2.unmount()
    const ready = inputBase({ input: "有内容" })
    render(<AgentChatPanel {...ready} />)
    const btn = screen.getByRole("button", { name: "发送" }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(ready.onSend).toHaveBeenCalledTimes(1)
  })

  it("保存中显示 spinner 且禁用保存按钮；就绪时点击透出三回调", () => {
    const busy = inputBase({
      saving: true,
      messages: [{ id: "m1", role: "user", content: "x" }],
    })
    const { unmount } = render(<AgentChatPanel {...busy} />)
    expect(document.querySelector(".animate-spin")).toBeTruthy()
    expect((screen.getByRole("button", { name: "保存采访对话" }) as HTMLButtonElement).disabled).toBe(true)
    unmount()
    const ready = inputBase({ messages: [{ id: "m1", role: "user", content: "x" }] })
    render(<AgentChatPanel {...ready} />)
    fireEvent.click(screen.getByRole("button", { name: "保存采访对话" }))
    expect(ready.onSave).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "导出对话为MD" }))
    expect(ready.onExport).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "关闭对话" }))
    expect(ready.onClose).toHaveBeenCalledTimes(1)
  })

  it("非 sending 空 agent 消息不显示占位", () => {
    render(
      <AgentChatPanel
        {...inputBase({
          sending: false,
          messages: [{ id: "m-idle", role: "agent", content: "" }],
        })}
      />,
    )
    expect(screen.queryByText("...", { exact: true })).toBeNull()
  })

  it("agent 空消息在 sending 时显示省略占位", () => {
    render(
      <AgentChatPanel
        {...inputBase({
          sending: true,
          messages: [{ id: "m-stream", role: "agent", content: "" }],
        })}
      />,
    )
    expect(screen.getByText("...", { exact: true })).toBeTruthy()
  })
})
