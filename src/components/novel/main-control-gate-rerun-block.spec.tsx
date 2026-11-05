/**
 * main-control-gate-rerun-block.spec — 主控 live 页签「重跑门控」块（jsdom）。
 *
 * F17：已落库（status=saved）的草稿不得出现在可重跑列表里——重跑只会产出与正式正文
 * 不一致的判定。口径与采纳块一致：saved 只渲染「已写入正式章」徽章。
 * 覆盖：saved 无重跑按钮 / pending（draft）仍可重跑并渲染结果 / 徽章文案复用采纳块键。
 *
 * B9（回读）：挂载即用 `readLatestGateRunGroup(ledger, { intent: main-control-rerun })`
 * 恢复上一次重跑结论（页签切回来不蒸发），并与「本次运行」明确区分（账本时间 +
 * `evidenceTs` 对账标「本次运行」）。
 * RVF-11：`evidenceRecorded` / `evidenceError` 必须出现在渲染面上（不是死返回）。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { RunEventInput, RunEventLedger, RunEventLedgerStoreDeps } from "@/lib/novel"

const listChapterDrafts = vi.fn(async (): Promise<unknown[]> => [])
const rerunMainControlGates = vi.fn()
const readFile = vi.fn(async (_path: string): Promise<string | null> => null)

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return { ...actual, listChapterDrafts, rerunMainControlGates }
})

// 缺省 deps（生产装载器）落盘读取边界：只替换 fs 原语，账本解析用真实现。
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile }
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
// 账本原语经 barrel（mock 已 spread actual）动态引入——静态 import 会早于 vi.mock 工厂执行
const { appendRunEvents, createRunEventLedger } = await import("@/lib/novel")

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

const GATE_TRIPLE = ["consistency", "anti_ai", "quality"] as const

/** 一次 main-control-rerun 写入的三条 gate-run 事件（同一 ts = 同一次运行）。 */
function rerunGroup(
  ts: string,
  statuses: Record<(typeof GATE_TRIPLE)[number], "pass" | "fail" | "skipped">,
): RunEventInput[] {
  return GATE_TRIPLE.map((gate, index) => ({
    seq: index,
    eventId: `gate-run:${index}:${gate}`,
    ts,
    kind: "gate-run" as const,
    actor: "system" as const,
    chapterId: 3,
    evidenceRefs: ["chapter:3", "intent:main-control-rerun"],
    payload: { gate, status: statuses[gate], findingsCount: 0 },
  }))
}

function ledgerWith(events: readonly RunEventInput[]): RunEventLedger {
  return appendRunEvents(createRunEventLedger(), events)
}

/** 账本文件内容（JSONL；与 run-event-ledger-store 落盘格式一致）。 */
function toLedgerText(events: readonly RunEventInput[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n"
}

// 可变的账本文件内容 + 稳定的 deps 对象（稳定引用避免 effect 反复触发）
let ledgerFileText: string | null = null
const memoryDeps: RunEventLedgerStoreDeps = {
  readText: async () => ledgerFileText,
  appendText: async () => {},
  ensureDir: async () => {},
}
const failingDeps: RunEventLedgerStoreDeps = {
  readText: async () => {
    throw new Error("no-fs")
  },
  appendText: async () => {},
  ensureDir: async () => {},
}

beforeEach(() => {
  ledgerFileText = null
})

afterEach(() => {
  cleanup()
  ledgerFileText = null
  listChapterDrafts.mockReset()
  listChapterDrafts.mockResolvedValue([])
  rerunMainControlGates.mockReset()
  readFile.mockReset()
  readFile.mockResolvedValue(null)
})

describe("MainControlGateRerunBlock（F17：saved 草稿不可重跑）", () => {
  it("status=saved 的草稿不出现在可重跑列表（无重跑按钮，且不触发重跑）", async () => {
    listChapterDrafts.mockResolvedValue([SAVED_DRAFT])
    render(<MainControlGateRerunBlock projectPath="/proj" ledger={null} />)

    // 行仍在（可见已落库），但不再提供重跑入口。
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-row-draft_9_saved")).toBeTruthy())
    expect(screen.queryByTestId("main-control-gate-rerun-draft_9_saved")).toBeNull()
    expect(screen.queryAllByRole("button")).toHaveLength(0)
    expect(rerunMainControlGates).not.toHaveBeenCalled()
  })

  it("pending（draft）草稿仍可重跑，并渲染三门结果", async () => {
    listChapterDrafts.mockResolvedValue([PENDING_DRAFT])
    rerunMainControlGates.mockResolvedValue(okResult(PENDING_DRAFT.id))
    render(<MainControlGateRerunBlock projectPath="/proj" ledger={null} />)

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
    render(<MainControlGateRerunBlock projectPath="/proj" ledger={null} />)

    const badge = await waitFor(() => screen.getByTestId("main-control-gate-rerun-saved-draft_9_saved"))
    expect(badge.textContent).toContain("已写入正式章")
    expect(badge.textContent).not.toContain("mainControl.draftSavedAlready")

    // 同一列表内：saved 无按钮，pending 有按钮。
    expect(screen.queryByTestId("main-control-gate-rerun-draft_9_saved")).toBeNull()
    expect(screen.getByTestId("main-control-gate-rerun-draft_1_abc")).toBeTruthy()
  })
})

describe("MainControlGateRerunBlock（B9：结论落账后可回读 / RVF-11：落账结果可见）", () => {
  it("挂载即回读上一次 main-control-rerun 的结论（历史面 + 账本时间 + 逐门状态）", async () => {
    const ledger = ledgerWith(rerunGroup("2026-10-18T00:10:00.000Z", {
      consistency: "fail",
      anti_ai: "pass",
      quality: "skipped",
    }))
    render(<MainControlGateRerunBlock projectPath="/proj" ledger={ledger} />)

    const history = await waitFor(() => screen.getByTestId("main-control-gate-rerun-history"))
    // 账本时间可见（切页签回来能确定「这是哪次运行」）
    expect(history.textContent).toContain("2026-10-18 00:10:00Z")
    expect(screen.getByTestId("main-control-gate-history-row-consistency").textContent).toContain("未通过")
    expect(screen.getByTestId("main-control-gate-history-row-anti_ai").textContent).toContain("通过")
    // 未评估门仍呈现「未评估」，绝不因「历史」而渲染成通过
    expect(screen.getByTestId("main-control-gate-history-row-quality").textContent).toContain("未评估")
    // 没有本次运行 → 无本次结果块，历史块也不该冒充「本次运行」
    expect(screen.queryByTestId("main-control-gate-rerun-result")).toBeNull()
    expect(screen.queryByTestId("main-control-gate-rerun-history-current")).toBeNull()
  })

  it("经 deps 从账本装载（生产挂载路径）同样能回读", async () => {
    ledgerFileText = toLedgerText(rerunGroup("2026-10-18T00:10:00.000Z", {
      consistency: "pass",
      anti_ai: "pass",
      quality: "pass",
    }))
    render(<MainControlGateRerunBlock projectPath="/proj" deps={memoryDeps} />)
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-history")).toBeTruthy())
    expect(screen.getByTestId("main-control-gate-history-row-consistency").textContent).toContain("通过")
  })

  it("账本不可读 → 历史面诚实缺失（不臆造历史结论，也不影响重跑）", async () => {
    render(<MainControlGateRerunBlock projectPath="/proj" deps={failingDeps} />)
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-history-error")).toBeTruthy())
    expect(screen.queryByTestId("main-control-gate-rerun-history")).toBeNull()
    expect(screen.getByTestId("main-control-gate-rerun-history-error").textContent).toContain("no-fs")
  })

  it("RVF-11：落账成功渲染「已落账（N 门）」，且历史块标「本次运行」（evidenceTs 对账）", async () => {
    const ts = "2026-10-18T00:10:00.000Z"
    ledgerFileText = toLedgerText(rerunGroup(ts, { consistency: "pass", anti_ai: "skipped", quality: "pass" }))
    listChapterDrafts.mockResolvedValue([PENDING_DRAFT])
    rerunMainControlGates.mockResolvedValue({
      ...okResult(PENDING_DRAFT.id),
      evidenceRecorded: ["consistency", "anti_ai", "quality"],
      evidenceTs: ts,
    })
    render(<MainControlGateRerunBlock projectPath="/proj" deps={memoryDeps} />)

    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-draft_1_abc")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-gate-rerun-draft_1_abc"))

    const recorded = await waitFor(() => screen.getByTestId("main-control-gate-rerun-evidence-recorded"))
    expect(recorded.textContent).toContain("已落账（3 门）")
    expect(recorded.textContent).not.toContain("mainControl.draftGateRerunEvidenceRecorded")
    // 本次运行块有明确标题
    expect(screen.getByTestId("main-control-gate-rerun-result-label").textContent).toContain("本次运行")
    // 历史块存在且被标记为「本次运行」（账本里那批 ts 与本次落账对得上）
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-history-current")).toBeTruthy())
    expect(screen.getByTestId("main-control-gate-rerun-history-current").textContent).toContain("本次运行")
  })

  it("历史记录与本次运行不是同一批 → 不标「本次运行」（用户可区分本次 vs 历史）", async () => {
    ledgerFileText = toLedgerText(rerunGroup("2026-10-18T00:10:00.000Z", {
      consistency: "fail",
      anti_ai: "fail",
      quality: "fail",
    }))
    listChapterDrafts.mockResolvedValue([PENDING_DRAFT])
    rerunMainControlGates.mockResolvedValue({
      ...okResult(PENDING_DRAFT.id),
      evidenceRecorded: ["consistency", "anti_ai", "quality"],
      evidenceTs: "2026-10-18T00:20:00.000Z",
    })
    render(<MainControlGateRerunBlock projectPath="/proj" deps={memoryDeps} />)

    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-draft_1_abc")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-gate-rerun-draft_1_abc"))

    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-history")).toBeTruthy())
    // 历史块仍是账本里那批（00:10），本次是 00:20 → 不得混标
    expect(screen.getByTestId("main-control-gate-rerun-history").textContent).toContain("2026-10-18 00:10:00Z")
    expect(screen.queryByTestId("main-control-gate-rerun-history-current")).toBeNull()
  })

  it("RVF-11：落账失败渲染原因（结论仍有效，只是不可回读）", async () => {
    listChapterDrafts.mockResolvedValue([PENDING_DRAFT])
    rerunMainControlGates.mockResolvedValue({
      ...okResult(PENDING_DRAFT.id),
      evidenceRecorded: ["consistency", "anti_ai", "quality"],
      evidenceError: "disk-full",
    })
    render(<MainControlGateRerunBlock projectPath="/proj" deps={failingDeps} />)

    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-draft_1_abc")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-gate-rerun-draft_1_abc"))

    const failure = await waitFor(() => screen.getByTestId("main-control-gate-rerun-evidence-error"))
    expect(failure.textContent).toContain("落账失败")
    expect(failure.textContent).toContain("disk-full")
    expect(screen.queryByTestId("main-control-gate-rerun-evidence-recorded")).toBeNull()
    // 本次结论仍在渲染面（落账失败不影响复核结论）
    expect(screen.getByTestId("main-control-gate-row-consistency")).toBeTruthy()
  })

  it("账本里没有 main-control-rerun 记录 → 不渲染历史块（不伪造历史）", async () => {
    ledgerFileText = null
    render(<MainControlGateRerunBlock projectPath="/proj" deps={memoryDeps} />)
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-empty")).toBeTruthy())
    expect(screen.queryByTestId("main-control-gate-rerun-history")).toBeNull()
  })
})

/**
 * 错误面与竞态守卫（可达路径）：
 * 无项目路径不读草稿/不读账本；列草稿失败要有人话文案；
 * 换项目时旧请求（成功或失败）晚到都不得污染新项目的状态面。
 */
describe("MainControlGateRerunBlock 错误面与竞态守卫", () => {
  it("没有项目路径：不列草稿也不读账本，呈现空态且历史面为空", async () => {
    render(<MainControlGateRerunBlock projectPath="" />)
    expect(await screen.findByTestId("main-control-gate-rerun-empty")).toBeTruthy()
    expect(listChapterDrafts).not.toHaveBeenCalled()
    // 无项目 = 不读磁盘：既不渲染历史块，也不报账本错误（不把「没读」说成「读坏」）
    expect(screen.queryByTestId("main-control-gate-rerun-history")).toBeNull()
    expect(screen.queryByTestId("main-control-gate-rerun-history-error")).toBeNull()
  })

  it("列草稿失败：把原因显示为状态文案（不静默吞错）", async () => {
    listChapterDrafts.mockRejectedValue(new Error("drafts unreadable"))
    render(<MainControlGateRerunBlock projectPath="/proj" ledger={null} />)

    const note = await waitFor(() => screen.getByTestId("main-control-gate-rerun-note"))
    expect(note.textContent).toContain("drafts unreadable")
    expect(screen.queryByTestId("main-control-gate-rerun-draft_1_abc")).toBeNull()
  })

  it("换项目后旧项目的草稿成功晚到：不覆盖新项目的空列表（cancelled 守卫）", async () => {
    let resolveOld!: (rows: unknown[]) => void
    const oldPending = new Promise<unknown[]>((resolve) => {
      resolveOld = resolve
    })
    listChapterDrafts.mockImplementationOnce(() => oldPending).mockResolvedValueOnce([])

    const { rerender } = render(<MainControlGateRerunBlock projectPath="/proj-a" ledger={null} />)
    await waitFor(() => expect(listChapterDrafts).toHaveBeenCalledTimes(1))

    rerender(<MainControlGateRerunBlock projectPath="/proj-b" ledger={null} />)
    await waitFor(() => expect(listChapterDrafts).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId("main-control-gate-rerun-empty")).toBeTruthy()

    // 旧项目的草稿此刻才回来 → 必须丢弃，不能挂到新项目下面
    resolveOld([PENDING_DRAFT])
    await act(async () => {})
    expect(screen.queryByTestId("main-control-gate-rerun-row-draft_1_abc")).toBeNull()
    expect(screen.getByTestId("main-control-gate-rerun-empty")).toBeTruthy()
  })

  it("换项目后旧项目的草稿失败晚到：不覆盖新项目的状态面（cancelled 守卫）", async () => {
    let rejectOld!: (error: unknown) => void
    const oldPending = new Promise<unknown[]>((_, reject) => {
      rejectOld = reject
    })
    listChapterDrafts.mockImplementationOnce(() => oldPending).mockResolvedValueOnce([])

    const { rerender } = render(<MainControlGateRerunBlock projectPath="/proj-a" ledger={null} />)
    await waitFor(() => expect(listChapterDrafts).toHaveBeenCalledTimes(1))

    rerender(<MainControlGateRerunBlock projectPath="/proj-b" ledger={null} />)
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-empty")).toBeTruthy())

    rejectOld(new Error("旧项目草稿读取失败"))
    await act(async () => {})
    expect(screen.queryByTestId("main-control-gate-rerun-note")).toBeNull()
  })

  it("换项目后旧账本读取失败晚到：不污染新项目的历史面（cancelled 守卫）", async () => {
    let rejectOld!: (error: unknown) => void
    const firstRead = new Promise<string | null>((_, reject) => {
      rejectOld = reject
    })
    const newLedger = toLedgerText(
      rerunGroup("2026-10-18T00:10:00.000Z", { consistency: "pass", anti_ai: "pass", quality: "pass" }),
    )
    const reads: Array<Promise<string | null>> = [firstRead, Promise.resolve(newLedger)]
    let readCalls = 0
    const deps: RunEventLedgerStoreDeps = {
      readText: () => {
        const next = reads[readCalls] ?? Promise.resolve(null)
        readCalls += 1
        return next
      },
      appendText: async () => {},
      ensureDir: async () => {},
    }

    const { rerender } = render(<MainControlGateRerunBlock projectPath="/proj-a" deps={deps} />)
    await waitFor(() => expect(readCalls).toBe(1))

    rerender(<MainControlGateRerunBlock projectPath="/proj-b" deps={deps} />)
    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-history")).toBeTruthy())
    expect(screen.getByTestId("main-control-gate-rerun-history").textContent).toContain("2026-10-18 00:10:00Z")

    // 旧项目的账本失败此刻才到达 → 必须丢弃：新项目的历史面不得被降级成错误态
    rejectOld(new Error("旧项目账本损坏"))
    await act(async () => {})
    expect(screen.queryByTestId("main-control-gate-rerun-history-error")).toBeNull()
    expect(screen.getByTestId("main-control-gate-rerun-history")).toBeTruthy()
  })
})

describe("MainControlGateRerunBlock 重跑结果降级提示与默认 deps", () => {
  it("重跑失败：文案带原因，且不渲染结果块（失败不假装有结论）", async () => {
    listChapterDrafts.mockResolvedValue([PENDING_DRAFT])
    rerunMainControlGates.mockRejectedValue(new Error("gate engine down"))
    render(<MainControlGateRerunBlock projectPath="/proj" ledger={null} />)

    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-draft_1_abc")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-gate-rerun-draft_1_abc"))

    const note = await waitFor(() => screen.getByTestId("main-control-gate-rerun-note"))
    expect(note.textContent).toContain("门控重跑失败")
    expect(note.textContent).toContain("gate engine down")
    expect(screen.queryByTestId("main-control-gate-rerun-result")).toBeNull()
    // 失败后可重试：按钮不再是 disabled
    expect((screen.getByTestId("main-control-gate-rerun-draft_1_abc") as HTMLButtonElement).disabled).toBe(false)
  })

  it("失败门标破坏色；未开审稿与契约未评估各给显式提示（绝不渲染成通过）", async () => {
    listChapterDrafts.mockResolvedValue([PENDING_DRAFT])
    rerunMainControlGates.mockResolvedValue({
      ...okResult(PENDING_DRAFT.id),
      rows: [
        { key: "consistency", status: "pass", verdict: "pass", findings: 0 },
        { key: "anti_ai", status: "fail", verdict: "fail", findings: 2 },
        { key: "quality", status: "skipped", verdict: "pending", findings: 0 },
      ],
      overall: "fail",
      llmMediated: false,
      contractEvaluated: false,
    })
    render(<MainControlGateRerunBlock projectPath="/proj" ledger={null} />)

    await waitFor(() => expect(screen.getByTestId("main-control-gate-rerun-draft_1_abc")).toBeTruthy())
    fireEvent.click(screen.getByTestId("main-control-gate-rerun-draft_1_abc"))

    const failRow = await waitFor(() => screen.getByTestId("main-control-gate-row-anti_ai"))
    expect(failRow.textContent).toContain("未通过")
    expect(failRow.querySelector(".text-destructive")).toBeTruthy()
    // 通过门与未评估门各自的呈现不得互相污染
    expect(screen.getByTestId("main-control-gate-row-consistency").querySelector(".text-success")).toBeTruthy()
    expect(screen.getByTestId("main-control-gate-row-quality").textContent).toContain("未评估")
    // 两个「未评估/未接入」的降级面必须显式出现
    expect(screen.getByTestId("main-control-gate-rerun-no-review").textContent).toContain("关闭 AI 审稿")
    expect(screen.getByTestId("main-control-gate-rerun-contract").textContent).toContain("契约维度未评估")
  })

  it("缺省 deps 走生产 fs 装载器：从项目 .novel/run-events.jsonl 回读历史", async () => {
    readFile.mockResolvedValue(
      toLedgerText(rerunGroup("2026-10-18T00:10:00.000Z", { consistency: "pass", anti_ai: "pass", quality: "fail" })),
    )
    render(<MainControlGateRerunBlock projectPath="/proj" />)

    const history = await waitFor(() => screen.getByTestId("main-control-gate-rerun-history"))
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining(".novel/run-events.jsonl"))
    expect(history.textContent).toContain("2026-10-18 00:10:00Z")
    expect(screen.getByTestId("main-control-gate-history-row-quality").textContent).toContain("未通过")
  })
})
