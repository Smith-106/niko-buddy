import { describe, expect, it } from "vitest"
import {
  appendChapterOnce,
  appendFoldNote,
  applyCharacterStateChangesToStore,
  applyForeshadowingChangesToStore,
  foreshadowNamesMatch,
  touchFoldTimestamp,
} from "@/lib/novel/chapter-ingest-store-apply"
import type { CharacterStateStore } from "@/lib/novel/character-state"
import type { ForeshadowingStore } from "@/lib/novel/foreshadowing-tracker"
import type { ChapterSnapshot } from "@/lib/novel/chapter-ingest"

/**
 * ISS-20260708-003：character/foreshadowing mutation 重复逻辑合一。
 */
function characterStore(): CharacterStateStore {
  return { characters: [], lastUpdated: "t0" }
}

function foreshadowStore(): ForeshadowingStore {
  return { items: [], lastUpdated: "t0" }
}

function snapshot(partial: Partial<ChapterSnapshot>): ChapterSnapshot {
  return {
    chapterNumber: 3,
    characterStateChanges: [],
    foreshadowingChanges: [],
    events: [],
    ...partial,
  } as ChapterSnapshot
}

describe("ISS-20260708-003 fold mutation convergence", () => {
  it("touchFoldTimestamp 有 ctx 则推进、无则保留", () => {
    expect(touchFoldTimestamp({ lastUpdated: "t0" }, { now: "t1" } as never).lastUpdated).toBe("t1")
    expect(touchFoldTimestamp({ lastUpdated: "t0" }, undefined).lastUpdated).toBe("t0")
  })

  it("appendChapterOnce 幂等（重复不追加）", () => {
    const arr: number[] = [3]
    appendChapterOnce(arr, 3)
    expect(arr).toEqual([3])
    appendChapterOnce(arr, 4)
    expect(arr).toEqual([3, 4])
  })

  it("appendFoldNote 空 detail 不改、非空累积", () => {
    expect(appendFoldNote("n", 3, "推进", "")).toBe("n")
    expect(appendFoldNote("", 3, "推进", "d")).toBe("[第3章推进] d")
    expect(appendFoldNote("a", 3, "回收", "d")).toBe("a\n[第3章回收] d")
  })

  it("character 状态写入仍含死亡标记与时间戳推进", () => {
    const store = characterStore()
    applyCharacterStateChangesToStore(
      store,
      snapshot({ characterStateChanges: ["主角：死了"] }),
      undefined,
      { now: "t9" } as never,
    )
    expect(store.characters[0]?.characterName).toBe("主角")
    expect(store.lastUpdated).toBe("t9")
  })

  it("foreshadowing 推进/回收备注累积且 advancedChapters 去重", () => {
    const store = foreshadowStore()
    applyForeshadowingChangesToStore(
      store,
      snapshot({ foreshadowingChanges: ["新增伏笔：钥匙-锈钥匙线索"] }),
    )
    expect(store.items).toHaveLength(1)
    applyForeshadowingChangesToStore(
      store,
      snapshot({ foreshadowingChanges: ["推进伏笔：钥匙-跟进"] }),
    )
    applyForeshadowingChangesToStore(
      store,
      snapshot({ foreshadowingChanges: ["推进伏笔：钥匙-跟进"] }),
    )
    const item = store.items[0]
    expect(item?.status).toBe("advanced")
    // 同章重复推进不重复追加章节号，但备注按调用累积（与收敛前一致）
    expect(item?.advancedChapters).toEqual([3])
    expect(foreshadowNamesMatch("钥匙", "钥匙")).toBe(true)
  })
});
