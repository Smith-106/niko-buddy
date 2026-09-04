// @vitest-environment node
// 55 号设计 W1-3 (54⑤ 收尾): reconcile 告警消费——重放后仍不一致 → logger.warn 带 divergences digest。
// 防空转要点 (55 号 C 视角): mock 形状 = canon-dual-write.ts 真实返回形状
// { written, queued, results, reconcile: { consistent, divergences: [{digest, reasons}] } };
// 正/反两向都有断言 (不一致告警 / 一致无告警)。

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChapterSnapshot } from "./chapter-ingest"
import { runCanonDualWriteHook } from "./chapter-ingest"
import type { CanonDualWriteDeps } from "./canon-dual-write"

const shadowWriteCanonMock = vi.hoisted(() => vi.fn())
const loggerWarnMock = vi.hoisted(() => vi.fn())

vi.mock("./canon-dual-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./canon-dual-write")>()
  return {
    ...actual,
    shadowWriteCanon: (...args: unknown[]) => shadowWriteCanonMock(...args),
  }
})

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return {
    ...actual,
    logger: { ...actual.logger, warn: loggerWarnMock },
  }
})

const PROJECT = "E:/Novel"

function snapshotWithFacts(facts: string[]): ChapterSnapshot {
  return {
    chapterNumber: 1,
    chapterTitle: "第一章",
    chapterPath: `${PROJECT}/chapters/第一章.md`,
    chapterStatus: "final",
    newCanonFacts: facts,
    snapshot: {
      chapterNumber: 1,
      chapterTitle: "第一章",
      chapterPath: `${PROJECT}/chapters/第一章.md`,
      chapterStatus: "final",
      newCanonFacts: facts,
      characters: [],
      locations: [],
      events: [],
      relationships: [],
      settings: [],
    },
  } as unknown as ChapterSnapshot
}

function makeDeps(): CanonDualWriteDeps {
  return {
    writeCanon: vi.fn(async () => ({ ok: true, revision: 1 })),
    writeLegacy: vi.fn(async () => ({ ok: true })),
    queueRead: async () => "",
    queueWrite: async () => {},
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("runCanonDualWriteHook — reconcile 告警消费 (55 W1-3)", () => {
  it("reconcile.consistent=false → logger.warn 携带 divergences digest 数组", async () => {
    shadowWriteCanonMock.mockResolvedValueOnce({
      written: 1,
      queued: 0,
      results: [{ consistent: true }],
      reconcile: {
        consistent: false,
        divergences: [
          { digest: "abc123", reasons: ["legacy 侧被外部修改"] },
          { digest: "def456", reasons: ["canon 侧重放失败"] },
        ],
      },
    })
    const deps = makeDeps()
    await runCanonDualWriteHook(deps, PROJECT, { chapter_status: "final" }, snapshotWithFacts(["主角佩剑名为黑剑"]), 1234)
    const warnCalls = loggerWarnMock.mock.calls.filter((c) => String(c[1]).includes("reconcile divergences"))
    expect(warnCalls.length).toBe(1)
    // 断言具体 digest 值 (非 toBeTruthy)
    const payload = warnCalls[0]![2] as { divergences: { digest: string }[] }
    expect(payload.divergences.map((d) => d.digest)).toEqual(["abc123", "def456"])
  })

  it("reconcile.consistent=true → 无 reconcile 告警 (分支差异化)", async () => {
    shadowWriteCanonMock.mockResolvedValueOnce({
      written: 1,
      queued: 0,
      results: [{ consistent: true }],
      reconcile: {
        consistent: true,
        divergences: [],
      },
    })
    const deps = makeDeps()
    await runCanonDualWriteHook(deps, PROJECT, { chapter_status: "final" }, snapshotWithFacts(["主角佩剑名为黑剑"]), 1234)
    const warnCalls = loggerWarnMock.mock.calls.filter((c) => String(c[1]).includes("reconcile divergences"))
    expect(warnCalls.length).toBe(0)
  })

  it("reconcile 报告缺失 (旧形状) → 不抛错, 无告警 (向后兼容)", async () => {
    shadowWriteCanonMock.mockResolvedValueOnce({
      written: 1,
      queued: 0,
      results: [{ consistent: true }],
    })
    const deps = makeDeps()
    await expect(
      runCanonDualWriteHook(deps, PROJECT, { chapter_status: "final" }, snapshotWithFacts(["主角佩剑名为黑剑"]), 1234),
    ).resolves.toBeUndefined()
    const warnCalls = loggerWarnMock.mock.calls.filter((c) => String(c[1]).includes("reconcile divergences"))
    expect(warnCalls.length).toBe(0)
  })

  it("告警不阻断 ingest 主流程 (非致命)", async () => {
    shadowWriteCanonMock.mockResolvedValueOnce({
      written: 1,
      queued: 0,
      results: [{ consistent: true }],
      reconcile: { consistent: false, divergences: [{ digest: "x", reasons: ["r"] }] },
    })
    const deps = makeDeps()
    await expect(
      runCanonDualWriteHook(deps, PROJECT, { chapter_status: "final" }, snapshotWithFacts(["主角佩剑名为黑剑"]), 1234),
    ).resolves.toBeUndefined()
  })
})
