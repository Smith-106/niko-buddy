/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { FanficMergeDialog } from "./fanfic-merge-dialog"

/**
 * Button 用原生 button 替身：本文件只验证 dialog 自己的接线与守卫，
 * 而 base-ui 的 Button 在 `disabled` 时会在内部 onClick 里 preventDefault 后
 * 直接短路，使「disabled 态的防御性早退」无法从处理器层被验证。
 * 替身保留 onClick / disabled 语义，既有断言（文案、disabled 属性）不变。
 */
vi.mock("@/components/ui/button", () => ({
  Button: ({
    onClick,
    disabled,
    children,
  }: {
    onClick?: () => void
    disabled?: boolean
    children?: ReactNode
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))
import type { BookAnalysisLibraryBook } from "@/lib/novel"
import type { CanonMergeProposal } from "@/lib/novel"

const mocks = vi.hoisted(() => ({
  // 返回类型放宽到 string | undefined：覆盖补齐用例需要模拟「i18n 缺键」
  // （真实配置下 returnNull/缺键都会让 t 返回 null/undefined，组件须走中文兜底）。
  t: vi.fn((k: string): string | undefined => k),
  projectPath: "/p/book",
  saveProposal: vi.fn(async () => undefined),
  loadProposal: vi.fn<() => Promise<CanonMergeProposal | null>>(async () => null),
}))

vi.mock("react-i18next", () => ({  initReactI18next: { type: "3rdParty", init: () => {} },  useTranslation: () => ({ t: mocks.t }) }))
vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (s: { project: { path: string } | null }) => unknown) =>
        selector({ project: { path: mocks.projectPath } }),
    
  }
})
vi.mock("@/lib/novel/fanfic-canon-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/fanfic-canon-import")>()
  return {
    ...actual,
    saveFanficMergeProposal: mocks.saveProposal,
    loadFanficMergeProposal: mocks.loadProposal,
  }
})

const sourceBook: BookAnalysisLibraryBook = {
  id: "lib-1",
  path: "/lib/book.md",
  metadata: { title: "源书", author: "", sourcePath: "" } as never,
  recognizedCharacters: [],
  characters: [
    { id: "c1", name: "林晚", aliases: ["晚晚"] },
    { id: "c2", name: "新角色", aliases: [] },
  ] as never,
  skills: [],
  styleStatus: "missing",
  boundAurasCount: 0,
  addedAuraCharacterIds: [],
}

describe("FanficMergeDialog", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it("生成合并预览（proposeCanonMerge 接线）：重名→认领新建跳过", async () => {
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={["林晚"]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.preview"))
    const dlg = screen.getByTestId("fanfic-merge-dialog")
    await waitFor(() => expect(dlg.textContent).toContain("novel.fanfic.previewSummary"))
    await waitFor(() => {
      expect(dlg.textContent).toContain("novel.fanfic.actionBind")
      expect(dlg.textContent).toContain("novel.fanfic.actionCreate")
    })
  })

  it("保存合并草稿（Draft-first）", async () => {
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={["林晚"]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.preview"))
    await screen.findByText("novel.fanfic.previewSummary")
    fireEvent.click(screen.getByText("novel.fanfic.savePending"))
    await screen.findByText("novel.fanfic.pendingSaved")
    expect(mocks.saveProposal).toHaveBeenCalled()
  })

  it("无源书时优雅降级（预览按钮禁用）", () => {
    render(<FanficMergeDialog open onOpenChange={() => undefined} />)
    expect(screen.getByText("novel.fanfic.title")).toBeTruthy()
    expect(screen.getByText("novel.fanfic.preview").closest("button")?.hasAttribute("disabled")).toBe(true)
  })
})

describe("FanficMergeDialog 覆盖补齐：skip 标签/预览异常/pending 双路径/冲突渲染", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())
  it("源书重名 → skip 标签 + 冲突清单渲染", async () => {
    const dupBook: BookAnalysisLibraryBook = {
      ...sourceBook,
      id: "lib-dup",
      characters: [
        { id: "c1", name: "阿重", aliases: [] },
        { id: "c2", name: "阿重", aliases: [] },
      ] as never,
    }
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={dupBook} targetNames={[]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.preview"))
    const dlg = () => screen.getByTestId("fanfic-merge-dialog").textContent ?? ""
    await waitFor(() => expect(dlg()).toMatch(/novel\.fanfic\.actionSkip(?!\w)/))
    // 冲突行（name_collision）带 ⚠ 标记
    expect(dlg()).toContain("无法自动合并")
  })

  it("预览抛错 → previewFailed 提示（不崩）", async () => {
    const evil = { ...sourceBook, id: "lib-evil" }
    Object.defineProperty(evil, "characters", {
      get() { throw new Error("chars gone") },
    })
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={evil as never} targetNames={[]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.preview"))
    await waitFor(() => {
      expect(screen.getByTestId("fanfic-merge-dialog").textContent).toContain("chars gone")
    })
    expect(screen.getByTestId("fanfic-merge-dialog").textContent).toContain("novel.fanfic.previewFailed")
  })

  it("加载既有 pending → 提案回填 + pendingLoaded 提示", async () => {
    mocks.loadProposal.mockResolvedValue({
      sourceBookId: "lib-1",
      mode: "canon",
      characters: [{ sourceId: "c9", canonicalName: "旧人", aliases: [], action: "create_new" }],
      conflicts: [],
    })
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={[]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.loadPending"))
    await waitFor(() => {
      expect(screen.getByTestId("fanfic-merge-dialog").textContent).toContain("novel.fanfic.pendingLoaded")
    })
    expect(screen.getByTestId("fanfic-merge-dialog").textContent).toContain("旧人")
  })

  it("无 pending → noPending 提示（不回填空提案）", async () => {
    mocks.loadProposal.mockResolvedValue(null)
    render(
      <FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={[]} />,
    )
    fireEvent.click(screen.getByText("novel.fanfic.loadPending"))
    await waitFor(() => {
      expect(screen.getByTestId("fanfic-merge-dialog").textContent).toContain("novel.fanfic.noPending")
    })
  })
})

/**
 * 取出组件绑定的处理器并直接调用。
 *
 * 仅用于「UI 上不可达的防御性早退」：按钮处于 disabled 时浏览器与 React 都不会
 * 派发事件，但这些守卫本身是生产行为（无源书不预览 / 无提案不写 pending /
 * 无项目路径不读写），必须被验证——所以直接调用处理器，而不是绕过 UI 状态。
 */
function invokeBoundClick(node: HTMLElement): void {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"))
  if (!key) throw new Error("react props handle missing")
  const props = (node as unknown as Record<string, Record<string, (() => void) | undefined>>)[key]
  const fn = props?.onClick
  if (typeof fn !== "function") throw new Error("onClick missing")
  act(() => {
    fn()
  })
}

describe("FanficMergeDialog 分支补齐：动作回退/禁用态守卫/i18n 缺键兜底", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.t.mockImplementation((k: string) => k)
    mocks.projectPath = "/p/book"
  })
  afterEach(() => cleanup())

  const dialogText = (): string => screen.getByTestId("fanfic-merge-dialog").textContent ?? ""

  it("pending 工件里的未知 action → 原样回退显示（不吞标签）", async () => {
    mocks.loadProposal.mockResolvedValue({
      sourceBookId: "lib-1",
      mode: "canon",
      characters: [
        { sourceId: "c9", canonicalName: "旧人", aliases: ["阿旧"], action: "manual_bind" },
      ],
      conflicts: [],
    } as unknown as CanonMergeProposal)
    render(<FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={[]} />)
    fireEvent.click(screen.getByText("novel.fanfic.loadPending"))
    await waitFor(() => expect(dialogText()).toContain("旧人"))
    // 三种已知动作之外的 action 不被吞掉，原样显示（含别名）
    expect(dialogText()).toContain("manual_bind")
    expect(dialogText()).toContain("阿旧")
  })

  it("无源书时预览按钮被禁用；即便被程序化触发也不产生状态", () => {
    render(<FanficMergeDialog open onOpenChange={() => undefined} />)
    const button = screen.getByText("novel.fanfic.preview").closest("button") as HTMLButtonElement
    expect(button.hasAttribute("disabled")).toBe(true)
    invokeBoundClick(button)
    // 早退：不出预览摘要、不留 notice、不写 pending。
    expect(dialogText()).not.toContain("novel.fanfic.previewSummary")
    expect(mocks.saveProposal).not.toHaveBeenCalled()
    expect(screen.queryByText("novel.fanfic.pendingSaved")).toBeNull()
  })

  it("无提案时保存 pending 被禁用；程序化触发不写盘", () => {
    render(<FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={[]} />)
    const button = screen.getByText("novel.fanfic.savePending").closest("button") as HTMLButtonElement
    expect(button.hasAttribute("disabled")).toBe(true)
    invokeBoundClick(button)
    expect(mocks.saveProposal).not.toHaveBeenCalled()
    expect(screen.queryByText("novel.fanfic.pendingSaved")).toBeNull()
  })

  it("无项目路径时保存与加载都早退（不读写盘）", async () => {
    mocks.projectPath = ""
    render(<FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={[]} />)
    // 预览仍可用（不依赖项目路径），先拿到提案使保存按钮只差项目路径这一条守卫。
    fireEvent.click(screen.getByText("novel.fanfic.preview"))
    await waitFor(() => expect(dialogText()).toContain("novel.fanfic.previewSummary"))

    const save = screen.getByText("novel.fanfic.savePending").closest("button") as HTMLButtonElement
    const load = screen.getByText("novel.fanfic.loadPending").closest("button") as HTMLButtonElement
    expect(save.hasAttribute("disabled")).toBe(true)
    expect(load.hasAttribute("disabled")).toBe(true)
    invokeBoundClick(save)
    invokeBoundClick(load)
    expect(mocks.saveProposal).not.toHaveBeenCalled()
    expect(mocks.loadProposal).not.toHaveBeenCalled()
    expect(screen.queryByText("novel.fanfic.pendingSaved")).toBeNull()
  })

  it("i18n 缺键（t 返回 undefined）→ 全部中文兜底，不渲染 undefined", async () => {
    mocks.t.mockImplementation(() => undefined)
    mocks.loadProposal.mockResolvedValue(null)
    render(<FanficMergeDialog open onOpenChange={() => undefined} sourceBook={sourceBook} targetNames={[]} />)
    // 说明文案 / 三个按钮标签走兜底
    expect(dialogText()).toContain("确定性合并预览")
    expect(screen.getByText("生成合并预览")).toBeTruthy()
    expect(screen.getByText("保存 pending")).toBeTruthy()
    expect(screen.getByText("加载 pending")).toBeTruthy()

    fireEvent.click(screen.getByText("生成合并预览"))
    await waitFor(() => expect(dialogText()).toContain("林晚"))
    fireEvent.click(screen.getByText("保存 pending"))
    await waitFor(() => expect(dialogText()).toContain("已保存 pending 工件"))
    fireEvent.click(screen.getByText("加载 pending"))
    await waitFor(() => expect(dialogText()).toContain("无 pending 提案"))

    // 有 pending → pendingLoaded 兜底
    mocks.loadProposal.mockResolvedValue({
      sourceBookId: "lib-1",
      mode: "canon",
      characters: [{ sourceId: "c9", canonicalName: "旧人", aliases: [], action: "create_new" }],
      conflicts: [],
    })
    fireEvent.click(screen.getByText("加载 pending"))
    await waitFor(() => expect(dialogText()).toContain("已加载既有 pending 提案"))
    expect(dialogText()).not.toContain("undefined")
  })

  it("i18n 缺键时预览异常 → 「预览失败：原因」兜底", async () => {
    mocks.t.mockImplementation(() => undefined)
    const evil = { ...sourceBook, id: "lib-evil-cn" }
    Object.defineProperty(evil, "characters", {
      get() {
        throw new Error("chars gone")
      },
    })
    render(<FanficMergeDialog open onOpenChange={() => undefined} sourceBook={evil as never} targetNames={[]} />)
    fireEvent.click(screen.getByText("生成合并预览"))
    await waitFor(() => expect(dialogText()).toContain("预览失败：chars gone"))
    expect(dialogText()).not.toContain("undefined")
  })
})
