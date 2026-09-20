// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, fireEvent, setupDomGlobals } from "@/test-helpers/component-test-utils"

let mockProject: { name: string } | null = { name: "测试小说" }
let mockNovelMode = true
const setActiveView = vi.fn()

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (sel: (s: unknown) => unknown) =>
    sel({
      project: mockProject,
      novelMode: mockNovelMode,
      setActiveView,
    }),
}))

import { WorkbenchView } from "./workbench-view"

setupDomGlobals()

describe("WorkbenchView 工作台总览", () => {
  beforeEach(() => {
    mockProject = { name: "测试小说" }
    mockNovelMode = true
    setActiveView.mockClear()
  })
  afterEach(() => cleanup())

  it("渲染标题+分组+模块卡片", () => {
    render(<WorkbenchView />)
    expect(screen.getByTestId("workbench-view")).toBeTruthy()
    expect(screen.getByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").includes("测试小说"))).toBeTruthy()
    // 分组标题(i18n key 透传)
    expect(screen.getByText("wb.group.production")).toBeTruthy()
    // 已实现模块卡
    expect(screen.getByText("wb.card.dataManager")).toBeTruthy()
  })

  it("已实现模块卡点击切到对应 activeView", () => {
    render(<WorkbenchView />)
    const card = screen.getByText("wb.card.dataManager").closest("button")!
    expect(card.getAttribute("data-workbench-card")).toBe("dataManager")
    fireEvent.click(card)
    expect(setActiveView).toHaveBeenCalledWith("dataManager")
  })

  it("未实现模块卡 disabled 且显示即将上线", () => {
    render(<WorkbenchView />)
    const planned = screen.getByText("wb.card.followUp").closest("button")!
    expect(planned.disabled).toBe(true)
    expect(screen.getAllByText("wb.planned").length).toBeGreaterThan(0)
  })

  it("无项目时显示提示", () => {
    mockProject = null
    render(<WorkbenchView />)
    expect(screen.getByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").includes("wb.noProject"))).toBeTruthy()
  })
})
