/**
 * promotion-bridge.statements.spec.ts — 覆盖率战役增量（statements/branches 尾段）。
 *
 * 只补既有 promotion-bridge.spec.ts 未触达的行为面：
 *   - evaluateGate 的 condition 求值抛错落点（歧义 → BLOCK，BND-PRM-10 兜底）
 *   - resolvePromotionEntity 两条分支（事实主语解析 / chapterId 兜底）
 *   - inMemoryCapabilitySink.fingerprint（无持久状态声明）
 *   - appendFoldConflictLog 写失败的非致命语义（不落盘、不抛出）
 *   - enqueuePromotionRetry / promote 缺省 entity 的 replayKey 兜底
 *   - promote 缺省 contentDigestPrefix → 空串（不伪造摘要）
 *   - promotionReplaySuccessRate 空 store 的平凡取值（rate=1）
 *
 * @license MIT © Niko Buddy
 */
import { describe, it, expect, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: (...args: unknown[]) => fsMocks.readFile(...args),
    writeFileAtomic: (...args: unknown[]) => fsMocks.writeFileAtomic(...args),
    createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
  }
})

import {
  appendFoldConflictLog,
  enqueuePromotionRetry,
  evaluateGate,
  inMemoryCapabilitySink,
  promote,
  promotionReplaySuccessRate,
  resolvePromotionEntity,
  type GateContext,
  type PromoteInput,
} from "./promotion-bridge"

const PROJECT = "/tmp/promo-gap"

function resetFs() {
  fsMocks.readFile.mockReset()
  fsMocks.writeFileAtomic.mockReset()
  fsMocks.createDirectory.mockReset()
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  fsMocks.createDirectory.mockResolvedValue(undefined)
}

/** 空 store（promotions.json 不存在）+ 落盘可观测。 */
function emptyStoreFs() {
  resetFs()
  fsMocks.readFile.mockRejectedValue(new Error("ENOENT: promotions.json"))
}

function makeInput(overrides: Partial<PromoteInput> = {}): PromoteInput {
  return {
    channel: "formal-writeback",
    projectPath: PROJECT,
    chapterId: "chapter-5",
    chapterNumber: 5,
    revision: 1,
    acceptTimestamp: "2026-09-04T08:00:00.000Z",
    gateContext: { draftStatus: "accepted", decisionGatesPass: true },
    ...overrides,
  }
}

describe("promotion-bridge / evaluateGate 求值异常落点", () => {
  it("condition 求值抛错 → BLOCK + gate-ambiguous（异常不当作放行）", () => {
    const hostile = {
      channel: "canon-backfill",
      get rangeValid(): boolean {
        throw new Error("ctx eval failed")
      },
    } as unknown as GateContext
    const verdict = evaluateGate("canon-backfill", hostile)
    expect(verdict.verdict).toBe("BLOCK")
    expect(verdict.reason).toBe("gate-ambiguous: ctx eval failed")
  })
})

describe("promotion-bridge / resolvePromotionEntity", () => {
  it("有事实陈述 → 解析主语", () => {
    expect(resolvePromotionEntity("白砚是剑主", "chapter-9")).toBe("白砚")
    expect(resolvePromotionEntity("轩辕剑：封印真相", "chapter-9")).toBe("轩辕剑")
  })

  it("无事实（undefined / 空串）→ chapterId 兜底", () => {
    expect(resolvePromotionEntity(undefined, "chapter-9")).toBe("chapter-9")
    expect(resolvePromotionEntity("", "chapter-9")).toBe("chapter-9")
  })
})

describe("promotion-bridge / inMemoryCapabilitySink 指纹", () => {
  it("无持久状态 → 恒定 noop 指纹（不含条目）", async () => {
    await expect(inMemoryCapabilitySink.fingerprint(PROJECT)).resolves.toBe("in-memory-sink:noop")
  })

  it("reset 为 noop（无持久状态）→ 指纹不变", async () => {
    const before = await inMemoryCapabilitySink.fingerprint(PROJECT)
    await expect(inMemoryCapabilitySink.reset(PROJECT)).resolves.toBeUndefined()
    expect(await inMemoryCapabilitySink.fingerprint(PROJECT)).toBe(before)
  })
})

describe("promotion-bridge / appendFoldConflictLog 非致命写失败", () => {
  it("目录创建失败 → 不抛出且不写文件（报告工件可丢）", async () => {
    resetFs()
    fsMocks.createDirectory.mockRejectedValue(new Error("EACCES: .novel"))
    await expect(
      appendFoldConflictLog(PROJECT, {
        ts: "2026-09-04T08:00:00.000Z",
        source: "promotion-gate",
        chapter: "5",
        subject: "edge-1",
        shouldSide: "canon",
        actualSide: "actual-first",
        resolution: "actual-first",
      }),
    ).resolves.toBeUndefined()
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })
})

describe("promotion-bridge / 缺省 entity 与 digest 兜底", () => {
  it("enqueuePromotionRetry 缺省 entity → replayKey 第三段用 chapterId", async () => {
    emptyStoreFs()
    await enqueuePromotionRetry(
      PROJECT,
      makeInput({ chapterId: "chapter-7", chapterNumber: 7, entity: undefined }),
      "gate-blocked",
    )
    const written = fsMocks.writeFileAtomic.mock.calls
      .map((c) => ({ path: String(c[0]), body: String(c[1]) }))
      .find((w) => w.path.endsWith("promotion-retry.jsonl"))
    expect(written).toBeDefined()
    const line = JSON.parse(written!.body.trim().split("\n").pop()!)
    expect(line.replayKey).toBe("formal-writeback:chapter-7:chapter-7:1")
    expect(line.reason).toBe("gate-blocked")
  })

  it("promote 缺省 entity + contentDigestPrefix → replayKey 与摘要各自兜底", async () => {
    emptyStoreFs()
    const result = await promote(
      makeInput({ chapterId: "chapter-6", chapterNumber: 6, entity: undefined, contentDigestPrefix: undefined }),
    )
    expect(result.replayed).toBe(false)
    expect(result.record.replayKey).toBe("formal-writeback:chapter-6:chapter-6:1")
    // 无摘要输入 → 空串，绝不从正文推导（铁律③：只存引用不存全文）
    expect(result.record.finalSnapshot.contentDigestPrefix).toBe("")
  })
})

describe("promotion-bridge / 重放成功率空口径", () => {
  it("空 store → total 0 / success 0 / rate 平凡 1", async () => {
    resetFs()
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ records: {} }))
    await expect(promotionReplaySuccessRate(PROJECT)).resolves.toEqual({
      success: 0,
      total: 0,
      rate: 1,
    })
  })
})
