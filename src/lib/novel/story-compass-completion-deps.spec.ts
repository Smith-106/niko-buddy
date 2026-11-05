import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * collectCompletionChecklistInput 的「真源 loader 本身抛错」降级面。
 *
 * 既有 story-compass-io.spec.ts 走的是「文件不存在 → loader 内部返回 null/空」
 * （readFile reject → 各 loader 自己兜底），因此 story-compass.ts 里
 * `loadForeshadowingTracker(...).catch(() => null)` /
 * `loadSubplotBoard(...).catch(() => null)` 这两个 catch 体与 `openThreads = []`
 * 的 board 为 null 分支从未执行。
 *
 * 这里把两个 loader 直接注入成 reject（模拟 loader 自身抛错：schema 变更、
 * 依赖模块加载失败等跨模块契约变化），验证「各源失败 → 降级零值，绝不整体抛错」。
 */
const loaderMocks = vi.hoisted(() => ({
  loadForeshadowingTracker: vi.fn(),
  loadSubplotBoard: vi.fn(),
}))

vi.mock("./foreshadowing-tracker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./foreshadowing-tracker")>()
  return { ...actual, loadForeshadowingTracker: loaderMocks.loadForeshadowingTracker }
})

vi.mock("./subplot-board", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subplot-board")>()
  return { ...actual, loadSubplotBoard: loaderMocks.loadSubplotBoard }
})

import { collectCompletionChecklistInput } from "./story-compass"

const SNAPSHOT_DEPS = () => ({ listSnapshots: async () => [1, 2, 3, -101] })

describe("collectCompletionChecklistInput 真源 loader 抛错降级（§GAP-89-01 失败语义）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("伏笔/支线 loader 双双 reject → 0 与 []，且机械项计数不受影响", async () => {
    loaderMocks.loadForeshadowingTracker.mockRejectedValue(new Error("tracker schema 变更"))
    loaderMocks.loadSubplotBoard.mockRejectedValue(new Error("board schema 变更"))

    const input = await collectCompletionChecklistInput("C:/novel", 3, {}, SNAPSHOT_DEPS())

    expect(input.completedChapters).toBe(3)
    expect(input.activeForeshadowCount).toBe(0)
    expect(input.openThreads).toEqual([])
    // 语义项保持调用方缺省，不因降级被污染。
    expect(input.endingAnswered).toBe(false)
    expect(input.scaleRange).toBeNull()
  })

  it("显式 openThreads 时不再触达支线 loader（loader 抛错也无影响）", async () => {
    loaderMocks.loadForeshadowingTracker.mockRejectedValue(new Error("boom"))
    loaderMocks.loadSubplotBoard.mockRejectedValue(new Error("boom"))

    const input = await collectCompletionChecklistInput(
      "C:/novel",
      3,
      { openThreads: ["长线A"] },
      SNAPSHOT_DEPS(),
    )

    expect(input.openThreads).toEqual(["长线A"])
    expect(loaderMocks.loadSubplotBoard).not.toHaveBeenCalled()
  })
})
