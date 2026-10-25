// SEQ-48 falsification: cognition-panel direct loader vs queryInspectorState.
// Claim under test: "cognition-panel + character-profile directly import
// loadCognitionState/loadCharacterStates, bypassing queryInspectorState —
// need shared useCognitionData/useCharacterData hook".
// Falsification proof: queryInspectorState snapshot shape cannot supply the
// character-detail fields the panel renders (currentLocation/status/
// equipment/abilities/relationships). Direct loader is correct layering,
// extracting a shared hook on top of queryInspectorState would lose data.
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(async () => { throw new Error("ENOENT: no such file") }),
  getFileModifiedTime: vi.fn(async () => 0),
  loadNovelSessionStatus: vi.fn(async () => null),
  loadCognitionState: vi.fn(async () => null),
  getCachedDimensionResults: vi.fn(() => []),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: () => mocks.readFile(),
    getFileModifiedTime: () => mocks.getFileModifiedTime(),
  }
})

vi.mock("@/lib/path-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/path-utils")>()
  return {
    ...actual,
    normalizePath: (p: string) => p.replace(/\\/g, "/"),
  }
})

vi.mock("./novel-session-status", () => ({
  loadNovelSessionStatus: () => mocks.loadNovelSessionStatus(),
}))

vi.mock("./character-cognition", () => ({
  loadCognitionState: () => mocks.loadCognitionState(),
}))

vi.mock("./dimension-review-adapter", () => ({
  getCachedDimensionResults: () => mocks.getCachedDimensionResults(),
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

import { queryInspectorState } from "./inspector-query"
import { loadNovelSessionStatus } from "./novel-session-status"
import { loadCognitionState } from "./character-cognition"

describe("SEQ-48 direct-loader bypass claim (ISS-20260712-011)", () => {
  it("queryInspectorState cannot supply character detail fields, so direct loader is required", async () => {
    const snap = await queryInspectorState("/P", "c1")
    const keys = Object.keys(snap).sort()
    expect(keys).toContain("cognitionState")
    expect(keys).toContain("contextPack")
    const serialized = JSON.stringify(snap)
    expect(serialized).not.toContain("currentLocation")
    expect(serialized).not.toContain("equipment")
    expect(serialized).not.toContain("abilities")
    expect(snap.cognitionState.characters).toEqual([])
    expect(typeof loadCognitionState).toBe("function")
    expect(typeof loadNovelSessionStatus).toBe("function")
    expect(loadCognitionState).not.toBe(loadNovelSessionStatus as unknown)
  })
})
