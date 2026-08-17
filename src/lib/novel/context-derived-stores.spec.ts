import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  readEmotionalArcsText,
  readSubplotBoardText,
  readResourceLedgerText,
  readEmotionLedgerText,
  readAuraEvolutionText,
} from "./context-derived-stores"

const mocks = vi.hoisted(() => ({
  loadEmotionalArcs: vi.fn(),
  emotionalArcsToContextText: vi.fn(),
  loadSubplotBoard: vi.fn(),
  subplotBoardToContextText: vi.fn(),
  loadResourceLedger: vi.fn(),
  resourceLedgerToContextText: vi.fn(),
  loadEmotionLedger: vi.fn(),
  emotionLedgerToContextText: vi.fn(),
  loadAuraEvolution: vi.fn(),
  auraEvolutionToContextText: vi.fn(),
}))

vi.mock("./emotional-arcs", () => ({
  loadEmotionalArcs: mocks.loadEmotionalArcs,
  emotionalArcsToContextText: mocks.emotionalArcsToContextText,
}))

vi.mock("./subplot-board", () => ({
  loadSubplotBoard: mocks.loadSubplotBoard,
  subplotBoardToContextText: mocks.subplotBoardToContextText,
}))

vi.mock("./resource-ledger", () => ({
  loadResourceLedger: mocks.loadResourceLedger,
  resourceLedgerToContextText: mocks.resourceLedgerToContextText,
}))

vi.mock("./emotion-ledger", () => ({
  loadEmotionLedger: mocks.loadEmotionLedger,
  emotionLedgerToContextText: mocks.emotionLedgerToContextText,
}))

vi.mock("./aura-evolution", () => ({
  loadAuraEvolution: mocks.loadAuraEvolution,
  auraEvolutionToContextText: mocks.auraEvolutionToContextText,
}))

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
})

describe("context-derived-stores read*Text 群 (ARCH-1 Wave 1)", () => {
  it("readEmotionalArcsText: store 加载成功 → 渲染文本原样返回", async () => {
    mocks.loadEmotionalArcs.mockResolvedValue({ beats: [] })
    mocks.emotionalArcsToContextText.mockReturnValue("情绪弧线文本")

    await expect(readEmotionalArcsText("/p")).resolves.toBe("情绪弧线文本")
    expect(mocks.loadEmotionalArcs).toHaveBeenCalledWith("/p")
    expect(mocks.emotionalArcsToContextText).toHaveBeenCalledWith({ beats: [] })
  })

  it("readEmotionalArcsText: load 抛错 → 吞掉返回空串", async () => {
    mocks.loadEmotionalArcs.mockRejectedValue(new Error("boom"))
    await expect(readEmotionalArcsText("/p")).resolves.toBe("")
  })

  it("readSubplotBoardText: 成功路径 + 失败降级空串", async () => {
    mocks.loadSubplotBoard.mockResolvedValue({ entries: [] })
    mocks.subplotBoardToContextText.mockReturnValue("支线面板文本")
    await expect(readSubplotBoardText("/p")).resolves.toBe("支线面板文本")

    mocks.loadSubplotBoard.mockRejectedValue(new Error("missing"))
    await expect(readSubplotBoardText("/p")).resolves.toBe("")
  })

  it("readResourceLedgerText: 成功路径 + 失败降级空串", async () => {
    mocks.loadResourceLedger.mockResolvedValue({ items: [] })
    mocks.resourceLedgerToContextText.mockReturnValue("资源台账文本")
    await expect(readResourceLedgerText("/p")).resolves.toBe("资源台账文本")

    mocks.loadResourceLedger.mockRejectedValue(new Error("missing"))
    await expect(readResourceLedgerText("/p")).resolves.toBe("")
  })

  it("readEmotionLedgerText: 成功路径 + 失败降级空串", async () => {
    mocks.loadEmotionLedger.mockResolvedValue({ characters: [] })
    mocks.emotionLedgerToContextText.mockReturnValue("情绪债务文本")
    await expect(readEmotionLedgerText("/p")).resolves.toBe("情绪债务文本")

    mocks.loadEmotionLedger.mockRejectedValue(new Error("missing"))
    await expect(readEmotionLedgerText("/p")).resolves.toBe("")
  })

  it("readAuraEvolutionText: 空 entries → 返回空串（不调 toContextText）", async () => {
    mocks.loadAuraEvolution.mockResolvedValue({ entries: {}, lastUpdated: "" })
    await expect(readAuraEvolutionText("/p")).resolves.toBe("")
    expect(mocks.auraEvolutionToContextText).not.toHaveBeenCalled()
  })

  it("readAuraEvolutionText: 非空 entries → 逐角色渲染 currentChapter=0，过滤空文本后 join", async () => {
    mocks.loadAuraEvolution.mockResolvedValue({
      entries: { 林烬: [{ chapter: 1 }], 沈微: [{ chapter: 2 }] },
      lastUpdated: "2026-01-01",
    })
    mocks.auraEvolutionToContextText
      .mockImplementation((_store, name) => (name === "林烬" ? "林烬画像变化" : ""))
    await expect(readAuraEvolutionText("/p")).resolves.toBe("林烬画像变化")
    expect(mocks.auraEvolutionToContextText).toHaveBeenCalledWith(expect.anything(), "林烬", 0)
    expect(mocks.auraEvolutionToContextText).toHaveBeenCalledWith(expect.anything(), "沈微", 0)
  })

  it("readAuraEvolutionText: load 抛错 → 吞掉返回空串", async () => {
    mocks.loadAuraEvolution.mockRejectedValue(new Error("boom"))
    await expect(readAuraEvolutionText("/p")).resolves.toBe("")
  })
})
