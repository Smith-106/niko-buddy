// @vitest-environment jsdom
//
// PaginationControls spec —— v2.8 P1-2 通用服务端分页控件（src/components/ui/pagination.tsx）。
//
// 覆盖：
//   1. 三段渲染（prev / info / next）+ pageInfo 插值参数（page/pageCount/total）；
//   2. testIdPrefix 覆盖（canon-editor 传 "canon" 保持既有 DOM 契约）；
//   3. 边界禁用：page=1 prev 禁用；page=pageCount next 禁用；中间态两键启用；
//   4. 点击回调携带钳位后页码（越界钳位到 [1, pageCount]）；
//   5. disabled 传播（加载中禁翻页，防重复触发）；
//   6. hideOnSinglePage：默认单页隐藏；false 时单页仍渲染。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { PaginationControls } from "./pagination"

// identity + 参数拼装 mock：info 文案渲染为 "key page=2 pageCount=3 total=150"，
//便于断言插值参数（无需真实 i18n 资源；键集见 src/i18n/{zh,en}.json common.pagination）。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined
        ? key
        : `${key} ${Object.entries(params)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(" ")}`,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}))

afterEach(() => {
  cleanup()
})

describe("PaginationControls — 渲染与插值", () => {
  beforeEach(() => {
    setupDomGlobals()
  })

  it("渲染 prev/info/next 三段，info 携带 page/pageCount/total 插值参数", () => {
    render(
      <PaginationControls page={2} pageCount={3} total={150} onPageChange={() => {}} />,
    )
    expect(screen.getByTestId("pagination-pagination")).toBeTruthy()
    expect(screen.getByTestId("pagination-page-prev").textContent).toBe(
      "common.pagination.prev",
    )
    expect(screen.getByTestId("pagination-page-next").textContent).toBe(
      "common.pagination.next",
    )
    const info = screen.getByTestId("pagination-page-info").textContent ?? ""
    expect(info).toContain("common.pagination.info")
    expect(info).toContain("page=2")
    expect(info).toContain("pageCount=3")
    expect(info).toContain("total=150")
  })

  it("默认 testid 前缀为 pagination；testIdPrefix 可覆盖", () => {
    render(
      <PaginationControls
        page={1}
        pageCount={2}
        total={120}
        onPageChange={() => {}}
        testIdPrefix="canon"
      />,
    )
    expect(screen.getByTestId("canon-pagination")).toBeTruthy()
    expect(screen.getByTestId("canon-page-prev")).toBeTruthy()
    expect(screen.getByTestId("canon-page-info")).toBeTruthy()
    expect(screen.getByTestId("canon-page-next")).toBeTruthy()
  })
})

describe("PaginationControls — 禁用与钳位", () => {
  beforeEach(() => {
    setupDomGlobals()
  })

  it("page=1 → prev 禁用；page=pageCount → next 禁用；中间态两键启用", () => {
    const { rerender } = render(
      <PaginationControls page={1} pageCount={3} total={250} onPageChange={() => {}} />,
    )
    expect(
      (screen.getByTestId("pagination-page-prev") as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByTestId("pagination-page-next") as HTMLButtonElement).disabled,
    ).toBe(false)

    rerender(
      <PaginationControls page={2} pageCount={3} total={250} onPageChange={() => {}} />,
    )
    expect(
      (screen.getByTestId("pagination-page-prev") as HTMLButtonElement).disabled,
    ).toBe(false)
    expect(
      (screen.getByTestId("pagination-page-next") as HTMLButtonElement).disabled,
    ).toBe(false)

    rerender(
      <PaginationControls page={3} pageCount={3} total={250} onPageChange={() => {}} />,
    )
    expect(
      (screen.getByTestId("pagination-page-prev") as HTMLButtonElement).disabled,
    ).toBe(false)
    expect(
      (screen.getByTestId("pagination-page-next") as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it("点击回调携带目标页码；边界禁用态点击不触发回调（钳位为防御性实现）", () => {
    const onPageChange = vi.fn()
    const { rerender } = render(
      <PaginationControls page={2} pageCount={5} total={500} onPageChange={onPageChange} />,
    )
    fireEvent.click(screen.getByTestId("pagination-page-next"))
    expect(onPageChange).toHaveBeenLastCalledWith(3)
    fireEvent.click(screen.getByTestId("pagination-page-prev"))
    expect(onPageChange).toHaveBeenLastCalledWith(1)

    // 边界（page=1 / page=pageCount）按钮已禁用 → 点击不触发回调
    // （Math.max/min 钳位仅在异常状态下防御，正常流不可达）
    rerender(
      <PaginationControls page={1} pageCount={5} total={500} onPageChange={onPageChange} />,
    )
    fireEvent.click(screen.getByTestId("pagination-page-prev"))
    expect(onPageChange).toHaveBeenCalledTimes(2) // 无新增

    rerender(
      <PaginationControls page={5} pageCount={5} total={500} onPageChange={onPageChange} />,
    )
    fireEvent.click(screen.getByTestId("pagination-page-next"))
    expect(onPageChange).toHaveBeenCalledTimes(2) // 无新增
  })

  it("disabled 传播：两键均禁用（加载中防重复翻页）", () => {
    render(
      <PaginationControls
        page={2}
        pageCount={3}
        total={250}
        onPageChange={() => {}}
        disabled
      />,
    )
    expect(
      (screen.getByTestId("pagination-page-prev") as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByTestId("pagination-page-next") as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})

describe("PaginationControls — hideOnSinglePage", () => {
  beforeEach(() => {
    setupDomGlobals()
  })

  it("默认单页（pageCount<=1）返回 null（不渲染）", () => {
    const { container } = render(
      <PaginationControls page={1} pageCount={1} total={42} onPageChange={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("hideOnSinglePage=false 时单页仍渲染（两键均禁用）", () => {
    render(
      <PaginationControls
        page={1}
        pageCount={1}
        total={42}
        onPageChange={() => {}}
        hideOnSinglePage={false}
      />,
    )
    expect(screen.getByTestId("pagination-pagination")).toBeTruthy()
    expect(
      (screen.getByTestId("pagination-page-prev") as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByTestId("pagination-page-next") as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
