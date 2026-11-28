// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, setupDomGlobals, waitFor } from "@/test-helpers/component-test-utils"
import { BookRulesPanel } from "./book-rules-panel"
import type { BookRules } from "@/lib/novel"

const novelMocks = vi.hoisted(() => ({
  loadBookRules: vi.fn(),
  saveBookRules: vi.fn(),
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadBookRules: novelMocks.loadBookRules,
    saveBookRules: novelMocks.saveBookRules,
  }
})

describe("BookRulesPanel", () => {
  beforeEach(() => {
    setupDomGlobals()
    novelMocks.loadBookRules.mockReset()
    novelMocks.saveBookRules.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it("handles null from loadBookRules and saves edited v1.1 rules across fanfic modes", async () => {
    novelMocks.loadBookRules.mockResolvedValueOnce(null)
    novelMocks.saveBookRules.mockResolvedValueOnce(undefined)

    render(<BookRulesPanel projectPath="/proj" />)
    expect(await screen.findByTestId("book-rules-panel")).toBeInTheDocument()
    expect(screen.getByText(/当前未配置任何规则/)).toBeInTheDocument()

    fireEvent.change(screen.getByTestId("book-rules-prohibitions"), { target: { value: "系统提示音\n降智" } })
    fireEvent.change(screen.getByTestId("book-rules-deviations"), { target: { value: "回忆片段" } })
    fireEvent.change(screen.getByTestId("book-rules-genre-primary"), { target: { value: "硬核修仙" } })
    fireEvent.change(screen.getByTestId("book-rules-genre-forbidden"), { target: { value: "机械降神" } })
    fireEvent.change(screen.getByTestId("book-rules-protagonist-name"), { target: { value: "林澈" } })
    fireEvent.change(screen.getByTestId("book-rules-personality-lock"), { target: { value: "极端克制" } })
    fireEvent.change(screen.getByTestId("book-rules-behavioral-constraints"), { target: { value: "先验代价" } })
    fireEvent.click(screen.getByTestId("book-rules-era-enabled"))
    fireEvent.change(screen.getByPlaceholderText(/时代（如：晚唐/), { target: { value: "晚唐" } })
    fireEvent.change(screen.getByPlaceholderText(/地域（如：江南/), { target: { value: "关中" } })
    fireEvent.change(screen.getByPlaceholderText(/禁用穿越词/), { target: { value: "手机" } })

    // 依次切换同人模式以覆盖表单分支
    const select = screen.getByTestId("book-rules-fanfic-mode")
    fireEvent.change(select, { target: { value: "canon" } })
    fireEvent.change(screen.getByPlaceholderText(/正典名册锁角色名/), { target: { value: "萧炎" } })
    fireEvent.change(select, { target: { value: "au" } })
    fireEvent.change(screen.getByPlaceholderText(/AU 分叉豁免项/), { target: { value: "都市架空" } })
    fireEvent.change(select, { target: { value: "ooc" } })
    fireEvent.change(screen.getByPlaceholderText(/自定义 OOC 标记/), { target: { value: "【OOC】" } })
    fireEvent.change(select, { target: { value: "cp" } })
    fireEvent.change(screen.getByPlaceholderText("CP 角色 A"), { target: { value: "林澈" } })
    fireEvent.change(screen.getByPlaceholderText("CP 角色 B"), { target: { value: "苏遥" } })

    fireEvent.click(screen.getByTestId("book-rules-save"))
    await waitFor(() => expect(novelMocks.saveBookRules).toHaveBeenCalledTimes(1))
    const saved = novelMocks.saveBookRules.mock.calls[0]?.[1] as BookRules
    expect(saved).toMatchObject({
      version: "1.1",
      prohibitions: ["系统提示音", "降智"],
      allowedDeviations: ["回忆片段"],
      genreLock: { primary: "硬核修仙", forbidden: ["机械降神"] },
      protagonist: { name: "林澈", personalityLock: ["极端克制"], behavioralConstraints: ["先验代价"] },
      eraConstraints: { enabled: true, period: "晚唐", region: "关中", anachronismTerms: ["手机"] },
      fanficMode: "cp",
      canonLockNames: ["萧炎"],
      auDeviations: ["都市架空"],
      oocMarkers: ["【OOC】"],
      pairing: ["林澈", "苏遥"],
    })
    expect(await screen.findByTestId("book-rules-saved")).toBeInTheDocument()
  })

  it("populates existing v1.1 rules on load and surfaces load/save errors", async () => {
    novelMocks.loadBookRules.mockResolvedValueOnce({
      version: "1.1",
      prohibitions: ["禁词X"],
      allowedDeviations: [],
      fanficMode: "cp",
      pairing: ["甲", "乙"],
    } satisfies BookRules)
    novelMocks.saveBookRules.mockRejectedValueOnce(new Error("磁盘只读"))

    render(<BookRulesPanel projectPath="/proj" />)
    expect(await screen.findByDisplayValue("禁词X")).toBeInTheDocument()
    expect(screen.getByDisplayValue("甲")).toBeInTheDocument()
    expect(screen.getByText(/CP 配对：甲 × 乙/)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("book-rules-save"))
    expect(await screen.findByTestId("book-rules-error")).toHaveTextContent("保存书籍规则失败：磁盘只读")

    cleanup()
    novelMocks.loadBookRules.mockRejectedValueOnce(new Error("JSON 损坏"))
    render(<BookRulesPanel projectPath="" />)
    expect(await screen.findByTestId("book-rules-error")).toHaveTextContent("读取书籍规则失败：JSON 损坏")
    expect(screen.getByTestId("book-rules-save")).toBeDisabled()
  })
})
