// ISS-20260709-049: sixDimP 哨兵对象 → 类型化状态对象（成功/失败显式分支，调用方穷尽处理）。
// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const fsReadFileMock = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>(async () => {
  const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException
  err.code = "ENOENT"
  throw err
}))
const fsListMock = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>(async () => []))
vi.mock("@/commands/fs", async () => {
  const actual = await vi.importActual<typeof import("@/commands/fs")>("@/commands/fs")
  return { ...actual, readFile: fsReadFileMock, listDirectory: fsListMock }
})

import { runFullReviewWithSixDim, type SixDimOutcome, assertNeverSixDimOutcome } from "./deep-chapter-review"
import type { NovelReviewResult } from "./review-adapter"
import type { ContextPack } from "./context-engine"
import type { DeepChapterGenerationDeps } from "./deep-chapter-generation"
import type { DimensionReviewResult, SixReviewDimensionKey } from "./dimension-review-adapter"

function makeDimResult(key: SixReviewDimensionKey): DimensionReviewResult {
  return {
    dimensionKey: key,
    score: 8.5,
    status: "pass",
    summary: `${key} ok`,
    thinking: "",
    issues: [],
  }
}

const contextPack = {} as ContextPack

function makeDeps(
  reviewChapter: DeepChapterGenerationDeps["reviewChapter"],
  runSixDimensionReview: DeepChapterGenerationDeps["runSixDimensionReview"],
): DeepChapterGenerationDeps {
  return {
    buildContextPack: vi.fn(async () => contextPack),
    contextPackToPrompt: vi.fn(() => "ctx"),
    reviewChapter,
    runSixDimensionReview,
    streamChat: vi.fn(async () => {}),
  } as unknown as DeepChapterGenerationDeps
}

describe("ISS-20260709-049 sixDim 类型化状态对象", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("success 分支：透传结果集并合并举证（行为等价旧透传）", async () => {
    const reviewChapter = vi.fn(async () => [
      { severity: "info", type: "plot", message: "base", evidence: "", relatedMemory: "", suggestion: "" },
    ] as NovelReviewResult[])
    const runSixDim = vi.fn(async () => ({ character: makeDimResult("character") }))
    const deps = makeDeps(reviewChapter, runSixDim as never)
    const { reviewResults, dimensionResults } = await runFullReviewWithSixDim(
      "正文内容", 3, "/P", deps, undefined, contextPack, {},
    )
    expect(dimensionResults.character).toBeDefined()
    expect(reviewResults.some((r) => r.message.includes("base"))).toBe(true)
    expect(runSixDim).toHaveBeenCalledTimes(1)
  })

  it("failure 分支：非阻塞记 info gap，dimensionResults 为空（行为等价旧 __sixDimError）", async () => {
    const reviewChapter = vi.fn(async () => [
      { severity: "info", type: "plot", message: "base", evidence: "", relatedMemory: "", suggestion: "" },
    ] as NovelReviewResult[])
    const runSixDim = vi.fn(async () => { throw new Error("6-dim stalled") })
    const deps = makeDeps(reviewChapter, runSixDim as never)
    const { reviewResults, dimensionResults } = await runFullReviewWithSixDim(
      "正文内容", 3, "/P", deps, undefined, contextPack, {},
    )
    expect(dimensionResults).toEqual({})
    expect(reviewResults.some((r) => r.message.includes("6-dim review unavailable"))).toBe(true)
    expect(reviewResults.some((r) => r.severity === "info")).toBe(true)
  })

  it("skipped 分支：runSixDim 缺失时空合并，不抛错（行为等价旧 undefined）", async () => {
    const reviewChapter = vi.fn(async () => [
      { severity: "info", type: "plot", message: "base", evidence: "", relatedMemory: "", suggestion: "" },
    ] as NovelReviewResult[])
    const deps = makeDeps(reviewChapter, undefined)
    const { reviewResults, dimensionResults } = await runFullReviewWithSixDim(
      "正文内容", 3, "/P", deps, undefined, contextPack, {},
    )
    expect(dimensionResults).toEqual({})
    expect(reviewResults.some((r) => r.message.includes("base"))).toBe(true)
  })

  it("穷尽分支：assertNever 对非法 kind 抛错（编译期兜底运行时验证）", () => {
    const bad = { kind: "unknown" } as unknown as never
    expect(() => assertNeverSixDimOutcome(bad)).toThrow()
  })

  it("类型判别：success/failure/skipped 三态互斥可收窄", () => {
    const s: SixDimOutcome = { kind: "success", results: {} }
    const f: SixDimOutcome = { kind: "failure", error: new Error("x") }
    const k: SixDimOutcome = { kind: "skipped" }
    const kinds = [s.kind, f.kind, k.kind].sort()
    expect(kinds).toEqual(["failure", "skipped", "success"])
  })
})
