import { beforeEach, describe, expect, it, vi } from "vitest"

const statusMocks = vi.hoisted(() => ({
  buildNextStatus: vi.fn(),
  loadNovelSessionStatus: vi.fn(),
  saveNovelSessionStatus: vi.fn(),
}))

vi.mock("../novel-session-status", () => ({
  buildNextStatus: statusMocks.buildNextStatus,
  loadNovelSessionStatus: statusMocks.loadNovelSessionStatus,
  saveNovelSessionStatus: statusMocks.saveNovelSessionStatus,
}))

import {
  createDeAiBatchState,
  deriveRemainingQueue,
  loadDeAiBatchState,
  resumeDeAiBatchState,
  saveDeAiBatchState,
} from "./resume"
import { DE_AI_BATCH_SCHEMA, type DeAiBatchState } from "./types"

function state(overrides: Partial<DeAiBatchState> = {}): DeAiBatchState {
  return {
    schemaVersion: DE_AI_BATCH_SCHEMA,
    batchId: "de-ai-1",
    phase: "running",
    concurrency: 3,
    startedAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    queue: [1, 2, 3, 4],
    perChapter: {},
    ...overrides,
  }
}

describe("de-ai-batch resume — createDeAiBatchState", () => {
  it("新建批次：running + 队列 + 时间戳", () => {
    const created = createDeAiBatchState({
      batchId: "de-ai-9",
      queue: [1, 2],
      concurrency: 2,
      genre: "玄幻",
      now: () => "2026-08-19T01:00:00.000Z",
    })
    expect(created.schemaVersion).toBe(DE_AI_BATCH_SCHEMA)
    expect(created.batchId).toBe("de-ai-9")
    expect(created.phase).toBe("running")
    expect(created.queue).toEqual([1, 2])
    expect(created.concurrency).toBe(2)
    expect(created.genre).toBe("玄幻")
    expect(created.startedAt).toBe("2026-08-19T01:00:00.000Z")
    expect(created.perChapter).toEqual({})
  })
})

describe("de-ai-batch resume — deriveRemainingQueue", () => {
  it("pending/failed/running 重新入队；ready/accepted/rejected/skipped 跳过", () => {
    const s = state({
      queue: [1, 2, 3, 4, 5, 6, 7],
      perChapter: {
        1: { status: "ready", attempts: 1 },
        2: { status: "failed", attempts: 2, lastError: "boom" },
        3: { status: "skipped", attempts: 1 },
        4: { status: "accepted", attempts: 1 },
        5: { status: "rejected", attempts: 1 },
        6: { status: "running", attempts: 1 },
      },
    })
    expect(deriveRemainingQueue(s)).toEqual([2, 6, 7])
  })

  it("无 perChapter 记录的章节视为待处理", () => {
    const s = state({ queue: [1, 2] })
    expect(deriveRemainingQueue(s)).toEqual([1, 2])
  })
})

describe("de-ai-batch resume — resumeDeAiBatchState", () => {
  it("running（中断残留）→ pending；phase → running；其余状态保留", () => {
    const s = state({
      phase: "paused",
      perChapter: {
        1: { status: "running", attempts: 1 },
        2: { status: "ready", attempts: 1 },
        3: { status: "failed", attempts: 2, lastError: "boom" },
      },
    })
    const resumed = resumeDeAiBatchState(s, () => "2026-08-19T02:00:00.000Z")
    expect(resumed.phase).toBe("running")
    expect(resumed.perChapter[1].status).toBe("pending")
    expect(resumed.perChapter[1].attempts).toBe(1)
    expect(resumed.perChapter[2].status).toBe("ready")
    expect(resumed.perChapter[3].status).toBe("failed")
    expect(resumed.updatedAt).toBe("2026-08-19T02:00:00.000Z")
    expect(s.perChapter[1].status).toBe("running") // 原对象不变（纯函数）
  })
})

describe("de-ai-batch resume — load/save", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("loadDeAiBatchState：status.json 有 de_ai_batch 时返回", async () => {
    const s = state()
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ de_ai_batch: s })
    expect(await loadDeAiBatchState("/p")).toBe(s)
  })

  it("loadDeAiBatchState：无 status 或无字段返回 null", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue(null)
    expect(await loadDeAiBatchState("/p")).toBeNull()
    statusMocks.loadNovelSessionStatus.mockResolvedValue({})
    expect(await loadDeAiBatchState("/p")).toBeNull()
  })

  it("saveDeAiBatchState：经 buildNextStatus 线穿并保存", async () => {
    const s = state()
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed" })
    statusMocks.buildNextStatus.mockImplementation((base: any, overrides: any) => ({
      ...base,
      ...overrides,
    }))
    statusMocks.saveNovelSessionStatus.mockResolvedValue(undefined)
    const ok = await saveDeAiBatchState("/p", s)
    expect(ok).toBe(true)
    expect(statusMocks.buildNextStatus).toHaveBeenCalledWith(
      { status: "completed" },
      expect.objectContaining({ de_ai_batch: s, status: "completed" }),
    )
    expect(statusMocks.saveNovelSessionStatus).toHaveBeenCalled()
  })

  it("saveDeAiBatchState：status.json 不存在返回 false（best-effort）", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue(null)
    expect(await saveDeAiBatchState("/p", state())).toBe(false)
    expect(statusMocks.saveNovelSessionStatus).not.toHaveBeenCalled()
  })
})
