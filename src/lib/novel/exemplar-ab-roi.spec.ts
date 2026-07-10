import { beforeEach, describe, expect, it, vi } from "vitest"

// fs mocks — appendExemplarABSample 用 loadCognitionState/saveCognitionState
// （经 fileExists + readFile + createDirectory + writeFileAtomic）写 cognition-state.json。
const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(async (_path: string): Promise<boolean> => false),
  readFile: vi.fn(async (_path: string): Promise<string> => ""),
  writeFileAtomic: vi.fn(async (_path: string, _contents: string): Promise<void> => {}),
  createDirectory: vi.fn(async (_path: string): Promise<void> => {}),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  fileExists: fsMocks.fileExists,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
}))

import {
  appendExemplarABSample,
  exemplarABStats,
  type CognitionState,
} from "./character-cognition"

/** 捕获 writeFileAtomic 写入的 cognition-state.json 内容。 */
function captureWrittenState(): CognitionState | null {
  const calls = fsMocks.writeFileAtomic.mock.calls
  if (calls.length === 0) return null
  const contents = calls[calls.length - 1][1] as string
  return JSON.parse(contents) as CognitionState
}

beforeEach(() => {
  fsMocks.fileExists.mockReset()
  fsMocks.readFile.mockReset()
  fsMocks.writeFileAtomic.mockReset()
  fsMocks.createDirectory.mockReset()
  fsMocks.fileExists.mockResolvedValue(false)
  fsMocks.readFile.mockResolvedValue("")
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  fsMocks.createDirectory.mockResolvedValue(undefined)
})

describe("appendExemplarABSample (TASK-005 / EPIC-001 / ADR-29)", () => {
  it("appends an exemplar A/B sample to cognition-state.json", async () => {
    await appendExemplarABSample("/proj", {
      variant: "enabled",
      score: 4,
      chapterId: "ch-1.md",
      timestamp: "2026-07-10T00:00:00Z",
    })

    const written = captureWrittenState()
    expect(written).not.toBeNull()
    expect(written!.exemplarABuckets).toHaveLength(1)
    expect(written!.exemplarABuckets![0]).toEqual({
      variant: "enabled",
      score: 4,
      chapterId: "ch-1.md",
      timestamp: "2026-07-10T00:00:00Z",
    })
  })

  it("preserves existing routingROIBuckets when appending exemplar sample (additive isolation)", async () => {
    // 模拟已有 routingROIBuckets 的 cognition-state.json（TASK-008 数据共存）。
    const existing: CognitionState = {
      characters: [],
      readerKnows: [],
      lastUpdatedChapter: 1,
      routingROIBuckets: [
        { variant: "enabled", irrelevantRatio: 0.2, chapterId: "ch-1.md", timestamp: "2026-07-09T00:00:00Z" },
      ],
    }
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(JSON.stringify(existing))

    await appendExemplarABSample("/proj", {
      variant: "disabled",
      score: 3,
      chapterId: "ch-2.md",
      timestamp: "2026-07-10T00:00:00Z",
    })

    const written = captureWrittenState()
    expect(written!.routingROIBuckets).toHaveLength(1) // TASK-008 数据不被破坏
    expect(written!.exemplarABuckets).toHaveLength(1)
    expect(written!.exemplarABuckets![0].variant).toBe("disabled")
  })

  it("caps exemplarABuckets at 1024 entries (LRU-ish shift oldest)", async () => {
    // 预填 1024 条，append 第 1025 条应弹最旧。
    const existing: CognitionState = {
      characters: [],
      readerKnows: [],
      lastUpdatedChapter: 0,
      exemplarABuckets: Array.from({ length: 1024 }, (_, i) => ({
        variant: "enabled" as const,
        score: 3,
        chapterId: `ch-${i}.md`,
        timestamp: `2026-07-09T${String(i).padStart(2, "0")}:00:00Z`,
      })),
    }
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(JSON.stringify(existing))

    await appendExemplarABSample("/proj", {
      variant: "enabled",
      score: 5,
      chapterId: "ch-new.md",
      timestamp: "2026-07-10T00:00:00Z",
    })

    const written = captureWrittenState()
    expect(written!.exemplarABuckets).toHaveLength(1024)
    // 最旧（ch-0）被弹出，最新（ch-new）在末尾。
    expect(written!.exemplarABuckets![0].chapterId).toBe("ch-1.md")
    expect(written!.exemplarABuckets![1023].chapterId).toBe("ch-new.md")
  })

  it("is non-fatal — swallow errors without throwing", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("disk gone"))
    fsMocks.fileExists.mockResolvedValue(true)
    // 不应 throw（ROI 采集失败不阻断主链）。
    await expect(
      appendExemplarABSample("/proj", {
        variant: "enabled",
        score: 5,
        chapterId: "ch.md",
        timestamp: "2026-07-10T00:00:00Z",
      }),
    ).resolves.toBeUndefined()
  })
})

describe("exemplarABStats (TASK-005 cross-chapter A/B verification)", () => {
  it("returns null averages when state is null or empty", () => {
    expect(exemplarABStats(null)).toEqual({ enabledAvg: null, disabledAvg: null })
    expect(exemplarABStats({ characters: [], readerKnows: [], lastUpdatedChapter: 0 } as CognitionState))
      .toEqual({ enabledAvg: null, disabledAvg: null })
  })

  it("computes enabled vs disabled average scores (ROI: enabled > disabled)", () => {
    const state: CognitionState = {
      characters: [],
      readerKnows: [],
      lastUpdatedChapter: 0,
      exemplarABuckets: [
        { variant: "enabled", score: 4, chapterId: "ch-1", timestamp: "" },
        { variant: "enabled", score: 5, chapterId: "ch-2", timestamp: "" },
        { variant: "enabled", score: 5, chapterId: "ch-3", timestamp: "" },
        { variant: "disabled", score: 2, chapterId: "ch-4", timestamp: "" },
        { variant: "disabled", score: 3, chapterId: "ch-5", timestamp: "" },
      ],
    }
    const stats = exemplarABStats(state)
    // enabled avg = (4+5+5)/3 ≈ 4.67, disabled avg = (2+3)/2 = 2.5
    expect(stats.enabledAvg).toBeCloseTo(4.67, 1)
    expect(stats.disabledAvg).toBe(2.5)
    expect(stats.enabledAvg!).toBeGreaterThan(stats.disabledAvg!)
  })

  it("returns null for a group with no samples", () => {
    const state: CognitionState = {
      characters: [],
      readerKnows: [],
      lastUpdatedChapter: 0,
      exemplarABuckets: [
        { variant: "enabled", score: 4, chapterId: "ch-1", timestamp: "" },
      ],
    }
    const stats = exemplarABStats(state)
    expect(stats.enabledAvg).toBe(4)
    expect(stats.disabledAvg).toBeNull()
  })
})
