// @vitest-environment jsdom
/**
 * Wave 2 @引用系统 — ReferenceMention 组件测试。
 * 候选下拉（防抖装载）+ 彩色标签条（角色蓝/章节绿/设定紫）+ 键盘导航 + 删除。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { ReferenceMention } from "./reference-mention"

const mocks = vi.hoisted(() => {
  const wikiState: { project: { id: string; path: string } | null } = {
    project: { id: "p1", path: "/p1" },
  }
  return {
    wikiState,
    t: vi.fn((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key),
    loadAllReferenceCandidates: vi.fn(async () => [
      { id: "character:林墨", kind: "character", name: "林墨", score: 0 },
      { id: "setting:北境", kind: "setting", name: "北境", score: 0 },
    ]),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.wikiState) => unknown) => selector(mocks.wikiState),
    { getState: () => mocks.wikiState },
  ),
}))

vi.mock("@/lib/reference", () => ({
  parseReferences: vi.fn((text: string) => {
    const tokens: Array<{ raw: string; full: string; kind?: string }> = []
    const re = /@([^\s@，。！？、；：]+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const raw = m[1]!
      tokens.push({
        raw,
        full: m[0]!,
        kind: /^第\d+章$/.test(raw) ? "chapter" : undefined,
      })
    }
    return tokens
  }),
  resolveReferences: vi.fn(),
  loadAllReferenceCandidates: mocks.loadAllReferenceCandidates,
}))

beforeEach(() => {
  setupDomGlobals()
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

/** 等待防抖 300ms 完成（真实 timers，act 包裹避免 React 状态更新警告） */
async function waitDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350))
  })
}

function renderMention(value: string, onRemoveToken = vi.fn()) {
  return render(<ReferenceMention value={value} onRemoveToken={onRemoveToken} />)
}

describe("ReferenceMention", () => {
  it("renders nothing without @ mentions", () => {
    const { container } = renderMention("继续写正文")
    expect(container.querySelector("ul")).toBeNull()
  })

  it("shows candidate dropdown after @ trigger (debounced)", async () => {
    renderMention("让@林")
    await waitDebounce()
    await waitFor(() => {
      expect(screen.getByText("林墨")).toBeInTheDocument()
    })
    expect(mocks.loadAllReferenceCandidates).toHaveBeenCalledWith("/p1")
  })

  it("selects candidate and updates text via onRemoveToken channel", async () => {
    const onRemoveToken = vi.fn()
    renderMention("让@林", onRemoveToken)
    await waitDebounce()
    await waitFor(() => expect(screen.getByText("林墨")).toBeInTheDocument())
    fireEvent.click(screen.getByText("林墨"))
    expect(onRemoveToken).toHaveBeenCalledWith("让@林墨")
  })

  it("renders colored chips for resolved references", () => {
    renderMention("让@林墨，出场；@北境 是背景")
    expect(screen.getByText("角色 · 林墨")).toBeInTheDocument()
    expect(screen.getByText("角色 · 北境")).toBeInTheDocument()
  })

  it("renders chapter chip with green style", () => {
    renderMention("回顾@第3章")
    expect(screen.getByText("章节 · 第3章")).toBeInTheDocument()
  })

  it("removes chip via delete button", () => {
    const onRemoveToken = vi.fn()
    renderMention("让@林墨，出场", onRemoveToken)
    fireEvent.click(screen.getByLabelText("移除引用"))
    expect(onRemoveToken).toHaveBeenCalledWith("@林墨")
  })

  it("keyboard navigation: ArrowDown moves active index, Enter selects", async () => {
    const onRemoveToken = vi.fn()
    const ref = { current: null as import("./reference-mention").ReferenceMentionHandle | null }
    render(<ReferenceMention ref={ref} value="让@林" onRemoveToken={onRemoveToken} />)
    await waitDebounce()
    await waitFor(() => expect(screen.getByText("林墨")).toBeInTheDocument())
    expect(ref.current).not.toBeNull()
    // 通过 ref 暴露的 handleKeyDown 模拟键盘导航
    expect(ref.current!.handleKeyDown({ key: "ArrowDown", preventDefault: () => {} } as React.KeyboardEvent)).toBe(true)
    expect(ref.current!.handleKeyDown({ key: "Enter", preventDefault: () => {} } as React.KeyboardEvent)).toBe(true)
    expect(onRemoveToken).toHaveBeenCalled()
  })

  it("closes dropdown on Escape", async () => {
    const ref = { current: null as import("./reference-mention").ReferenceMentionHandle | null }
    render(<ReferenceMention ref={ref} value="让@林" onRemoveToken={vi.fn()} />)
    await waitDebounce()
    await waitFor(() => expect(screen.getByText("林墨")).toBeInTheDocument())
    expect(ref.current!.handleKeyDown({ key: "Escape", preventDefault: () => {} } as React.KeyboardEvent)).toBe(true)
    await waitFor(() => {
      expect(screen.queryByText("林墨")).not.toBeInTheDocument()
    })
  })
})
