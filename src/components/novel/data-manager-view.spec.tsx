// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/data-manager-view.tsx（自动生成，核心行为由专项 spec 加深） */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DataManagerView } from "./data-manager-view"
import { fireEvent, render, screen, waitFor, within } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import type { ComponentType } from "react"

const mocks = vi.hoisted(() => ({
  project: { path: "/p/book", name: "book" },
  statAllDomains: vi.fn(
    async (): Promise<Array<{ domainId: string; totalBytes: number; presentPaths: number }>> => [],
  ),
  listTrash: vi.fn(async () => []),
  moveDomainToTrash: vi.fn(async () => true),
  moveAllToTrash: vi.fn(async () => "s"),
  purgeTrashStamp: vi.fn(async () => {}),
  restoreDomainFromTrash: vi.fn(async () => {}),
  ask: vi.fn(async () => true),
  toastError: vi.fn(),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: unknown) => unknown) =>
      selector({ project: mocks.project }),
  }
})

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    statAllDomains: mocks.statAllDomains,
    listTrash: mocks.listTrash,
    moveDomainToTrash: mocks.moveDomainToTrash,
    moveAllToTrash: mocks.moveAllToTrash,
    purgeTrashStamp: mocks.purgeTrashStamp,
    restoreDomainFromTrash: mocks.restoreDomainFromTrash,
  }
})

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: mocks.ask,
}))

vi.mock("@/lib/toast", () => ({
  toast: { error: mocks.toastError, info: vi.fn(), success: vi.fn() },
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}))
describe("data-manager-view.tsx smoke", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.project = { path: "/p/book", name: "book" }
    mocks.statAllDomains.mockResolvedValue([])
    mocks.listTrash.mockResolvedValue([])
    mocks.ask.mockResolvedValue(true)
  })

  afterEach(() => {
    cleanup()
  })

  it("renders DataManagerView without crashing", () => {
    const C = DataManagerView as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })

  it("清空数据域失败时 toast 报错（无 unhandled rejection）", async () => {
    mocks.statAllDomains.mockResolvedValue([
      { domainId: "caches", totalBytes: 10, presentPaths: 2 },
    ])
    mocks.moveDomainToTrash.mockRejectedValue(new Error("copy-boom"))
    render(<DataManagerView />)
    const row = await screen.findByTestId("data-domain-caches")
    const btn = within(row).getByRole("button")
    expect(btn.hasAttribute("disabled")).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => expect(mocks.moveDomainToTrash).toHaveBeenCalled())
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.stringContaining("移入回收站失败"),
      ),
    )
  })
})
