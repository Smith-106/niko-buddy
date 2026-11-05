// @vitest-environment jsdom
/**
 * chat-panel-dismantling-fallback.spec.tsx — 拆书指令装载失败兜底。
 *
 * 建文件理由：chat-panel.tsx:516 `loadEnabledDismantlingDirective(pp).catch(() => "")`
 * 的拒绝分支是全仓唯一未覆盖行（其余 9 个 chat-panel-*.spec 仅走成功 resolve 路径）。
 * 本文件在 ./chat-panel-widgets 边界注入拒绝，钉住「装载失败不断链、fallback 空串继续发送」。
 */
import { describe, expect, it, vi } from "vitest"

vi.mock("./chat-panel-widgets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-panel-widgets")>()
  return {
    ...actual,
    loadEnabledDismantlingDirective: vi.fn(async () => {
      throw new Error("dismantling store unreadable")
    }),
  }
})

import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"
import {
  getChatPanelMocks,
  PROJECT,
  setConversation,
  renderPanel,
  unmountPanel,
  sendText,
  lastStreamChatCall,
} from "./chat-panel-test-setup"
import { loadEnabledDismantlingDirective } from "./chat-panel-widgets"

const mocks = getChatPanelMocks()

afterEach(() => {
  unmountPanel()
  cleanup()
})

describe("ChatPanel 拆书指令兜底（novelMode + project）", () => {
  it("装载拒绝 → fallback 空串，发送不断链（streamChat 照常被调）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    renderPanel()
    await sendText("继续写")
    expect(loadEnabledDismantlingDirective).toHaveBeenCalledWith("/p/mybook")
    // 发送链继续：streamChat 被调用（未因 dismantling 拒绝而中断）
    expect(lastStreamChatCall().length).toBeGreaterThan(0)
  })
})
