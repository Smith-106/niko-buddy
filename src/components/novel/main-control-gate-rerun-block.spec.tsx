/**
 * main-control-gate-rerun-block.spec — 主控 live 页签「重跑门控」块（jsdom）。
 *
 * F17：已落库（status=saved）的草稿不得出现在可重跑列表里——重跑只会产出与正式正文
 * 不一致的判定。口径与采纳块一致：saved 只渲染「已写入正式章」徽章。
 * 覆盖：saved 无重跑按钮 / pending（draft）仍可重跑并渲染结果 / 徽章文案复用采纳块键。
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const listChapterDrafts = vi.fn(async (): Promise<unknown[]> => [])
const rerunMainControlGates = vi.fn()

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return { ...actual, listChapterDrafts, rerunMainControlGates }
})

const wikiState = vi.hoisted(() => ({
  novelConfig: { chapterTargetChars: 3000, genre: "玄幻" },
  llmConfig: { provider: "openai", model: "gpt-test", apiKey: "k", baseUrl: "" },
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  const state = {
    get novelConfig() {
      return wikiState.novelConfig
    },
    get llmConfig() {
      return wikiState.llmConfig
    },
  }
  const useWikiStore = <T,>(selector: (s: typeof state) => T) => selector(state)
  return { ...actual, useWikiStore }
})

const { MainControlGateRerunBlock } = await import("./main-control-gate-rerun-block")

const PENDING_DRAFT = {
  id: "draft_1_abc",
  chapterName: "第3章 旧梦",
  content: "正文",
  createdAt: 1,
  status: "draft" as const,
}

const SAVED_DRAFT = {
  id: "draft_9_saved",
  chapterName: "第9章 已收",
  content: "正文",
  createdAt: 1,
  status: "saved" as const,
}

function okResult(draftId: string) {
  return {
    draftId,
    chapterNumber: 3,
    rows: [
      { key: "consistency", status: "pass", verdict: "pass", findings: 0 },
      { key: "anti_ai", status: "skipped", verdict: "pending", findings: 0 },
      { key: "quality", status: "pass", verdict: "pass", findings: 0 },
    ],
    overall: "pass",
    contractEvaluated: true,
    llmMediated: true,
    unassessedDimensions: [],
  }
}

afterEach(() => {
  cleanup()
  listChapterDrafts.mockReset()
  listChapterDrafts.mockResolvedValue([])
  rerunMainControlGates.mockReset()
})

describe("MainControlGateRerunBlock（F17：saved 草稿不可重跑）", () => {
  it("status=saved 的草稿不出现在可重跑列表（无重跑按钮，且不触发重跑）", async () => {
    listChapterDrafts.mockResolvedValue([SAVED_DRAFT])
    render(<MainControlGateRerunBlock projectPath="/proj" />)

    // 行仍在（可见已落库），但不再提供重跑入口。
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-row-draft_9_saved")).toBeTruthy())
    expect(screen.queryByTestId("main-control-gate-rerun-draft_9_saved")).toBeNull()
    expect(screen.queryAllByRole("button")).toHaveLength(0)
    expect(rerunMainControlGates).not.toHaveBeenCalled()
  })

  it("pending（draft）草稿仍可重跑，并渲染三门结果", async () => {
    listChapterDrafts.mockResolvedValue([PENDING_DRAFT])
    rerunMainControlGates.mockResolvedValue(okResult(PENDING_DRAFT.id))
    render(<MainControlGateRerunBlock projectPath="/proj" />)

    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-draft_1_abc")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-gate-rerun-draft_1_abc"))

    await waitFor(() => expect(rerunMainControlGates).toHaveBeenCalledTimes(1))
    expect(rerunMainControlGates).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/proj", draftId: PENDING_DRAFT.id }),
    )
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-result")).toBeTruthy())
    expect(screen.getByTestId("main-control-gate-row-consistency")).toBeTruthy()
    // 未评估门仍呈现「未评估」，绝不呈现为通过
    expect(screen.getByTestId("main-control-gate-row-anti_ai").textContent).toContain("未评估")
  })

  it("saved 徽章文案复用采纳块键（渲染真实中文，而非裸 key）", async () => {
    listChapterDrafts.mockResolvedValue([PENDING_DRAFT, SAVED_DRAFT])
    render(<MainControlGateRerunBlock projectPath="/proj" />)

    const badge = await waitFor(() => screen.getByTestId("main-control-gate-rerun-saved-draft_9_saved"))
    expect(badge.textContent).toContain("已写入正式章")
    expect(badge.textContent).not.toContain("mainControl.draftSavedAlready")

    // 同一列表内：saved 无按钮，pending 有按钮。
    expect(screen.queryByTestId("main-control-gate-rerun-draft_9_saved")).toBeNull()
    expect(screen.getByTestId("main-control-gate-rerun-draft_1_abc")).toBeTruthy()
  })
})
