import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ReviewView } from "./review-view"
import type { NovelReviewResult } from "@/lib/novel/review-adapter"

// PAT-G2 mock mirror: vi.mock @/commands/fs factory 须 mirror 全 export
// (readFile/writeFileAtomic/createDirectory/fileExists)。漏 export →
// createAtomicJsonStore 内部调时 runtime TypeError。本测试虽 SSR 不触发
// dismissFinding store 写入闭环 (plan TASK-003 risk 2 接受此边界), 但守
// PAT-G2 规范 mirror 全 4 export 防活体孪生。
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
  fileExists: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  deleteFile: vi.fn(),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/i18n", () => ({
  default: {
    exists: () => true,
    t: (key: string) => key,
  },
}))

const wikiState = {
  novelMode: true,
  project: { path: "E:/Novel" },
  selectedFile: null,
  selectedReviewFilePath: null,
  fileContent: "",
  setSelectedFile: vi.fn(),
  setFileContent: vi.fn(),
  setActiveView: vi.fn(),
  setFileTree: vi.fn(),
  setPendingEditorHighlight: vi.fn(),
  bumpDataVersion: vi.fn(),
  dataVersion: 0,
  reviewRun: null as null | { filePath: string; results: NovelReviewResult[]; running: boolean; error: null | string },
  llmConfig: null,
}

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (state: typeof wikiState) => unknown) => selector(wikiState),
}))

vi.mock("@/stores/review-store", () => ({
  useReviewStore: (selector: (state: { items: unknown[]; resolveItem: () => void; dismissItem: () => void; clearResolved: () => void }) => unknown) =>
    selector({ items: [], resolveItem: () => {}, dismissItem: () => {}, clearResolved: () => {} }),
}))

vi.mock("@/lib/novel/character-cognition", () => ({
  loadCognitionState: vi.fn(),
}))

vi.mock("@/lib/novel/generation-history", () => ({
  listGenerationHistory: vi.fn(),
  deleteGenerationHistoryEntry: vi.fn(),
}))

vi.mock("@/lib/llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("@/lib/has-usable-llm", () => ({ hasUsableLlm: () => false }))
vi.mock("@/lib/novel/model-resolver", () => ({ resolveDefaultModel: () => null }))
vi.mock("@/lib/novel/start-review-run", () => ({ startNovelReviewRun: vi.fn() }))
vi.mock("@/lib/novel/start-six-dimension-review-run", () => ({ startSixDimensionReviewRun: vi.fn() }))
vi.mock("@/lib/dashboard-issue-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dashboard-issue-actions")>()
  return {
    ...actual,
    createEmptyDashboardIssueState: () => ({ ignored: {}, rewrites: {} }),
    loadDashboardIssueState: vi.fn(),
    saveDashboardIssueState: vi.fn(),
    restoreDashboardRewriteInMarkdown: vi.fn(),
  }
})
vi.mock("@/lib/novel/review-scoring", () => ({ scoreReviewResults: () => ({ dimensions: [], total: 0 }) }))
vi.mock("@/lib/review-rewrite-plan", () => ({
  findReviewRewriteAnchors: () => [],
  parseReviewRewritePlan: () => ({ edits: [] }),
  buildReviewRewritePlanMessages: () => [],
  applyReviewRewriteEditsToMarkdown: () => "",
}))

// G3 dismiss UI 渲染 spec (SSR 模式, PAT-G2 mock @/commands/fs mirror 4 export)
// 断言: continuity finding (subtype !== 'data_gap') 渲染 dismiss 按钮 +
// data_gap subtype 不渲染 dismiss 按钮 (DD-5 UI 层双守)。SSR 不测 dismiss
// 异步 onClick store 写入闭环 (plan TASK-003 risk 2 接受边界), 仅断言渲染存在性。
describe("ReviewView dismiss UI rendering (G3)", () => {
  it("renders dismiss button for continuity finding with subtype !== data_gap", () => {
    wikiState.reviewRun = {
      filePath: "E:/Novel/chapter-8.md",
      results: [
        {
          severity: "error",
          type: "consistency_mechanical",
          message: "死亡角色状态矛盾",
          evidence: "",
          relatedMemory: "",
          suggestion: "修正死亡角色状态层",
          continuityMeta: { subtype: "consistency_mechanical", ref: "character:死者", chapter: 8 },
        },
      ],
      running: false,
      error: null,
    }

    const html = renderToStaticMarkup(<ReviewView />)
    // dismiss 按钮文案 t('review.results.dismiss.dismissButton') = key (mock t 返 key)
    expect(html).toContain("review.results.dismiss.dismissButton")
    // data_gap subtype 的 finding 不应渲染 dismiss 按钮 (DD-5)
    expect(html).not.toContain("review.results.dismiss.titleLabel")
    // PAT-U5: 折叠面板按钮 SSR 初始 aria-expanded="false" (dismissTarget=null → match false)
    // + aria-controls 指向 dismissPanelId (useId 生成, 非空)。panel (role=region) 初始不渲染。
    expect(html).toMatch(/aria-expanded="false"/)
    expect(html).toMatch(/aria-controls="[^"]+"/)
    // 初始折叠: role=region panel 仅在 dismissTarget?.id === item.id 时渲染 (line 628 守)
    expect(html).not.toContain('role="region"')
  })

  it("does not render dismiss button for data_gap subtype finding (DD-5 UI guard)", () => {
    wikiState.reviewRun = {
      filePath: "E:/Novel/chapter-8.md",
      results: [
        {
          severity: "info",
          type: "consistency_mechanical",
          message: "缺失 lastSeenChapter 字段",
          evidence: "",
          relatedMemory: "",
          suggestion: "补 lastSeenChapter",
          continuityMeta: { subtype: "data_gap", ref: "character:甲", chapter: 8, missingField: "lastSeenChapter" },
        },
      ],
      running: false,
      error: null,
    }

    const html = renderToStaticMarkup(<ReviewView />)
    // data_gap subtype 不渲染 dismiss 按钮 (DD-5 UI 层双守, 类型层 dismissFinding severity 已拒 info)
    expect(html).not.toContain("review.results.dismiss.dismissButton")
    expect(html).not.toContain("review.results.dismiss.titleLabel")
  })

  it("does not render dismiss button for non-continuity LLM finding (no continuityMeta)", () => {
    wikiState.reviewRun = {
      filePath: "E:/Novel/chapter-8.md",
      results: [
        {
          severity: "warning",
          type: "character_consistency",
          message: "人物动机不连贯",
          evidence: "某段落",
          relatedMemory: "",
          suggestion: "补内心独白",
        },
      ],
      running: false,
      error: null,
    }

    const html = renderToStaticMarkup(<ReviewView />)
    // 非 continuity finding 无 continuityMeta → 不渲染 dismiss 按钮 (DD-1 additive, 零行为变更)
    expect(html).not.toContain("review.results.dismiss.dismissButton")
  })
})
