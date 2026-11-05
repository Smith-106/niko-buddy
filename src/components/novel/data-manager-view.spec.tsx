// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/data-manager-view.tsx（自动生成，核心行为由专项 spec 加深） */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DataManagerView } from "./data-manager-view"
import { act, fireEvent, render, screen, waitFor, within } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import type { ComponentType } from "react"
import type { TrashEntry } from "@/lib/novel"

const mocks = vi.hoisted(() => ({
  project: { path: "/p/book", name: "book" },
  statAllDomains: vi.fn(
    async (): Promise<Array<{ domainId: string; totalBytes: number; presentPaths: number }>> => [],
  ),
  listTrash: vi.fn(async (_projectPath: string): Promise<TrashEntry[]> => []),
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

describe("data-manager-view.tsx 行为加深", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.project = { path: "/p/book", name: "book" }
    // clearAllMocks 只清调用记录不清 once 队列：先 mockReset 再重建默认实现，
    // 防止 smoke 组遗留的 mockRejectedValueOnce 污染本组断言。
    mocks.statAllDomains.mockReset().mockResolvedValue([])
    mocks.listTrash.mockReset().mockResolvedValue([])
    mocks.ask.mockReset().mockResolvedValue(true)
    mocks.moveDomainToTrash.mockReset().mockResolvedValue(true as never)
    mocks.moveAllToTrash.mockReset().mockResolvedValue("s")
    mocks.purgeTrashStamp.mockReset().mockResolvedValue(undefined)
    mocks.restoreDomainFromTrash.mockReset().mockResolvedValue(undefined)
    mocks.toastError.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  const STAMP_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/
  const TRASH = [{ stamp: "2026-01-02_00-00-00", domainIds: ["chapter-snapshots", "caches"] }]

  function domainRow(id: string): HTMLElement {
    return screen.getByTestId(`data-domain-${id}`)
  }

  function clearButton(id: string): HTMLButtonElement {
    return within(domainRow(id)).getByRole("button") as HTMLButtonElement
  }

  function confirmInput(): HTMLInputElement {
    return screen.getByTestId("data-manager-confirm-input") as HTMLInputElement
  }

  function resetAllButton(): HTMLButtonElement {
    const el = screen.getByText("dataManager.resetAll").closest("button")
    if (!el) throw new Error("resetAll button missing")
    return el as HTMLButtonElement
  }

  function refreshButton(): HTMLButtonElement {
    const el = screen.getByText("dataManager.refresh").closest("button")
    if (!el) throw new Error("refresh button missing")
    return el as HTMLButtonElement
  }

  function purgeButton(): HTMLButtonElement {
    const el = screen.getByText("dataManager.trash.purge").closest("button")
    if (!el) throw new Error("purge button missing")
    return el as HTMLButtonElement
  }

  function trashEntry(stamp: string): HTMLElement {
    const entry = screen.getByText(stamp).closest("div.rounded-lg")
    if (!entry) throw new Error(`trash entry missing: ${stamp}`)
    return entry as HTMLElement
  }

  function restoreButton(stamp: string, labelKey: string): HTMLButtonElement {
    // 域列表标题与恢复按钮渲染同一 i18n key：限定在回收站批次内查询
    return within(trashEntry(stamp)).getByRole("button", { name: labelKey }) as HTMLButtonElement
  }

  it("无项目时显示空态且不拉取统计", () => {
    mocks.project = null as unknown as typeof mocks.project
    render(<DataManagerView />)
    expect(screen.getByText("dataManager.noProject")).toBeTruthy()
    expect(mocks.statAllDomains).not.toHaveBeenCalled()
    expect(mocks.listTrash).not.toHaveBeenCalled()
  })

  it("多量级占用覆盖 formatBytes 全分支：stat 行与省略号行区分渲染", async () => {
    mocks.statAllDomains.mockResolvedValue([
      { domainId: "caches", totalBytes: 1536, presentPaths: 2 },
      { domainId: "vector-index", totalBytes: 12 * 1024 * 1024, presentPaths: 3 },
      { domainId: "simulations", totalBytes: 0, presentPaths: 1 },
      { domainId: "dashboard", totalBytes: 5 * 1024 ** 4, presentPaths: 4 },
    ])
    render(<DataManagerView />)
    await screen.findByTestId("data-domain-caches")
    // 11 个数据域中 4 个有统计 → 其余 7 个显示省略号
    expect(await screen.findAllByText("dataManager.stat")).toHaveLength(4)
    expect(screen.getAllByText("…")).toHaveLength(7)
    expect(screen.getByText("dataManager.total")).toBeTruthy()
  })

  it("小字节总量走 B 分支", async () => {
    mocks.statAllDomains.mockResolvedValue([{ domainId: "caches", totalBytes: 5, presentPaths: 1 }])
    render(<DataManagerView />)
    await screen.findByText("dataManager.stat")
    expect(screen.getAllByText("dataManager.stat")).toHaveLength(1)
    expect(screen.getAllByText("…")).toHaveLength(10)
  })

  it("用户域未输入确认 id：只弹 typed-confirm，不删除", async () => {
    mocks.statAllDomains.mockResolvedValue([
      { domainId: "chapter-snapshots", totalBytes: 100, presentPaths: 2 },
    ])
    render(<DataManagerView />)
    await screen.findByText("dataManager.stat")
    fireEvent.click(clearButton("chapter-snapshots"))
    await waitFor(() =>
      expect(mocks.ask).toHaveBeenCalledWith("dataManager.confirm.typeToConfirm", expect.anything()),
    )
    await act(async () => {})
    expect(mocks.moveDomainToTrash).not.toHaveBeenCalled()
  })

  it("用户域输入正确 id 并二次确认：移入回收站并清空输入", async () => {
    mocks.statAllDomains.mockResolvedValue([
      { domainId: "chapter-snapshots", totalBytes: 100, presentPaths: 2 },
    ])
    render(<DataManagerView />)
    await screen.findByText("dataManager.stat")
    fireEvent.change(confirmInput(), { target: { value: "chapter-snapshots" } })
    expect(confirmInput().value).toBe("chapter-snapshots")
    fireEvent.click(clearButton("chapter-snapshots"))
    await waitFor(() => expect(mocks.moveDomainToTrash).toHaveBeenCalled())
    expect(mocks.ask).toHaveBeenCalledWith("dataManager.confirm.moveToTrash", expect.anything())
    const [, domainArg, stampArg] = mocks.moveDomainToTrash.mock.calls[0] as unknown[]
    expect((domainArg as { id: string }).id).toBe("chapter-snapshots")
    expect(stampArg).toMatch(STAMP_RE)
    await waitFor(() => expect(confirmInput().value).toBe(""))
    expect(mocks.statAllDomains).toHaveBeenCalledTimes(2)
  })

  it("二次确认取消：不删除", async () => {
    mocks.ask.mockResolvedValueOnce(false)
    mocks.statAllDomains.mockResolvedValue([{ domainId: "caches", totalBytes: 10, presentPaths: 2 }])
    render(<DataManagerView />)
    await screen.findByText("dataManager.stat")
    fireEvent.click(clearButton("caches"))
    await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(mocks.moveDomainToTrash).not.toHaveBeenCalled()
    expect(mocks.statAllDomains).toHaveBeenCalledTimes(1)
  })

  it("清空进行中：域按钮显示 spinner，完成后恢复", async () => {
    let release!: (v: boolean) => void
    mocks.moveDomainToTrash.mockImplementationOnce(
      () => new Promise((r) => {
        release = r
      }),
    )
    mocks.statAllDomains.mockResolvedValue([{ domainId: "caches", totalBytes: 10, presentPaths: 2 }])
    render(<DataManagerView />)
    await screen.findByText("dataManager.stat")
    fireEvent.click(clearButton("caches"))
    await waitFor(() =>
      expect(domainRow("caches").querySelector("button svg.animate-spin")).not.toBeNull(),
    )
    await act(async () => {
      release(true)
    })
    await waitFor(() => expect(mocks.statAllDomains).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(domainRow("caches").querySelector("button svg.animate-spin")).toBeNull(),
    )
  })

  it("刷新中按钮禁用并显示 spinner，点击刷新重新拉取", async () => {
    let releaseStats!: (v: Array<{ domainId: string; totalBytes: number; presentPaths: number }>) => void
    mocks.statAllDomains.mockImplementationOnce(
      () =>
        new Promise((r) => {
          releaseStats = r
        }),
    )
    render(<DataManagerView />)
    await waitFor(() => expect(refreshButton().hasAttribute("disabled")).toBe(true))
    expect(refreshButton().querySelector("svg.animate-spin")).not.toBeNull()
    await act(async () => {
      releaseStats([])
    })
    await screen.findByTestId("data-domain-caches")
    await waitFor(() => expect(refreshButton().hasAttribute("disabled")).toBe(false))
    fireEvent.click(refreshButton())
    await waitFor(() => expect(mocks.statAllDomains).toHaveBeenCalledTimes(2))
  })

  it("整项目重置未输入 RESET：只弹 typeReset，不执行", async () => {
    render(<DataManagerView />)
    await screen.findByTestId("data-domain-caches")
    fireEvent.click(resetAllButton())
    await waitFor(() =>
      expect(mocks.ask).toHaveBeenCalledWith("dataManager.confirm.typeReset", expect.anything()),
    )
    await act(async () => {})
    expect(mocks.moveAllToTrash).not.toHaveBeenCalled()
  })

  it("输入 RESET 并确认：整项目移入回收站并清空输入", async () => {
    render(<DataManagerView />)
    await screen.findByTestId("data-domain-caches")
    fireEvent.change(confirmInput(), { target: { value: "RESET" } })
    fireEvent.click(resetAllButton())
    await waitFor(() => expect(mocks.moveAllToTrash).toHaveBeenCalled())
    const [projArg, stampArg] = mocks.moveAllToTrash.mock.calls[0] as unknown[]
    expect(projArg).toBe("/p/book")
    expect(stampArg).toMatch(STAMP_RE)
    await waitFor(() => expect(confirmInput().value).toBe(""))
  })

  it("整项目重置二次确认取消：不执行", async () => {
    mocks.ask.mockResolvedValueOnce(false)
    render(<DataManagerView />)
    await screen.findByTestId("data-domain-caches")
    fireEvent.change(confirmInput(), { target: { value: "RESET" } })
    fireEvent.click(resetAllButton())
    await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(mocks.moveAllToTrash).not.toHaveBeenCalled()
  })

  it("整项目重置失败：toast 报错", async () => {
    mocks.moveAllToTrash.mockRejectedValueOnce(new Error("reset-boom"))
    render(<DataManagerView />)
    await screen.findByTestId("data-domain-caches")
    fireEvent.change(confirmInput(), { target: { value: "RESET" } })
    fireEvent.click(resetAllButton())
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("整项目重置失败")),
    )
  })

  it("整项目重置进行中：按钮显示 spinner", async () => {
    let release!: (v: string) => void
    mocks.moveAllToTrash.mockImplementationOnce(
      () =>
        new Promise<string>((r) => {
          release = r
        }),
    )
    render(<DataManagerView />)
    await screen.findByTestId("data-domain-caches")
    fireEvent.change(confirmInput(), { target: { value: "RESET" } })
    fireEvent.click(resetAllButton())
    await waitFor(() =>
      expect(resetAllButton().querySelector("svg.animate-spin")).not.toBeNull(),
    )
    await act(async () => {
      release("stamp-x")
    })
    await waitFor(() => expect(mocks.statAllDomains).toHaveBeenCalledTimes(2))
  })

  it("回收站非空：渲染批次与恢复按钮（kebab→camel）", async () => {
    mocks.listTrash.mockResolvedValue(TRASH)
    render(<DataManagerView />)
    await screen.findByText("2026-01-02_00-00-00")
    const entry = trashEntry("2026-01-02_00-00-00")
    expect(within(entry).getByRole("button", { name: "dataManager.domain.chapterSnapshots" })).toBeTruthy()
    expect(within(entry).getByRole("button", { name: "dataManager.domain.caches" })).toBeTruthy()
    expect(screen.queryByText("dataManager.trash.empty")).toBeNull()
  })

  it("purge 确认后物理删除并刷新", async () => {
    mocks.listTrash.mockResolvedValue(TRASH)
    render(<DataManagerView />)
    await screen.findByText("2026-01-02_00-00-00")
    fireEvent.click(purgeButton())
    await waitFor(() =>
      expect(mocks.purgeTrashStamp).toHaveBeenCalledWith("/p/book", "2026-01-02_00-00-00"),
    )
    await waitFor(() => expect(mocks.statAllDomains).toHaveBeenCalledTimes(2))
  })

  it("purge 取消：不删除", async () => {
    mocks.ask.mockResolvedValueOnce(false)
    mocks.listTrash.mockResolvedValue(TRASH)
    render(<DataManagerView />)
    await screen.findByText("2026-01-02_00-00-00")
    fireEvent.click(purgeButton())
    await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(mocks.purgeTrashStamp).not.toHaveBeenCalled()
  })

  it("purge 失败：toast 报错", async () => {
    mocks.purgeTrashStamp.mockRejectedValueOnce(new Error("purge-boom"))
    mocks.listTrash.mockResolvedValue(TRASH)
    render(<DataManagerView />)
    await screen.findByText("2026-01-02_00-00-00")
    fireEvent.click(purgeButton())
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("物理删除失败")),
    )
  })

  it("purge 进行中显示 spinner", async () => {
    let release!: () => void
    mocks.purgeTrashStamp.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = r
        }),
    )
    mocks.listTrash.mockResolvedValue(TRASH)
    render(<DataManagerView />)
    await screen.findByText("2026-01-02_00-00-00")
    fireEvent.click(purgeButton())
    await waitFor(() =>
      expect(purgeButton().querySelector("svg.animate-spin")).not.toBeNull(),
    )
    await act(async () => {
      release()
    })
    await waitFor(() => expect(mocks.purgeTrashStamp).toHaveBeenCalled())
  })

  it("恢复域：调用 restore 并刷新", async () => {
    mocks.listTrash.mockResolvedValue(TRASH)
    render(<DataManagerView />)
    await screen.findByText("2026-01-02_00-00-00")
    fireEvent.click(restoreButton("2026-01-02_00-00-00", "dataManager.domain.chapterSnapshots"))
    await waitFor(() => expect(mocks.restoreDomainFromTrash).toHaveBeenCalled())
    expect(mocks.restoreDomainFromTrash).toHaveBeenCalledWith(
      "/p/book",
      expect.objectContaining({ id: "chapter-snapshots" }),
      "2026-01-02_00-00-00",
    )
    await waitFor(() => expect(mocks.statAllDomains).toHaveBeenCalledTimes(2))
  })

  it("未知域恢复：直接返回不调用", async () => {
    mocks.listTrash.mockResolvedValue([{ stamp: "s-ghost", domainIds: ["ghost-domain"] }])
    render(<DataManagerView />)
    await screen.findByText("s-ghost")
    fireEvent.click(restoreButton("s-ghost", "dataManager.domain.ghostDomain"))
    await act(async () => {})
    expect(mocks.restoreDomainFromTrash).not.toHaveBeenCalled()
  })

  it("恢复失败：toast 报错", async () => {
    mocks.restoreDomainFromTrash.mockRejectedValueOnce(new Error("restore-boom"))
    mocks.listTrash.mockResolvedValue(TRASH)
    render(<DataManagerView />)
    await screen.findByText("2026-01-02_00-00-00")
    fireEvent.click(restoreButton("2026-01-02_00-00-00", "dataManager.domain.caches"))
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("恢复失败")),
    )
  })
})
