// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * novel-config-persist.spec.ts — 共享落盘函数（逐键回滚语义）四用例
 *
 * R-03 guard：回滚粒度必须是「本次 patch 的键」，退化成整体回滚 input.prev
 * 会冲掉并行任务已落盘的其它键，故用 rollback 键集断言守住。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const saveNovelConfigMock = vi.fn()

vi.mock("@/lib/project-store", () => ({
  saveNovelConfig: (...args: unknown[]) => saveNovelConfigMock(...args),
}))

const { NovelConfigPersistError, persistNovelConfigPatch } = await import("./novel-config-persist")
const { DEFAULT_NOVEL_CONFIG } = await import("@/stores/wiki-store")
type NovelConfig = import("@/stores/wiki-store").NovelConfig

function makePrev(overrides: Partial<NovelConfig> = {}): NovelConfig {
  return { ...DEFAULT_NOVEL_CONFIG, ...overrides }
}

beforeEach(() => {
  saveNovelConfigMock.mockReset()
  saveNovelConfigMock.mockResolvedValue(undefined)
})

describe("persistNovelConfigPatch", () => {
  it("成功路径：apply 收到 patch，saveNovelConfig 收到合并值，返回 next", async () => {
    const prev = makePrev({ chapterTargetChars: 3000 })
    const apply = vi.fn()

    const { next } = await persistNovelConfigPatch({
      patch: { chapterTargetChars: 4000 },
      prev,
      projectId: "p1",
      projectPath: "/tmp/p1",
      apply,
    })

    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({ chapterTargetChars: 4000 })
    expect(saveNovelConfigMock).toHaveBeenCalledTimes(1)
    expect(saveNovelConfigMock.mock.calls[0][0]).toMatchObject({ chapterTargetChars: 4000 })
    expect(saveNovelConfigMock.mock.calls[0][1]).toBe("p1")
    expect(saveNovelConfigMock.mock.calls[0][2]).toBe("/tmp/p1")
    expect(next.chapterTargetChars).toBe(4000)
    expect(next.reviewModel).toBe(prev.reviewModel)
  })

  it("落盘抛错：rollback 键集 === Object.keys(patch)，值为 prev 值，且 apply 第二次收到 rollback", async () => {
    const prev = makePrev({ chapterTargetChars: 3000 })
    const apply = vi.fn()
    saveNovelConfigMock.mockRejectedValue(new Error("disk full"))

    const error = await persistNovelConfigPatch({
      patch: { chapterTargetChars: 4000 },
      prev,
      apply,
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(NovelConfigPersistError)
    const persistError = error as InstanceType<typeof NovelConfigPersistError>
    expect(persistError.message).toContain("disk full")
    expect(Object.keys(persistError.rollback)).toEqual(["chapterTargetChars"])
    expect(persistError.rollback.chapterTargetChars).toBe(3000)
    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls[1][0]).toEqual(persistError.rollback)
  })

  it("多键部分回滚：rollback 键集恰好等于 patch 键集，不波及未在 patch 中的键", async () => {
    const prev = makePrev({ chapterTargetChars: 3000, reviewModel: "a/b" })
    const apply = vi.fn()
    saveNovelConfigMock.mockRejectedValue(new Error("boom"))

    const error = (await persistNovelConfigPatch({
      patch: { chapterTargetChars: 4000, reviewModel: "x/y" },
      prev,
      apply,
    }).catch((err: unknown) => err)) as InstanceType<typeof NovelConfigPersistError>

    expect(Object.keys(error.rollback).sort()).toEqual(["chapterTargetChars", "reviewModel"])
    expect(error.rollback.reviewModel).toBe("a/b")
    // 未在 patch 中的键绝不出现在 rollback 里（整体回滚退化的判据）
    expect(Object.keys(error.rollback)).not.toContain("sceneBreakdownEnabled")
  })

  it("无 projectId/projectPath：以 (next, undefined, undefined) 调用且不抛", async () => {
    const prev = makePrev({ sceneBreakdownEnabled: false })
    const apply = vi.fn()

    await expect(
      persistNovelConfigPatch({ patch: { sceneBreakdownEnabled: true }, prev, apply }),
    ).resolves.toMatchObject({ next: { sceneBreakdownEnabled: true } })

    expect(saveNovelConfigMock.mock.calls[0][1]).toBeUndefined()
    expect(saveNovelConfigMock.mock.calls[0][2]).toBeUndefined()
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
