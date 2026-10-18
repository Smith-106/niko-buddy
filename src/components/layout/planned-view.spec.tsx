// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, fireEvent, setupDomGlobals } from "@/test-helpers/component-test-utils"

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}))

const setActiveView = vi.fn()
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (sel: (s: unknown) => unknown) => sel({ setActiveView }),
}))

import { PlannedView } from "./planned-view"
import { PLANNED_VIEWS, getPlannedView, isPlannedView } from "./planned-views"
import zh from "@/i18n/zh.json"
import en from "@/i18n/en.json"

setupDomGlobals()

function lookup(dict: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[part]
    return undefined
  }, dict)
}

describe("计划态视图登记表（P2-7）", () => {
  it("登记表覆盖 17 个计划模块，视图名唯一", () => {
    expect(PLANNED_VIEWS).toHaveLength(17)
    const views = PLANNED_VIEWS.map((spec) => spec.view)
    expect(new Set(views).size).toBe(views.length)
    // 抽查几个此前提到的计划视图
    for (const view of ["followUpCenter", "knowledgeLibrary", "modelRoutes", "exportCenter"]) {
      expect(isPlannedView(view)).toBe(true)
      expect(getPlannedView(view)?.view).toBe(view)
    }
    expect(isPlannedView("dataManager")).toBe(false)
    expect(getPlannedView("dataManager")).toBeUndefined()
  })

  it("每个登记项的标题/描述 i18n key 在 zh 与 en 都存在", () => {
    const missing: string[] = []
    for (const spec of PLANNED_VIEWS) {
      for (const key of [spec.labelKey, spec.descKey]) {
        if (typeof lookup(zh, key) !== "string") missing.push(`zh:${key}`)
        if (typeof lookup(en, key) !== "string") missing.push(`en:${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it("占位页自身 i18n key 在 zh 与 en 都存在", () => {
    for (const key of ["wb.planned", "wb.plannedView.hint", "wb.plannedView.back"]) {
      expect(typeof lookup(zh, key)).toBe("string")
      expect(typeof lookup(en, key)).toBe("string")
    }
  })
})

describe("PlannedView 占位渲染", () => {
  afterEach(() => {
    cleanup()
    setActiveView.mockClear()
  })

  it("渲染登记项标题/描述/即将上线徽标，而不是聊天面板", () => {
    render(<PlannedView view="bookshelf" />)
    const root = screen.getByTestId("planned-view")
    expect(root.getAttribute("data-planned-view")).toBe("bookshelf")
    expect(screen.getByTestId("planned-view-title").textContent).toBe("wb.card.bookshelf")
    expect(screen.getByTestId("planned-view-desc").textContent).toBe("wb.card.bookshelfDesc")
    expect(screen.getByText("wb.plannedView.hint")).toBeTruthy()
    expect(screen.getByText("wb.planned")).toBeTruthy()
  })

  it("未登记的视图名退化为原始 key（不崩、不伪造文案）", () => {
    render(<PlannedView view="unknownModule" />)
    expect(screen.getByTestId("planned-view-title").textContent).toBe("unknownModule")
    expect(screen.queryByTestId("planned-view-desc")).toBeNull()
  })

  it("返回按钮切回工作台", () => {
    render(<PlannedView view="modelRoutes" />)
    fireEvent.click(screen.getByTestId("planned-view-back"))
    expect(setActiveView).toHaveBeenCalledWith("workbench")
  })
})
