// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { render, screen } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"

afterEach(cleanup)
import userEvent from "@testing-library/user-event"
import type { ContextPack } from "@/lib/novel/context-engine"
import { buildPackReplay, ContextPackReplayPanel } from "./context-pack-replay-panel"

function pack(o: Partial<ContextPack> = {}): ContextPack {
  const base = {
    task: "生成第 3 章正文",
    chapterGoal: "主角突破封印",
    outline: "大纲内容",
    recentChapterContents: ["上一节正文"],
    recentSummaries: ["上一节摘要"],
    previousChapterEnding: "雨夜，主角推开旧宅大门。",
    characterStates: "林晚秋：灵力七成",
    soulDoc: "soul",
    characterAuras: "aura",
    cognitionStates: "认知",
    foreshadowingStates: "伏笔",
    timeline: "第三日黄昏",
    relatedSettings: "镇妖司设定",
    canonRules: "正典规则：妖物不可越界",
    writingStyle: "文风：冷峻",
    searchResults: "检索到设定页A;设定页B",
    graphSearchResults: "图谱：林晚秋-鬼灯往来",
    mustDo: "保留悬念",
    mustAvoid: "不要提前揭晓",
    nextChapterAdvice: "",
    revisionDirectives: "",
    gaps: [],
    styleExemplars: [],
    activeEntities: [],
    sourceTimingsMs: { wiki: 1, canon: 2, technique: 3 },
  } as ContextPack
  return { ...base, ...o }
}
describe("buildPackReplay (pure derivation)", () => {
  it("null/undefined pack yields empty safe replay", () => {
    expect(buildPackReplay(null)).toEqual({
      sources: [], gates: [], hasGaps: false, gapNotes: [], usage: null, assemblyExcerpt: "",
    })
  })

  it("marks full core sources as PASS gates and selected sources", () => {
    const r = buildPackReplay(pack())
    expect(r.gates.find((g) => g.key === "consistency")?.status).toBe("PASS")
    expect(r.gates.find((g) => g.key === "anti_ai")?.status).toBe("PASS")
    expect(r.sources.find((s) => s.key === "searchResults")?.selected).toBe(true)
    expect(r.sources.find((s) => s.key === "references")?.selected).toBe(false)
  })

  it("WARNs consistency gate when a core consistency source is missing", () => {
    const r = buildPackReplay(pack({ timeline: "", canonRules: "" }))
    expect(r.gates.find((g) => g.key === "consistency")?.status).toBe("WARN")
  })

  it("WARNs anti-ai gate when no style signature is injected", () => {
    const r = buildPackReplay(pack({ writingStyle: "", voiceStyleGuide: undefined }))
    expect(r.gates.find((g) => g.key === "anti_ai")?.status).toBe("WARN")
  })

  it("records gaps transparently (IC-02)", () => {
    const r = buildPackReplay(pack({
      gaps: [{ type: "truncated", ref: "timeline", reason: "budget_exceeded", originalLength: 100, retainedLength: 40 }],
    }))
    expect(r.hasGaps).toBe(true)
    expect(r.gapNotes[0]).toContain("truncated")
  })

  it("surfaces contextUsage when present", () => {
    const r = buildPackReplay(pack({
      contextUsage: { memoryChars: 10, retrievalChars: 20, graphChars: 30, bodyChars: 40, otherChars: 50, maxCtx: 1000 },
    }))
    expect(r.usage?.bodyChars).toBe(40)
  })
})

describe("ContextPackReplayPanel (render + interaction)", () => {
  it("renders empty data safely for null pack", () => {
    render(<ContextPackReplayPanel pack={null} />)
    expect(screen.getByTestId("context-pack-replay-panel")).toBeInTheDocument()
    expect(screen.getByText(/无 ContextPack 数据/)).toBeInTheDocument()
  })

  it("renders source rows with selected/unselected badges", () => {
    render(<ContextPackReplayPanel pack={pack()} />)
    expect(screen.getByText("全文检索 searchResults")).toBeInTheDocument()
    expect(screen.getByText("@ 引用检索 references")).toBeInTheDocument()
    expect(screen.getByTestId("gate-consistency")).toHaveTextContent("PASS")
    expect(screen.getByTestId("gate-anti_ai")).toHaveTextContent("PASS")
  })

  it("collapsed by default, expands source detail on click (user-event accordion)", async () => {
    const user = userEvent.setup()
    render(<ContextPackReplayPanel pack={pack()} />)
    const detail = screen.getByTestId("source-searchResults")
    expect(detail).not.toHaveAttribute("open") // details: 默认折叠
    await user.click(screen.getByTestId("source-toggle-searchResults"))
    expect(detail).toHaveAttribute("open")
    expect(screen.getByTestId("gate-consistency")).toBeInTheDocument()
  })

  it("UAT C6-2 长文本加固：源详情与组装节选容器携带 break-words", () => {
    const { container } = render(<ContextPackReplayPanel pack={pack({ chapterGoal: "x".repeat(500) })} />)
    const detail = container.querySelector<HTMLDetailsElement>('[data-testid="source-searchResults"]')!
    detail.open = true
    expect(container.querySelector('[data-source-detail="searchResults"]')).toHaveClass("break-words")
    const pre = container.querySelector("pre")
    expect(pre).toBeTruthy()
    expect(pre).toHaveClass("break-words")
    expect(pre!.textContent!.length).toBeGreaterThan(0)
  })
})