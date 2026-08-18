// @vitest-environment jsdom
/**
 * CognitionPanel — 角色认知面板（loading/error/noData/数据四态 + 刷新/重试/关闭 + dataVersion 重取）。
 */
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import type { CognitionState } from "@/lib/novel/character-cognition"
import type { CharacterStateStore } from "@/lib/novel/character-state"

const tMock = vi.hoisted(() => ({
  t: vi.fn((key: string, opts?: Record<string, unknown>) => (opts ? `${key}::${JSON.stringify(opts)}` : key)),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock.t }),
}))

const wiki = vi.hoisted(() => ({
  state: { dataVersion: 0 },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
}))

const cognition = vi.hoisted(() => ({
  loadCognitionState: vi.fn<(path: string) => Promise<CognitionState | null>>(async () => null),
  loadCharacterStates: vi.fn<(path: string) => Promise<CharacterStateStore>>(async () => ({ characters: [], lastUpdated: "" })),
}))

vi.mock("@/lib/novel/character-cognition", () => ({
  loadCognitionState: cognition.loadCognitionState,
}))

vi.mock("@/lib/novel/character-state", () => ({
  loadCharacterStates: cognition.loadCharacterStates,
}))

import { CognitionPanel } from "./cognition-panel"

const fullState = {
  characters: [
    { character: "林烬", knows: ["沈微是卧底", "皇城布防图位置"], doesNotKnow: ["幕后主使身份"] },
    { character: "沈微", knows: [], doesNotKnow: ["隐藏身份"] },
  ],
  readerKnows: ["林烬身怀异宝"],
  lastUpdatedChapter: 7,
}

const fullCharStates = {
  characters: [
    {
      characterName: "林烬",
      currentLocation: "皇城",
      status: "重伤",
      equipment: ["青锋剑"],
      abilities: ["御剑"],
      relationships: {},
      lastUpdatedChapter: 7,
      lastUpdatedAt: "2026-07-25T10:00:00.000Z",
    },
    {
      characterName: "沈微",
      currentLocation: "",
      status: "",
      equipment: [],
      abilities: [],
      relationships: {},
      lastUpdatedChapter: 7,
      lastUpdatedAt: "2026-07-25T10:00:00.000Z",
    },
  ],
  lastUpdated: "2026-07-25T10:00:00.000Z",
}

beforeEach(() => {
  vi.clearAllMocks()
  wiki.state.dataVersion = 0
  cognition.loadCognitionState.mockResolvedValue(fullState)
  cognition.loadCharacterStates.mockResolvedValue(fullCharStates)
})

afterEach(() => cleanup())

describe("CognitionPanel", () => {
  it("shows the loading skeleton while fetching", async () => {
    let resolveState!: (v: CognitionState | null) => void
    cognition.loadCognitionState.mockImplementationOnce(() => new Promise((res) => { resolveState = res }))
    cognition.loadCharacterStates.mockImplementationOnce(() => new Promise((res) => { res(fullCharStates) }))
    render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    expect(screen.getByRole("status")).toBeInTheDocument()
    resolveState(fullState)
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument())
  })

  it("renders character cognition, state details, reader knows and last updated", async () => {
    const { container } = render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    expect(await screen.findByText("林烬")).toBeInTheDocument()
    expect(screen.getByText("沈微")).toBeInTheDocument()
    // knows / doesNotKnow 列表
    expect(screen.getByText("沈微是卧底")).toBeInTheDocument()
    expect(screen.getByText("皇城布防图位置")).toBeInTheDocument()
    expect(screen.getByText("幕后主使身份")).toBeInTheDocument()
    // 空 knows/doesNotKnow → empty 占位：源码仅当至少一侧非空才渲染网格
    // （cognition-panel.tsx hasStateDetail 下方 knows/doesNotKnow 条件块），
    // 空侧显示 empty —— 沈微 knows 为空 → 1 处
    expect(screen.getAllByText("novel.cognition.empty").length).toBe(1)
    // 状态详情折叠（林烬有详情；沈微全空 → 无 details）
    // 点击 summary 展开（[0] 保证取到 summary 而非展开后的内部同名标签）
    fireEvent.click(screen.getAllByText("novel.character.status")[0])
    expect(screen.getByText("novel.character.location")).toBeInTheDocument()
    expect(screen.getByText("皇城")).toBeInTheDocument()
    expect(screen.getByText("重伤")).toBeInTheDocument()
    expect(screen.getByText("novel.character.equipment")).toBeInTheDocument()
    expect(screen.getByText("青锋剑")).toBeInTheDocument()
    expect(screen.getByText("novel.character.abilities")).toBeInTheDocument()
    expect(screen.getByText("御剑")).toBeInTheDocument()
    // 沈微无状态详情 → 只有林烬一个 details 折叠块（源码 hasStateDetail 分支）
    expect(container.querySelectorAll("details")).toHaveLength(1)
    // 读者知道 + 最后更新章
    expect(screen.getByText("novel.cognition.readerKnows")).toBeInTheDocument()
    expect(screen.getByText("林烬身怀异宝")).toBeInTheDocument()
    expect(screen.getByText(/novel.cognition.lastUpdated.*7/)).toBeInTheDocument()
    expect(cognition.loadCognitionState).toHaveBeenCalledWith("E:/Novel")
    expect(cognition.loadCharacterStates).toHaveBeenCalledWith("E:/Novel")
  })

  it("hides lastUpdated when lastUpdatedChapter is 0", async () => {
    cognition.loadCognitionState.mockResolvedValue({ ...fullState, lastUpdatedChapter: 0 })
    render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    await screen.findByText("林烬")
    expect(screen.queryByText(/novel.cognition.lastUpdated/)).not.toBeInTheDocument()
  })

  it("renders a character without any state detail", async () => {
    cognition.loadCharacterStates.mockResolvedValue({ characters: [], lastUpdated: "" })
    render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    await screen.findByText("林烬")
    expect(screen.queryByText("novel.character.status")).not.toBeInTheDocument()
    expect(screen.getByText("沈微是卧底")).toBeInTheDocument()
  })

  it("shows the no-data state when the state is empty", async () => {
    cognition.loadCognitionState.mockResolvedValue({ characters: [], readerKnows: [], lastUpdatedChapter: 0 })
    render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    expect(await screen.findByText("novel.cognition.noData")).toBeInTheDocument()
    expect(screen.getByText("novel.cognition.noDataHint")).toBeInTheDocument()
  })

  it("shows the error state and retries with the retry button", async () => {
    cognition.loadCognitionState.mockRejectedValueOnce(new Error("文件损坏"))
    render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    expect(await screen.findByText("novel.cognition.loadError")).toBeInTheDocument()
    expect(screen.getByText("文件损坏")).toBeInTheDocument()
    expect(screen.getByText("novel.cognition.retry")).toBeInTheDocument()
    // 重试成功后回到数据态
    fireEvent.click(screen.getByText("novel.cognition.retry"))
    expect(await screen.findByText("林烬")).toBeInTheDocument()
    expect(cognition.loadCognitionState).toHaveBeenCalledTimes(2)
  })

  it("renders a non-Error load error as its string form", async () => {
    cognition.loadCognitionState.mockRejectedValueOnce("raw-string-error")
    render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    expect(await screen.findByText("raw-string-error")).toBeInTheDocument()
  })

  it("refreshes via the header refresh button", async () => {
    render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    await screen.findByText("林烬")
    fireEvent.click(screen.getByLabelText("novel.cognition.refresh"))
    await waitFor(() => expect(cognition.loadCognitionState).toHaveBeenCalledTimes(2))
  })

  it("closes via the close button", async () => {
    const onClose = vi.fn()
    render(<CognitionPanel projectPath="E:/Novel" onClose={onClose} />)
    await screen.findByText("林烬")
    fireEvent.click(screen.getByLabelText("common.close"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("marks error state when the manual refresh fails", async () => {
    render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    await screen.findByText("林烬")
    // load() try 块：loadCognitionState reject → setState(null)/setCharStates(空)/setError
    cognition.loadCognitionState.mockRejectedValueOnce(new Error("刷新失败"))
    fireEvent.click(screen.getByLabelText("novel.cognition.refresh"))
    expect(await screen.findByText("刷新失败")).toBeInTheDocument()
    expect(screen.queryByText("林烬")).not.toBeInTheDocument()
    expect(screen.getByText("novel.cognition.loadError")).toBeInTheDocument()
  })

  it("falls back to String(err) when a manual refresh rejects with a plain value", async () => {
    render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    await screen.findByText("林烬")
    // err instanceof Error 为 false 时走 String(err)（load 回调 catch 的另一分支）
    cognition.loadCognitionState.mockRejectedValueOnce("刷新-字符串失败")
    fireEvent.click(screen.getByLabelText("novel.cognition.refresh"))
    expect(await screen.findByText("刷新-字符串失败")).toBeInTheDocument()
  })

  it("ignores a stale failure after unmount (cancelled catch guard)", async () => {
    let rejectState!: (e: Error) => void
    cognition.loadCognitionState.mockImplementationOnce(
      () => new Promise((_res, rej) => { rejectState = rej }),
    )
    const { unmount } = render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    unmount()
    await act(async () => { rejectState(new Error("迟到失败")) })
    // cancelled=true → effect catch 静默跳过，不崩溃
  })

  it("falls back to unknown placeholders when location/status are empty in a state detail", async () => {
    cognition.loadCharacterStates.mockResolvedValue({
      characters: [
        {
          characterName: "林烬",
          currentLocation: "",
          status: "",
          equipment: ["青锋剑"],
          abilities: [],
          relationships: {},
          lastUpdatedChapter: 7,
          lastUpdatedAt: "2026-07-25T10:00:00.000Z",
        },
      ],
      lastUpdated: "2026-07-25T10:00:00.000Z",
    })
    render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    await screen.findByText("林烬")
    // equipment 非空 → hasStateDetail 成立，details 内 location/status 均为空 → 两处 unknown 占位
    expect(screen.getAllByText("novel.character.unknown").length).toBe(2)
    expect(screen.getByText("青锋剑")).toBeInTheDocument()
  })

  it("shows the empty placeholder when a character has no doesNotKnow entries", async () => {
    cognition.loadCognitionState.mockResolvedValue({
      characters: [{ character: "林烬", knows: ["线索A"], doesNotKnow: [] }],
      readerKnows: [],
      lastUpdatedChapter: 0,
    })
    render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    await screen.findByText("林烬")
    // doesNotKnow.length === 0 → empty 占位（knows 侧同时非空 → 仅 1 个 empty）
    expect(screen.getAllByText("novel.cognition.empty").length).toBe(1)
  })

  it("refetches when dataVersion changes", async () => {
    const { rerender } = render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    await screen.findByText("林烬")
    expect(cognition.loadCognitionState).toHaveBeenCalledTimes(1)
    wiki.state.dataVersion = 1
    rerender(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    await waitFor(() => expect(cognition.loadCognitionState).toHaveBeenCalledTimes(2))
  })

  it("ignores a stale fetch when dataVersion changes quickly", async () => {
    let resolveFirst!: (v: CognitionState | null) => void
    cognition.loadCognitionState.mockImplementationOnce(() => new Promise((res) => { resolveFirst = res }))
    const { rerender } = render(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    wiki.state.dataVersion = 1
    rerender(<CognitionPanel projectPath="E:/Novel" onClose={vi.fn()} />)
    resolveFirst({ ...fullState, characters: [{ character: "陈旧角色", knows: [], doesNotKnow: [] }] })
    await waitFor(() => expect(cognition.loadCognitionState).toHaveBeenCalledTimes(2))
    expect(screen.queryByText("陈旧角色")).not.toBeInTheDocument()
    expect(await screen.findByText("林烬")).toBeInTheDocument()
  })
})
