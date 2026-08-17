import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  getFileModifiedTime: vi.fn(),
  loadNovelSessionStatus: vi.fn(),
  loadCognitionState: vi.fn(),
  getCachedDimensionResults: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: (...args: unknown[]) => mocks.readFile(...args),
  getFileModifiedTime: (...args: unknown[]) => mocks.getFileModifiedTime(...args),
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: (p: string) => p.replace(/\\/g, "/"),
}))

vi.mock("./novel-session-status", () => ({
  loadNovelSessionStatus: (...args: unknown[]) => mocks.loadNovelSessionStatus(...args),
}))

vi.mock("./character-cognition", () => ({
  loadCognitionState: (...args: unknown[]) => mocks.loadCognitionState(...args),
}))

vi.mock("./dimension-review-adapter", () => ({
  getCachedDimensionResults: (...args: unknown[]) => mocks.getCachedDimensionResults(...args),
  SIX_REVIEW_DIMENSIONS: {
    thrill: { label: "爽感密度" },
    consistency: { label: "设定自治" },
    pacing: { label: "节奏张力" },
    character: { label: "人设一致" },
    continuity: { label: "叙事衔接" },
    pull: { label: "追读引力" },
  },
}))

vi.mock("./de-ai-rules", () => ({
  CHINESE_NOVEL_DE_AI_RULES: "## 章节\n### 禁用词汇\n- 总之\n- 综上所述\n## 后续章节\n- 无关内容",
}))

import { queryInspectorState, type InspectorSnapshot } from "./inspector-query"

const pp = "E:/Novel"

function dimensionResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    dimensionKey: "thrill",
    score: 9.2,
    status: "high",
    summary: "爽点密集",
    thinking: "分析",
    issues: [
      { message: "打脸不够利落", evidence: "正文片段", severity: "warning", type: "thrill", dimensionKey: "thrill" },
    ],
    ...overrides,
  }
}

function statusOverrides(overrides: Record<string, unknown> = {}) {
  return {
    draft: {
      draft_id: "d1",
      file_path: `${pp}/.novel/drafts/d1.md`,
      draft_status: "ready",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    dimension_results: { thrill: dimensionResult() },
    updated_at: "2026-01-01T00:00:00.000Z",
    decision_gates: {
      consistency: { status: "pass", verdict: "通过" },
      anti_ai: { status: "pass", verdict: "通过" },
      quality: { status: "warning", verdict: "需改写" },
      overall: "blocked",
    },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadNovelSessionStatus.mockResolvedValue(null)
  mocks.loadCognitionState.mockResolvedValue(null)
  mocks.readFile.mockRejectedValue(new Error("ENOENT"))
  mocks.getFileModifiedTime.mockRejectedValue(new Error("ENOENT"))
  mocks.getCachedDimensionResults.mockImplementation((dimResults: unknown) =>
    dimResults ? [dimensionResult({ dimensionKey: "thrill" })] : [],
  )
})

describe("queryInspectorState", () => {
  it("builds a full snapshot: draft, cached review, cognition, scene, gates, slop scan", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue(statusOverrides())
    mocks.loadCognitionState.mockResolvedValue({
      characters: [
        { character: "白砚", knows: ["剑法"], doesNotKnow: ["身世"] },
      ],
      readerKnows: ["女主身份"],
      lastUpdatedChapter: 5,
    })
    mocks.readFile.mockResolvedValue("总之综上所述总之。\n" + "正".repeat(5000))
    mocks.getFileModifiedTime.mockResolvedValue(Date.parse("2026-01-02T00:00:00.000Z"))
    const sceneListProvider = vi.fn().mockResolvedValue(["开篇", "冲突"])

    const snap = await queryInspectorState(pp, "ch5", sceneListProvider)

    // draft block with truncated preview
    expect(snap.draft.draftId).toBe("d1")
    expect(snap.draft.draftStatus).toBe("ready")
    expect(snap.draft.contentPreview).toHaveLength(4001)
    expect(snap.draft.contentPreview.endsWith("…")).toBe(true)
    // review block from cached dimension results
    expect(snap.review.reviewedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(snap.review.findings).toHaveLength(1)
    expect(snap.review.findings[0]!.dimensionLabel).toBe("爽感密度")
    expect(snap.review.findings[0]!.messages).toEqual(["打脸不够利落"])
    expect(snap.review.findings[0]!.evidences).toEqual(["正文片段"])
    // cognition + contextPack blocks
    expect(snap.cognitionState.characters[0]!.knows).toEqual(["剑法"])
    expect(snap.cognitionState.lastUpdatedChapter).toBe(5)
    expect(snap.contextPack.characterCount).toBe(1)
    expect(snap.contextPack.readerKnowsCount).toBe(1)
    expect(snap.contextPack.cognitionSummary).toBe("1 角色 / 1 读者已知")
    // scene block from provider
    expect(snap.scene.sceneTitles).toEqual(["开篇", "冲突"])
    expect(snap.scene.sceneCount).toBe(2)
    expect(sceneListProvider).toHaveBeenCalledWith(pp, "ch5")
    // decision gates passthrough
    expect(snap.decision.consistency.verdict).toBe("通过")
    expect(snap.decision.overall).toBe("blocked")
    // stale: draft mtime (Jan 2) > cachedAt (Jan 1)
    expect(snap.isStale).toBe(true)
    expect(snap.cachedAt).toBe("2026-01-01T00:00:00.000Z")
    // slop scan: 总之 ×2, 综上所述 ×1
    expect(snap.deAiSlopHits).toEqual([
      { word: "总之", count: 2 },
      { word: "综上所述", count: 1 },
    ])
  })

  it("returns defaults when status is null (no session)", async () => {
    const snap = await queryInspectorState(pp, "ch1")
    expect(snap.draft).toEqual({
      draftId: "",
      filePath: "",
      draftStatus: "pending",
      contentPreview: "",
      updatedAt: "",
    })
    expect(snap.decision).toEqual({
      consistency: { status: "pending", verdict: "pending" },
      anti_ai: { status: "pending", verdict: "pending" },
      quality: { status: "pending", verdict: "pending" },
      overall: "pending",
    })
    expect(snap.review.findings).toEqual([])
    expect(snap.review.reviewedAt).toBeNull()
    expect(snap.cachedAt).toBe(new Date(0).toISOString())
    expect(snap.isStale).toBe(false)
    expect(snap.deAiSlopHits).toEqual([])
    expect(snap.scene.sceneTitles).toEqual([])
    expect(snap.scene.sceneCount).toBe(0)
  })

  it("returns empty cognition blocks when cognition-state is absent", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue(statusOverrides())
    mocks.loadCognitionState.mockResolvedValue(null)
    mocks.readFile.mockResolvedValue("正文")
    mocks.getFileModifiedTime.mockResolvedValue(0)
    const snap = await queryInspectorState(pp, "ch1")
    expect(snap.cognitionState).toEqual({ characters: [], readerKnows: [], lastUpdatedChapter: null })
    expect(snap.contextPack).toEqual({ cognitionSummary: "无认知状态", characterCount: 0, readerKnowsCount: 0 })
  })

  it("skips draft preview read when status has no draft file_path", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue(statusOverrides({ draft: { draft_id: "d2", file_path: "", draft_status: "pending", updated_at: "2026-01-01T00:00:00.000Z" } }))
    const snap = await queryInspectorState(pp, "ch1")
    expect(snap.draft.filePath).toBe("")
    expect(snap.draft.contentPreview).toBe("")
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("tolerates draft file read failures (pending draft not on disk yet)", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue(statusOverrides())
    mocks.readFile.mockRejectedValue(new Error("ENOENT"))
    const snap = await queryInspectorState(pp, "ch1")
    expect(snap.draft.contentPreview).toBe("")
    expect(snap.isStale).toBe(false)
  })

  it("isStale false when draft mtime predates cachedAt", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue(statusOverrides())
    mocks.readFile.mockResolvedValue("正文")
    mocks.getFileModifiedTime.mockResolvedValue(Date.parse("2020-01-01T00:00:00.000Z"))
    const snap = await queryInspectorState(pp, "ch1")
    expect(snap.isStale).toBe(false)
  })

  it("isStale false when cachedAt is not parseable", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue(statusOverrides({ updated_at: "not-a-date" }))
    mocks.readFile.mockResolvedValue("正文")
    mocks.getFileModifiedTime.mockResolvedValue(Date.now())
    const snap = await queryInspectorState(pp, "ch1")
    expect(snap.isStale).toBe(false)
  })

  it("degrades scene block to empty when the provider throws", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue(statusOverrides())
    mocks.readFile.mockResolvedValue("正文")
    mocks.getFileModifiedTime.mockResolvedValue(0)
    const sceneListProvider = vi.fn().mockRejectedValue(new Error("boom"))
    const snap = await queryInspectorState(pp, "ch1", sceneListProvider)
    expect(snap.scene.sceneTitles).toEqual([])
    expect(snap.scene.sceneCount).toBe(0)
  })

  it("falls back to the dimension key label for unknown dimensions", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue(statusOverrides())
    mocks.readFile.mockResolvedValue("正文")
    mocks.getFileModifiedTime.mockResolvedValue(0)
    mocks.getCachedDimensionResults.mockImplementation(() => [
      dimensionResult({ dimensionKey: "mystery" }),
    ])
    const snap = await queryInspectorState(pp, "ch1")
    expect(snap.review.findings[0]!.dimensionLabel).toBe("mystery")
  })

  it("filters empty issue messages and evidences", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue(statusOverrides())
    mocks.readFile.mockResolvedValue("正文")
    mocks.getFileModifiedTime.mockResolvedValue(0)
    mocks.getCachedDimensionResults.mockImplementation(() => [
      dimensionResult({
        issues: [
          { message: "", evidence: "", severity: "info", type: "thrill", dimensionKey: "thrill" },
          { message: "有内容", evidence: "有证据", severity: "warning", type: "thrill", dimensionKey: "thrill" },
        ],
      }),
    ])
    const snap = await queryInspectorState(pp, "ch1")
    expect(snap.review.findings[0]!.messages).toEqual(["有内容"])
    expect(snap.review.findings[0]!.evidences).toEqual(["有证据"])
  })

  it("throws a sanitized error wrapping Error messages", async () => {
    mocks.loadNovelSessionStatus.mockRejectedValue(new Error("boom"))
    await expect(queryInspectorState(pp, "ch1")).rejects.toThrow("Inspector 查询失败：boom")
  })

  it("throws a generic sanitized error for non-Error failures", async () => {
    mocks.loadNovelSessionStatus.mockRejectedValue("raw detail leak")
    await expect(queryInspectorState(pp, "ch1")).rejects.toThrow("Inspector 查询失败")
  })

  it("uses epoch-0 cachedAt when status lacks updated_at", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue(statusOverrides({ updated_at: undefined }))
    mocks.readFile.mockResolvedValue("正文")
    mocks.getFileModifiedTime.mockResolvedValue(12345)
    const snap = await queryInspectorState(pp, "ch1")
    expect(snap.cachedAt).toBe(new Date(0).toISOString())
    expect(snap.review.reviewedAt).toBeNull()
    // any positive draft mtime is after epoch 0 → stale
    expect(snap.isStale).toBe(true)
  })

  it("handles cognition state with null lastUpdatedChapter", async () => {
    mocks.loadNovelSessionStatus.mockResolvedValue(statusOverrides())
    mocks.loadCognitionState.mockResolvedValue({
      characters: [],
      readerKnows: [],
      lastUpdatedChapter: null,
    })
    mocks.readFile.mockResolvedValue("正文")
    mocks.getFileModifiedTime.mockResolvedValue(0)
    const snap = await queryInspectorState(pp, "ch1")
    expect(snap.cognitionState.lastUpdatedChapter).toBeNull()
  })

  it("handles a de-ai rules payload without a 禁用词汇 section (whole text scanned)", async () => {
    // re-import the module with a rules payload that lacks the section header;
    // SLOP_WORDS then falls back to scanning the entire string (line 166 else)
    vi.resetModules()
    vi.doMock("./de-ai-rules", () => ({
      CHINESE_NOVEL_DE_AI_RULES: "解释腔：总之。综上所述。",
    }))
    const mod = await import("./inspector-query")
    mocks.loadNovelSessionStatus.mockResolvedValue(statusOverrides())
    mocks.loadCognitionState.mockResolvedValue(null)
    mocks.readFile.mockResolvedValue("总之综上所述正文")
    mocks.getFileModifiedTime.mockResolvedValue(0)
    const snap = await mod.queryInspectorState(pp, "ch1")
    // 解释腔 is in the exclusion list; 总之/综上所述 are real slop words
    expect(snap.deAiSlopHits.some((h) => h.word === "总之")).toBe(true)
    expect(snap.deAiSlopHits.some((h) => h.word === "综上所述")).toBe(true)
    expect(snap.deAiSlopHits.some((h) => h.word === "解释腔")).toBe(false)
  })
})
