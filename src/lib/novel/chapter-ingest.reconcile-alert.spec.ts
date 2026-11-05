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

  it("queued>0 → logger.warn 携带 queued/ops 计数 (双写积压可见)", async () => {
    shadowWriteCanonMock.mockResolvedValueOnce({
      written: 0,
      queued: 2,
      results: [{ consistent: true }, { consistent: true }],
      reconcile: { consistent: true, divergences: [] },
    })
    const deps = makeDeps()
    await runCanonDualWriteHook(
      deps,
      PROJECT,
      { chapter_status: "final" },
      snapshotWithFacts(["主角佩剑名为黑剑", "黑剑出自寒江城"]),
      1234,
    )
    const warnCalls = loggerWarnMock.mock.calls.filter((c) => String(c[1]).includes("ops queued"))
    expect(warnCalls.length).toBe(1)
    // 2 条正史事实 → 2 条 episode op；消息里的分母是 op 总数，不是事实数以外的占位。
    expect(String(warnCalls[0]![1])).toBe("Canon dual-write: 2/2 ops queued (non-fatal)")
  })

  it("queued=0 → 无积压告警 (反向分支)", async () => {
    shadowWriteCanonMock.mockResolvedValueOnce({
      written: 2,
      queued: 0,
      results: [{ consistent: true }, { consistent: true }],
      reconcile: { consistent: true, divergences: [] },
    })
    const deps = makeDeps()
    await runCanonDualWriteHook(
      deps,
      PROJECT,
      { chapter_status: "final" },
      snapshotWithFacts(["主角佩剑名为黑剑", "黑剑出自寒江城"]),
      1234,
    )
    expect(loggerWarnMock.mock.calls.filter((c) => String(c[1]).includes("ops queued"))).toHaveLength(0)
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
