// @vitest-environment jsdom
/**
 * W4E5 coverage campaign — InspectorPanel 全口径 100%（原 SSR spec 无法覆盖交互）。
 * jsdom + fake timers 驱动防抖展开/收起/刷新/重试/分块渲染/状态徽标 tone 全枚举。
 * 分块默认收起 → 断言前先点击分块标题展开；混合文本节点用 textContent 断言。
 */
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils"
import { InspectorPanel } from "./inspector-panel"
import type { InspectorSnapshot } from "@/lib/novel/inspector-query"

const queryMocks = vi.hoisted(() => ({
  queryInspectorState: vi.fn(async (): Promise<InspectorSnapshot | null> => null),
}))

vi.mock("@/lib/novel/inspector-query", () => ({
  queryInspectorState: queryMocks.queryInspectorState,
}))

const storeMocks = vi.hoisted(() => ({
  state: {
    novelConfig: { inspectorEnabled: true as boolean },
  },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (state: typeof storeMocks.state) => unknown) => selector(storeMocks.state),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, opts?: Record<string, unknown>) =>
      fallback.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(opts?.[k] ?? "")),
  }),
}))

function fullSnapshot(overrides: Partial<InspectorSnapshot> = {}): InspectorSnapshot {
  return {
    cognitionState: {
      characters: [{ name: "Alice", knows: ["秘密"], doesNotKnow: ["真相"] }],
      readerKnows: ["秘密"],
      lastUpdatedChapter: 3,
    },
    draft: {
      draftId: "conv-1",
      filePath: "/P/.novel/drafts/conv-1.json",
      draftStatus: "ready",
      contentPreview: "预览正文",
      updatedAt: "2026-07-10T01:00:00.000Z",
    },
    contextPack: { cognitionSummary: "1 个角色", characterCount: 1, readerKnowsCount: 1 },
    scene: { sceneCount: 2, sceneTitles: ["场景A", "场景B"] },
    review: {
      findings: [
        {
          dimensionKey: "thrill",
          dimensionLabel: "爽感密度",
          score: 90,
          status: "pass",
          summary: "通过",
          messages: ["m1", "m2", "m3", "m4", "m5", "m6", "m7"],
          evidences: [],
        },
      ],
      reviewedAt: "2026-07-10T01:00:00.000Z",
    },
    decision: {
      consistency: { status: "pending", verdict: "pending" },
      anti_ai: { status: "pending", verdict: "pending" },
      quality: { status: "pending", verdict: "pending" },
      overall: "pending",
    },
    cachedAt: "2026-07-10T01:00:00.000Z",
    isStale: false,
    deAiSlopHits: [{ word: "very", count: 3 }],
    ...overrides,
  }
}

function expectBodyText(text: string): void {
  expect(document.body.textContent).toContain(text)
}

function openSection(name: string): void {
  const toggle = screen.getByRole("button", { name: new RegExp(name) })
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle)
}

/** 展开面板并等待防抖 fetch 完成。 */
async function expandAndFetch(snapshot: InspectorSnapshot | null): Promise<void> {
  queryMocks.queryInspectorState.mockResolvedValue(snapshot)
  render(<InspectorPanel projectPath="/P" chapterId="chapter-1" />)
  fireEvent.click(screen.getByRole("button", { name: "展开 Inspector" }))
  await waitFor(() => expect(queryMocks.queryInspectorState).toHaveBeenCalledWith("/P", "chapter-1"))
}

function badgeToneMap(container: HTMLElement): Record<string, string> {
  const map: Record<string, string> = {}
  container.querySelectorAll("span.font-mono").forEach((el) => {
    map[el.textContent ?? ""] = el.className
  })
  return map
}

beforeEach(() => {
  queryMocks.queryInspectorState.mockReset()
  storeMocks.state.novelConfig.inspectorEnabled = true
  setupDomGlobals()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe("InspectorPanel — 启用/收起/展开", () => {
  it("inspectorEnabled=false 时不渲染任何内容", () => {
    storeMocks.state.novelConfig.inspectorEnabled = false
    const { container } = render(<InspectorPanel projectPath="/P" chapterId="c1" />)
    expect(container.firstChild).toBeNull()
  })

  it("默认收起：只渲染展开按钮，不触发查询", () => {
    render(<InspectorPanel projectPath="/P" chapterId="c1" />)
    const btn = screen.getByRole("button", { name: "展开 Inspector" })
    expect(btn.getAttribute("aria-expanded")).toBe("false")
    expect(queryMocks.queryInspectorState).not.toHaveBeenCalled()
  })

  it("点击展开 → 收起按钮 + 防抖后触发查询", async () => {
    queryMocks.queryInspectorState.mockResolvedValue(fullSnapshot())
    render(<InspectorPanel projectPath="/P" chapterId="c1" />)
    fireEvent.click(screen.getByRole("button", { name: "展开 Inspector" }))
    // 防抖未到期前不查询
    expect(queryMocks.queryInspectorState).not.toHaveBeenCalled()
    await waitFor(() => expect(queryMocks.queryInspectorState).toHaveBeenCalledWith("/P", "c1"))
    expect(screen.getByRole("button", { name: "收起 Inspector" })).toBeTruthy()
  })

  it("展开后点击收起 → 回到收起视图且不再查询", async () => {
    queryMocks.queryInspectorState.mockResolvedValue(fullSnapshot())
    render(<InspectorPanel projectPath="/P" chapterId="c1" />)
    fireEvent.click(screen.getByRole("button", { name: "展开 Inspector" }))
    await waitFor(() => expect(queryMocks.queryInspectorState).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: "收起 Inspector" }))
    expect(screen.getByRole("button", { name: "展开 Inspector" })).toBeTruthy()
    const calls = queryMocks.queryInspectorState.mock.calls.length
    await act(async () => { await new Promise((r) => setTimeout(r, 600)) })
    expect(queryMocks.queryInspectorState.mock.calls.length).toBe(calls)
  })

  it("projectPath 为空时 fetchSnapshot 直接返回（不查询不 loading）", async () => {
    render(<InspectorPanel projectPath="" chapterId="c1" />)
    fireEvent.click(screen.getByRole("button", { name: "展开 Inspector" }))
    await act(async () => { await new Promise((r) => setTimeout(r, 600)) })
    expect(queryMocks.queryInspectorState).not.toHaveBeenCalled()
    expect(screen.getByText("暂无 Inspector 数据")).toBeTruthy()
  })
})

describe("InspectorPanel — 防抖（PAT-DC2）", () => {
  it("连续切换 refreshKey 只调度一次查询（500ms 防抖合并）", async () => {
    vi.useFakeTimers()
    queryMocks.queryInspectorState.mockResolvedValue(fullSnapshot())
    const { rerender } = render(<InspectorPanel projectPath="/P" chapterId="c1" refreshKey={0} />)
    fireEvent.click(screen.getByRole("button", { name: "展开 Inspector" }))
    // 300ms 处 refreshKey 变化 → 旧 timer 被清，重新调度
    act(() => { vi.advanceTimersByTime(300) })
    rerender(<InspectorPanel projectPath="/P" chapterId="c1" refreshKey={1} />)
    act(() => { vi.advanceTimersByTime(300) })
    expect(queryMocks.queryInspectorState).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(200) })
    expect(queryMocks.queryInspectorState).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it("挂载卸载时清理未决防抖 timer", async () => {
    vi.useFakeTimers()
    const { unmount } = render(<InspectorPanel projectPath="/P" chapterId="c1" />)
    fireEvent.click(screen.getByRole("button", { name: "展开 Inspector" }))
    unmount()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(queryMocks.queryInspectorState).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe("InspectorPanel — 数据状态（加载/错误/空）", () => {
  it("查询挂起时显示骨架屏 + loading 文本", async () => {
    let resolveQuery!: (v: InspectorSnapshot) => void
    queryMocks.queryInspectorState.mockImplementation(
      () => new Promise<InspectorSnapshot>((resolve) => { resolveQuery = resolve }),
    )
    render(<InspectorPanel projectPath="/P" chapterId="c1" />)
    fireEvent.click(screen.getByRole("button", { name: "展开 Inspector" }))
    await waitFor(() => expect(queryMocks.queryInspectorState).toHaveBeenCalled())
    expect(screen.getByText("加载中…")).toBeTruthy()
    expect(document.querySelectorAll(".animate-pulse")).toHaveLength(3)
    await act(async () => { resolveQuery(fullSnapshot()) })
    await waitFor(() => expect(screen.queryByText("加载中…")).toBeNull())
  })

  it("查询成功（null snapshot）→ 显示暂无数据", async () => {
    await expandAndFetch(null)
    expect(screen.getByText("暂无 Inspector 数据")).toBeTruthy()
  })

  it("查询抛 Error → 显示 err.message + 重试按钮", async () => {
    queryMocks.queryInspectorState.mockRejectedValue(new Error("query-boom"))
    render(<InspectorPanel projectPath="/P" chapterId="c1" />)
    fireEvent.click(screen.getByRole("button", { name: "展开 Inspector" }))
    await waitFor(() => expect(screen.getByText("query-boom")).toBeTruthy())
    expect(screen.getByRole("alert")).toBeTruthy()
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy()
  })

  it("查询抛非 Error → 用 t fallback 文案", async () => {
    queryMocks.queryInspectorState.mockRejectedValue("plain")
    render(<InspectorPanel projectPath="/P" chapterId="c1" />)
    fireEvent.click(screen.getByRole("button", { name: "展开 Inspector" }))
    await waitFor(() => expect(screen.getByText("查询失败")).toBeTruthy())
  })

  it("刷新请求挂起时图标进入 animate-spin 状态", async () => {
    let resolveRefresh!: (value: InspectorSnapshot) => void
    queryMocks.queryInspectorState
      .mockResolvedValueOnce(fullSnapshot())
      .mockImplementationOnce(() => new Promise<InspectorSnapshot>((resolve) => {
        resolveRefresh = resolve
      }))
    render(<InspectorPanel projectPath="/P" chapterId="c1" />)
    fireEvent.click(screen.getByRole("button", { name: "展开 Inspector" }))
    await waitFor(() => expect(queryMocks.queryInspectorState).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "刷新" }))
    const refreshButton = screen.getByRole("button", { name: "刷新" })
    expect(refreshButton.querySelector("svg")?.getAttribute("class")).toContain("animate-spin")
    resolveRefresh(fullSnapshot())
    await waitFor(() => expect(screen.getByText("认知状态")).toBeTruthy())
  })

  it("重试按钮直接重新查询并清掉错误", async () => {
    queryMocks.queryInspectorState
      .mockRejectedValueOnce(new Error("once"))
      .mockResolvedValueOnce(fullSnapshot())
    render(<InspectorPanel projectPath="/P" chapterId="c1" />)
    fireEvent.click(screen.getByRole("button", { name: "展开 Inspector" }))
    await waitFor(() => expect(screen.getByText("once")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "重试" }))
    await waitFor(() => expect(screen.queryByText("once")).toBeNull())
    expect(screen.getByText("认知状态")).toBeTruthy()
  })

  it("刷新按钮直接重新查询", async () => {
    queryMocks.queryInspectorState.mockResolvedValue(fullSnapshot())
    render(<InspectorPanel projectPath="/P" chapterId="c1" />)
    fireEvent.click(screen.getByRole("button", { name: "展开 Inspector" }))
    await waitFor(() => expect(queryMocks.queryInspectorState).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "刷新" }))
    await waitFor(() => expect(queryMocks.queryInspectorState).toHaveBeenCalledTimes(2))
  })

  it("isStale=true → 灰显 + 修复中提示 + data-stale", async () => {
    await expandAndFetch(fullSnapshot({ isStale: true }))
    const panel = document.querySelector(".inspector-panel") as HTMLElement
    expect(panel.getAttribute("data-stale")).toBe("true")
    expect(panel.className).toContain("opacity-50")
    expect(panel.className).toContain("saturate-0")
    expect(screen.getByText("草稿已变更，审查缓存可能过期")).toBeTruthy()
  })

  it("isStale=false → 无灰显无提示", async () => {
    await expandAndFetch(fullSnapshot())
    const panel = document.querySelector(".inspector-panel") as HTMLElement
    expect(panel.getAttribute("data-stale")).toBe("false")
    expect(screen.queryByText("草稿已变更，审查缓存可能过期")).toBeNull()
  })
})

describe("InspectorPanel — 分块渲染", () => {
  it("认知状态：角色 knows/doesNotKnow、readerKnows、lastUpdatedChapter", async () => {
    await expandAndFetch(fullSnapshot())
    openSection("认知状态")
    expect(screen.getByText("Alice")).toBeTruthy()
    expectBodyText("知道：秘密")
    expectBodyText("不知道：真相")
    expectBodyText("读者知道：秘密")
    expectBodyText("最后更新章：3")
  })

  it("认知状态：空角色 → 无角色认知；空 readerKnows/lastUpdated 不渲染", async () => {
    const snap = fullSnapshot()
    snap.cognitionState = { characters: [], readerKnows: [], lastUpdatedChapter: null }
    await expandAndFetch(snap)
    openSection("认知状态")
    expect(screen.getByText("无角色认知")).toBeTruthy()
    expect(screen.queryByText(/读者知道/)).toBeNull()
    expect(screen.queryByText(/最后更新章/)).toBeNull()
  })

  it("草稿分块默认展开：ID/状态/路径/更新/预览 details", async () => {
    await expandAndFetch(fullSnapshot())
    expectBodyText("草稿ID：conv-1")
    expectBodyText("状态：ready")
    expectBodyText("路径：/P/.novel/drafts/conv-1.json")
    expectBodyText("更新：2026-07-10T01:00:00.000Z")
    const summary = screen.getByText("预览（前 4 字）")
    expect(summary.tagName).toBe("SUMMARY")
    expect(screen.getByText("预览正文")).toBeTruthy()
  })

  it("草稿空字段 → 占位符 —；无 contentPreview 不渲染 details", async () => {
    const snap = fullSnapshot()
    snap.draft = { draftId: "", filePath: "", draftStatus: "pending", contentPreview: "", updatedAt: "" }
    await expandAndFetch(snap)
    expectBodyText("草稿ID：—")
    expectBodyText("路径：—")
    expectBodyText("更新：—")
    expect(screen.queryByText(/预览（前/)).toBeNull()
  })

  it("contextPack：角色数>0 显示摘要；=0 显示无角色认知", async () => {
    await expandAndFetch(fullSnapshot())
    openSection("上下文包")
    expect(screen.getByText("1 个角色")).toBeTruthy()
    expectBodyText("角色数：1")
    expectBodyText("读者已知：1")
  })

  it("contextPack：角色数为 0 → 无角色认知 + 计数渲染", async () => {
    await expandAndFetch(
      fullSnapshot({ contextPack: { cognitionSummary: "", characterCount: 0, readerKnowsCount: 0 } }),
    )
    openSection("上下文包")
    expect(screen.getByText("无角色认知")).toBeTruthy()
    expectBodyText("角色数：0")
  })

  it("scene：sceneTitles 非空渲染列表", async () => {
    await expandAndFetch(fullSnapshot())
    openSection("场景")
    expectBodyText("场景数：2")
    expect(screen.getByText("场景A")).toBeTruthy()
    expect(screen.getByText("场景B")).toBeTruthy()
  })

  it("scene：sceneTitles 为空不渲染列表", async () => {
    await expandAndFetch(fullSnapshot({ scene: { sceneCount: 0, sceneTitles: [] } }))
    openSection("场景")
    expectBodyText("场景数：0")
    expect(screen.queryByText("场景A")).toBeNull()
  })

  it("review：无 findings → 无缓存审查发现；无 reviewedAt 不渲染缓存于", async () => {
    const snap = fullSnapshot()
    snap.review = { findings: [], reviewedAt: null }
    await expandAndFetch(snap)
    openSection("审查")
    expect(screen.getByText("无缓存审查发现")).toBeTruthy()
    expect(screen.queryByText(/缓存于/)).toBeNull()
  })

  it("review：findings 消息 ≤5 不显示更多条；无 summary 不渲染", async () => {
    const snap = fullSnapshot()
    snap.review = {
      findings: [
        { dimensionKey: "pacing", dimensionLabel: "节奏", score: 60, status: "high", summary: "", messages: ["only-one"], evidences: [] },
      ],
      reviewedAt: null,
    }
    await expandAndFetch(snap)
    openSection("审查")
    expect(screen.getByText("only-one")).toBeTruthy()
    expect(screen.queryByText(/另有/)).toBeNull()
    expect(screen.queryByText("有摘要")).toBeNull()
  })

  it("review：findings 消息 >5 → 显示…另有 n 条 + 摘要 + 缓存于", async () => {
    const snap = fullSnapshot()
    snap.review.findings[0].messages = Array.from({ length: 7 }, (_, i) => `msg-${i}`)
    snap.review.findings[0].summary = "有摘要"
    await expandAndFetch(snap)
    openSection("审查")
    expect(screen.getByText("有摘要")).toBeTruthy()
    expect(screen.getByText("…另有 2 条")).toBeTruthy()
    expectBodyText("缓存于：2026-07-10T01:00:00.000Z")
    expect(screen.getByText("爽感密度")).toBeTruthy()
    expectBodyText("90/100")
  })

  it("deAiSlopHits 为空 → 无静态 slop 命中", async () => {
    await expandAndFetch(fullSnapshot({ deAiSlopHits: [] }))
    openSection("审查")
    expect(screen.getByText("无静态 slop 命中")).toBeTruthy()
  })

  it("deAiSlopHits >10 → 列表 + …其余 n 项", async () => {
    await expandAndFetch(
      fullSnapshot({
        deAiSlopHits: Array.from({ length: 12 }, (_, i) => ({ word: `w${i}`, count: i })),
      }),
    )
    openSection("审查")
    expect(screen.getByText("w0 ×0")).toBeTruthy()
    expect(screen.getByText("…及其余 2 项")).toBeTruthy()
  })

  it("deAiSlopHits ≤10 不显示其余项", async () => {
    await expandAndFetch(fullSnapshot({ deAiSlopHits: [{ word: "really", count: 2 }] }))
    openSection("审查")
    expect(screen.getByText("really ×2")).toBeTruthy()
    expect(screen.queryByText(/其余/)).toBeNull()
  })
})

describe("InspectorPanel — StatusBadge tone 全枚举", () => {
  it("阻断态 error/fail/high → destructive；警告态 warning/medium/manual_review → warning；中性 pending/low → muted；通过 pass/passed → success", async () => {
    const snap = fullSnapshot()
    snap.draft.draftStatus = "pending"
    snap.review.findings = [
      { dimensionKey: "thrill", dimensionLabel: "高", score: 30, status: "high", summary: "", messages: [], evidences: [] },
      { dimensionKey: "pacing", dimensionLabel: "中", score: 50, status: "medium", summary: "", messages: [], evidences: [] },
      { dimensionKey: "character", dimensionLabel: "未知", score: 0, status: "unknown", summary: "", messages: [], evidences: [] },
    ]
    snap.decision = {
      consistency: { status: "error", verdict: "fail" },
      anti_ai: { status: "warning", verdict: "manual_review" },
      quality: { status: "low", verdict: "passed" },
      overall: "pass",
    }
    await expandAndFetch(snap)
    openSection("审查")
    openSection("门控")

    const tones = badgeToneMap(document.body as HTMLElement)
    const expectTone = (status: string, cls: string) => {
      expect(tones[status]).toBeDefined()
      expect(tones[status]).toContain(cls)
    }
    expectTone("pending", "text-muted-foreground")
    expectTone("high", "text-destructive")
    expectTone("medium", "text-warning")
    expectTone("unknown", "text-muted-foreground")
    expectTone("error", "text-destructive")
    expectTone("fail", "text-destructive")
    expectTone("warning", "text-warning")
    expectTone("manual_review", "text-warning")
    expectTone("low", "text-muted-foreground")
    expectTone("passed", "text-success")
    expectTone("pass", "text-success")
  })

  it("门控块渲染：一致性/Anti-AI/质量/总览", async () => {
    const snap = fullSnapshot()
    snap.decision = {
      consistency: { status: "passed", verdict: "pass" },
      anti_ai: { status: "failed", verdict: "fail" },
      quality: { status: "medium", verdict: "warning" },
      overall: "warning",
    }
    await expandAndFetch(snap)
    openSection("门控")
    expectBodyText("一致性：")
    expectBodyText("Anti-AI：")
    expectBodyText("质量：")
    expectBodyText("总览：")
  })
})

describe("InspectorPanel — Section 折叠交互", () => {
  it("默认收起的分块点击展开/收起，aria-expanded 与 aria-controls 正确", async () => {
    await expandAndFetch(fullSnapshot())
    const toggle = screen.getByRole("button", { name: /认知状态/ })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(toggle.getAttribute("aria-controls")).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
  })

  it("defaultOpen 分块（草稿）初始展开", async () => {
    await expandAndFetch(fullSnapshot())
    const draftToggle = screen.getByRole("button", { name: /草稿/ })
    expect(draftToggle.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByRole("region", { name: "草稿" })).toBeTruthy()
  })

  it("展开的分块渲染 role=region 并带 aria-label", async () => {
    await expandAndFetch(fullSnapshot())
    fireEvent.click(screen.getByRole("button", { name: /认知状态/ }))
    const region = screen.getByRole("region", { name: "认知状态" })
    expect(region.id).toBeTruthy()
    expect(region.textContent).toContain("Alice")
  })
})
