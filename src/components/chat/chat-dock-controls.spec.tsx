// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { ChatDockControls } from "./chat-dock-controls"

const mocks = vi.hoisted(() => ({
  state: {
    chatDockPosition: "bottom" as "bottom" | "right",
    setChatDockPosition: vi.fn(),
  },
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    
  }
})

describe("ChatDockControls", () => {
  beforeEach(() => {
    mocks.state.chatDockPosition = "bottom"
    mocks.state.setChatDockPosition.mockClear()
  })

  it("shows only the sidebar dock option when chat is docked at the bottom", () => {
    mocks.state.chatDockPosition = "bottom"

    const html = renderToStaticMarkup(<ChatDockControls />)

    expect(html).toContain("chat.dockToSidebar")
    expect(html).not.toContain("chat.dockToBottom")
    expect((html.match(/<button/g) || []).length).toBe(1)
  })

  it("shows only the bottom dock option when chat is docked at the sidebar", () => {
    mocks.state.chatDockPosition = "right"

    const html = renderToStaticMarkup(<ChatDockControls />)

    expect(html).toContain("chat.dockToBottom")
    expect(html).not.toContain("chat.dockToSidebar")
    expect((html.match(/<button/g) || []).length).toBe(1)
  })

  it("clicking the toggle moves the chat to the opposite dock", () => {
    mocks.state.chatDockPosition = "bottom"
    render(<ChatDockControls />)
    fireEvent.click(screen.getByRole("button", { name: "chat.dockToSidebar" }))
    expect(mocks.state.setChatDockPosition).toHaveBeenCalledWith("right")

    mocks.state.chatDockPosition = "right"
    render(<ChatDockControls />)
    fireEvent.click(screen.getByRole("button", { name: "chat.dockToBottom" }))
    expect(mocks.state.setChatDockPosition).toHaveBeenCalledWith("bottom")
  })
})
