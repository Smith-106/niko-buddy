import { describe, expect, it } from "vitest"
import {
  appendChapterOnce,
  appendFoldNote,
  applyCharacterStateChangesToStore,
  applyEmotionalArcsToStore,
  applyForeshadowingChangesToStore,
  applyResourceLedgerToStore,
  applySubplotChangesToStore,
  foreshadowNamesMatch,
  isDeathStatus,
  normalizeForeshadowName,
  parseCharacterStateChange,
  parseForeshadowingChange,
  touchFoldTimestamp,
} from "./chapter-ingest-store-apply"
import { createEmptyCharacterStateStore } from "./character-state"
import { createEmptyEmotionalArcStore } from "./emotional-arcs"
import { createEmptyForeshadowingStore } from "./foreshadowing-tracker"
import { createEmptyResourceLedgerStore } from "./resource-ledger"
import { createEmptySubplotBoardStore } from "./subplot-board"
import type { ChapterSnapshot } from "./chapter-ingest"

function snap(partial: Partial<ChapterSnapshot> = {}): ChapterSnapshot {
  return {
    chapterId: "ch-1",
    chapterNumber: 3,
    summary: "摘要",
    characters: [],
    locations: [],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: [],
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
    ...partial,
  }
}

describe("touchFoldTimestamp", () => {
  it("ctx.now 存在则推进时间戳", () => {
    const store = { lastUpdated: "old" }
    const out = touchFoldTimestamp(store, { now: "2026-01-01T00:00:00.000Z" })
    expect(out.lastUpdated).toBe("2026-01-01T00:00:00.000Z")
    expect(out).toBe(store)
  })

  it("无 ctx 则保留原值", () => {
    const store = { lastUpdated: "old" }
    touchFoldTimestamp(store)
    expect(store.lastUpdated).toBe("old")
  })

  it("ctx.now 缺省则保留原值", () => {
    const store = { lastUpdated: "old" }
    touchFoldTimestamp(store, {})
    expect(store.lastUpdated).toBe("old")
  })
})

describe("appendChapterOnce", () => {
  it("新章号追加并返回原数组", () => {
    const arr = [1, 2]
    expect(appendChapterOnce(arr, 3)).toBe(arr)
    expect(arr).toEqual([1, 2, 3])
  })

  it("已含章号不重复追加", () => {
    const arr = [1, 2]
    appendChapterOnce(arr, 2)
    expect(arr).toEqual([1, 2])
  })
})

describe("appendFoldNote", () => {
  it("空 detail 不写行、原 notes 不变", () => {
    expect(appendFoldNote("旧备注", 3, "推进", "")).toBe("旧备注")
    // 空白串为 truthy：仍写行（仅空串跳过）
    expect(appendFoldNote("", 3, "推进", "  ")).toBe("[第3章推进]   ")
  })

  it("无旧备注时单行", () => {
    expect(appendFoldNote("", 3, "推进", "发现密信")).toBe("[第3章推进] 发现密信")
  })

  it("有旧备注时换行累积", () => {
    expect(appendFoldNote("旧", 3, "回收", "真相揭晓")).toBe("旧\n[第3章回收] 真相揭晓")
  })
})

describe("parseCharacterStateChange", () => {
  it("半角冒号切分人名与描述", () => {
    expect(parseCharacterStateChange("林默：重伤昏迷")).toEqual({
      charName: "林默",
      changeDesc: "重伤昏迷",
    })
  })

  it("全角冒号同样切分", () => {
    expect(parseCharacterStateChange("林默：重伤")).toEqual({
      charName: "林默",
      changeDesc: "重伤",
    })
  })

  it("无冒号返回 null", () => {
    expect(parseCharacterStateChange("林默重伤")).toBeNull()
  })

  it("冒号在首位返回 null", () => {
    expect(parseCharacterStateChange("：重伤")).toBeNull()
  })
})

describe("parseForeshadowingChange", () => {
  it("新增：name-desc 切分", () => {
    expect(parseForeshadowingChange("新增伏笔：灰门-城门异动")).toEqual({
      kind: "add",
      name: "灰门",
      desc: "城门异动",
    })
  })

  it("新增短前缀 + 全角冒号 + 裸名", () => {
    expect(parseForeshadowingChange("新增：密信")).toEqual({
      kind: "add",
      name: "密信",
      desc: "",
    })
  })

  it("推进：捕获冒号后详情", () => {
    expect(parseForeshadowingChange("推进伏笔：灰门-守卫加强巡逻")).toEqual({
      kind: "advance",
      name: "灰门",
      desc: "守卫加强巡逻",
    })
  })

  it("推进裸名 desc 为空", () => {
    expect(parseForeshadowingChange("推进：灰门")).toEqual({
      kind: "advance",
      name: "灰门",
      desc: "",
    })
  })

  it("回收：捕获回收原因", () => {
    expect(parseForeshadowingChange("回收伏笔：密信-真相揭晓")).toEqual({
      kind: "resolve",
      name: "密信",
      desc: "真相揭晓",
    })
  })

  it("回收短前缀", () => {
    expect(parseForeshadowingChange("回收：密信")).toEqual({
      kind: "resolve",
      name: "密信",
      desc: "",
    })
  })

  it("无法识别的行返回 null", () => {
    expect(parseForeshadowingChange("今天天气不错")).toBeNull()
    expect(parseForeshadowingChange("   ")).toBeNull()
  })
})

describe("isDeathStatus", () => {
  it.each(["战死沙场", "身亡", "殒命", "病逝", "毙命"])("含死亡字 %s → true", (s) => {
    expect(isDeathStatus(s)).toBe(true)
  })

  it("空串与无关状态 → false", () => {
    expect(isDeathStatus("")).toBe(false)
    expect(isDeathStatus("重伤昏迷")).toBe(false)
  })
})

describe("normalizeForeshadowName / foreshadowNamesMatch", () => {
  it("归一：trim + 连续空白折叠", () => {
    expect(normalizeForeshadowName("  灰门  联络链  ")).toBe("灰门 联络链")
  })

  it("全等命中", () => {
    expect(foreshadowNamesMatch("灰门", "灰门")).toBe(true)
  })

  it("前后缀命中（部分名推进/回收场景）", () => {
    expect(foreshadowNamesMatch("黑剑", "黑剑碎片")).toBe(true)
    expect(foreshadowNamesMatch("黑剑碎片", "黑剑")).toBe(true)
  })

  it("单字名不命中长名（禁裸互含）", () => {
    expect(foreshadowNamesMatch("剑", "剑意")).toBe(false)
  })

  it("长名中缀不命中", () => {
    expect(foreshadowNamesMatch("剑法", "九剑法门")).toBe(false)
  })
})

describe("applyEmotionalArcsToStore", () => {
  it("arcChange 写入新 beat", () => {
    const store = createEmptyEmotionalArcStore()
    applyEmotionalArcsToStore(
      store,
      snap({ chapterNumber: 3, characterDetails: { 林默: { identity: "", faction: "", goals: "", arcChange: "决意" } } }),
    )
    expect(store.beats).toHaveLength(1)
    expect(store.beats[0]).toMatchObject({ character: "林默", chapterNumber: 3, emotion: "决意" })
  })

  it("空 arcChange 跳过", () => {
    const store = createEmptyEmotionalArcStore()
    applyEmotionalArcsToStore(
      store,
      snap({ characterDetails: { 林默: { identity: "", faction: "", goals: "", arcChange: "  " } } }),
    )
    expect(store.beats).toHaveLength(0)
  })

  it("数组 arcChange 以顿号连接", () => {
    const store = createEmptyEmotionalArcStore()
    applyEmotionalArcsToStore(
      store,
      snap({
        characterDetails: {
          林默: { identity: "", faction: "", goals: "", arcChange: ["愤怒", "决意"] as unknown as string },
        },
      }),
    )
    expect(store.beats[0].emotion).toBe("愤怒、决意")
  })

  it("同章重入 fold 更新既有 beat、不追加（幂等）", () => {
    const store = createEmptyEmotionalArcStore()
    const s = (emotion: string) =>
      snap({ chapterNumber: 3, characterDetails: { 林默: { identity: "", faction: "", goals: "", arcChange: emotion } } })
    applyEmotionalArcsToStore(store, s("愤怒"))
    applyEmotionalArcsToStore(store, s("决意"))
    expect(store.beats).toHaveLength(1)
    expect(store.beats[0].emotion).toBe("决意")
  })

  it("arcChange 非字符串/缺失按空处理并跳过", () => {
    const store = createEmptyEmotionalArcStore()
    applyEmotionalArcsToStore(
      store,
      snap({
        characterDetails: {
          林默: { identity: "", faction: "", goals: "", arcChange: undefined as unknown as string },
          苏晴: { identity: "", faction: "", goals: "", arcChange: 42 as unknown as string },
        },
      }),
    )
    expect(store.beats).toHaveLength(0)
  })

  it("ctx.now 推进时间戳、无 ctx 保留", () => {
    const store = createEmptyEmotionalArcStore()
    store.lastUpdated = "old"
    applyEmotionalArcsToStore(store, snap())
    expect(store.lastUpdated).toBe("old")
    applyEmotionalArcsToStore(store, snap(), undefined, { now: "n" })
    expect(store.lastUpdated).toBe("n")
  })
})

describe("applyResourceLedgerToStore", () => {
  it("新物品播种：holder/首章/transferredFrom/transferHistory", () => {
    const ledger = createEmptyResourceLedgerStore()
    applyResourceLedgerToStore(
      ledger,
      snap({
        chapterNumber: 5,
        itemDetails: { 宝剑: { holder: "林默", previousHolders: "铁匠", abilities: "", limitations: "", origin: "" } },
      }),
    )
    expect(ledger.entries).toHaveLength(1)
    expect(ledger.entries[0]).toMatchObject({
      item: "宝剑",
      currentHolder: "林默",
      acquiredChapter: 5,
      transferredFrom: "铁匠",
    })
    expect(ledger.entries[0].transferHistory).toEqual([{ fromChapter: 5, fromHolder: "", toHolder: "林默" }])
  })

  it("无 holder 播种：空持有、空历史", () => {
    const ledger = createEmptyResourceLedgerStore()
    applyResourceLedgerToStore(
      ledger,
      snap({ chapterNumber: 5, itemDetails: { 宝剑: { holder: "", previousHolders: "", abilities: "", limitations: "", origin: "" } } }),
    )
    expect(ledger.entries[0].currentHolder).toBe("")
    expect(ledger.entries[0].transferHistory).toEqual([])
  })

  it("holder 变更追加转移并更新持有者", () => {
    const ledger = createEmptyResourceLedgerStore()
    const s = (holder: string, ch: number) =>
      snap({ chapterNumber: ch, itemDetails: { 宝剑: { holder, previousHolders: "", abilities: "", limitations: "", origin: "" } } })
    applyResourceLedgerToStore(ledger, s("林默", 5))
    applyResourceLedgerToStore(ledger, s("苏晴", 6))
    expect(ledger.entries[0].currentHolder).toBe("苏晴")
    expect(ledger.entries[0].transferHistory).toHaveLength(2)
    expect(ledger.entries[0].transferHistory[1]).toEqual({ fromChapter: 6, fromHolder: "林默", toHolder: "苏晴" })
  })

  it("同 holder 重入不追加转移（幂等）", () => {
    const ledger = createEmptyResourceLedgerStore()
    const s = (ch: number) =>
      snap({ chapterNumber: ch, itemDetails: { 宝剑: { holder: "林默", previousHolders: "", abilities: "", limitations: "", origin: "" } } })
    applyResourceLedgerToStore(ledger, s(5))
    applyResourceLedgerToStore(ledger, s(5))
    expect(ledger.entries[0].transferHistory).toHaveLength(1)
  })

  it("空物品名跳过", () => {
    const ledger = createEmptyResourceLedgerStore()
    applyResourceLedgerToStore(
      ledger,
      snap({ itemDetails: { "": { holder: "林默", previousHolders: "", abilities: "", limitations: "", origin: "" } } }),
    )
    expect(ledger.entries).toHaveLength(0)
  })
})

describe("applySubplotChangesToStore", () => {
  function board() {
    const b = createEmptySubplotBoardStore()
    b.items = [
      { id: "s1", title: "主线复仇", status: "active", startChapter: 1, relatedCharacters: [], summary: "", progress: [], notes: "" },
      { id: "s2", title: "支线寻药", status: "active", startChapter: 1, relatedCharacters: [], summary: "", progress: [], notes: "" },
    ]
    return b
  }

  it("废弃伏笔但名称为空 → 跳过该条变更（不误弃任何子情节）", () => {
    const b = board()
    applySubplotChangesToStore(b, snap({ foreshadowingChanges: ["废弃："] }))
    expect(b.items.every((s) => s.abandoned !== true)).toBe(true)
  })

  it("回收伏笔 → targetResolutionChapter + resolved", () => {
    const b = board()
    applySubplotChangesToStore(b, snap({ chapterNumber: 7, foreshadowingChanges: ["回收伏笔：主线复仇-大仇得报"] }))
    const s1 = b.items[0]
    expect(s1.targetResolutionChapter).toBe(7)
    expect(s1.status).toBe("resolved")
    expect(s1.resolvedChapter).toBe(7)
    expect(b.items[1].status).toBe("active")
  })

  it("短前缀回收同样生效", () => {
    const b = board()
    applySubplotChangesToStore(b, snap({ chapterNumber: 7, foreshadowingChanges: ["回收：支线寻药"] }))
    expect(b.items[1].status).toBe("resolved")
  })

  it("回收空名跳过", () => {
    const b = board()
    applySubplotChangesToStore(b, snap({ foreshadowingChanges: ["回收："] }))
    expect(b.items.every((s) => s.status === "active")).toBe(true)
  })

  it("废弃 → abandoned + resolved", () => {
    const b = board()
    applySubplotChangesToStore(b, snap({ chapterNumber: 8, foreshadowingChanges: ["废弃伏笔：支线寻药-线已收束"] }))
    expect(b.items[1].abandoned).toBe(true)
    expect(b.items[1].status).toBe("resolved")
    expect(b.items[1].resolvedChapter).toBe(8)
  })

  it("events 含废弃 + subplot title → abandoned", () => {
    const b = board()
    applySubplotChangesToStore(b, snap({ chapterNumber: 9, events: ["主线复仇废弃，不再推进"] }))
    expect(b.items[0].abandoned).toBe(true)
    expect(b.items[0].status).toBe("resolved")
  })

  it("events 无废弃字样不处理", () => {
    const b = board()
    applySubplotChangesToStore(b, snap({ events: ["主线复仇取得进展"] }))
    expect(b.items[0].abandoned).toBeUndefined()
  })

  it("无法识别的 change 行不影响 board", () => {
    const b = board()
    applySubplotChangesToStore(b, snap({ foreshadowingChanges: ["新增伏笔：密信"] }))
    expect(b.items.every((s) => s.status === "active")).toBe(true)
  })

  it("已 resolved 的 subplot 重复回收不改 resolvedChapter", () => {
    const b = board()
    b.items[0].status = "resolved"
    b.items[0].resolvedChapter = 5
    applySubplotChangesToStore(b, snap({ chapterNumber: 7, foreshadowingChanges: ["回收：主线复仇"] }))
    expect(b.items[0].resolvedChapter).toBe(5)
    expect(b.items[0].targetResolutionChapter).toBe(7)
  })
})

describe("applyCharacterStateChangesToStore", () => {
  function storeWith(mod = "旧状态") {
    const s = createEmptyCharacterStateStore()
    s.characters = [
      {
        characterName: "林默",
        currentLocation: "",
        status: mod,
        equipment: [],
        abilities: [],
        relationships: {},
        lastUpdatedChapter: 1,
        lastUpdatedAt: "old",
        lastSeenChapter: 1,
      },
    ]
    return s
  }

  it("结构化行更新既有角色", () => {
    const s = storeWith()
    applyCharacterStateChangesToStore(s, snap({ chapterNumber: 4, characterStateChanges: ["林默：重伤昏迷"] }))
    expect(s.characters[0].status).toBe("重伤昏迷")
    expect(s.characters[0].lastUpdatedChapter).toBe(4)
    expect(s.characters[0].lastSeenChapter).toBe(4)
    expect(s.characters[0].lastUpdatedAt).toBe("old")
  })

  it("ctx.now 写入 lastUpdatedAt", () => {
    const s = storeWith()
    applyCharacterStateChangesToStore(s, snap({ chapterNumber: 4, characterStateChanges: ["林默：好转"] }), undefined, { now: "n" })
    expect(s.characters[0].lastUpdatedAt).toBe("n")
  })

  it("死亡状态写入 isAlive=false + deathChapter", () => {
    const s = storeWith()
    applyCharacterStateChangesToStore(s, snap({ chapterNumber: 4, characterStateChanges: ["林默：战死沙场"] }))
    expect(s.characters[0].isAlive).toBe(false)
    expect(s.characters[0].deathChapter).toBe(4)
  })

  it("新角色追加（无 ctx 时 lastUpdatedAt 为空串）", () => {
    const s = storeWith()
    applyCharacterStateChangesToStore(s, snap({ chapterNumber: 4, characterStateChanges: ["苏晴：加入队伍"] }))
    expect(s.characters).toHaveLength(2)
    expect(s.characters[1]).toMatchObject({ characterName: "苏晴", status: "加入队伍", lastUpdatedChapter: 4, lastUpdatedAt: "" })
    expect(s.characters[1].isAlive).toBeUndefined()
  })

  it("新角色死亡直接标记", () => {
    const s = createEmptyCharacterStateStore()
    applyCharacterStateChangesToStore(s, snap({ chapterNumber: 4, characterStateChanges: ["路人：身亡"] }), undefined, { now: "n" })
    expect(s.characters[0]).toMatchObject({ isAlive: false, deathChapter: 4, lastUpdatedAt: "n" })
  })

  it("非结构化行按子串兜底匹配", () => {
    const s = storeWith()
    applyCharacterStateChangesToStore(s, snap({ chapterNumber: 4, characterStateChanges: ["林默身亡于城头"] }))
    expect(s.characters[0].status).toBe("林默身亡于城头")
    expect(s.characters[0].isAlive).toBe(false)
    expect(s.characters[0].deathChapter).toBe(4)
  })

  it("兜底无匹配则无操作", () => {
    const s = storeWith()
    applyCharacterStateChangesToStore(s, snap({ characterStateChanges: ["无人提及的路人甲闲逛"] }))
    expect(s.characters).toHaveLength(1)
    expect(s.characters[0].status).toBe("旧状态")
  })
})

describe("applyForeshadowingChangesToStore", () => {
  it("新增伏笔入账（id/字段齐全）", () => {
    const store = createEmptyForeshadowingStore()
    applyForeshadowingChangesToStore(store, snap({ chapterNumber: 2, foreshadowingChanges: ["新增伏笔：灰门-城门异动"] }))
    expect(store.items).toHaveLength(1)
    expect(store.items[0]).toMatchObject({
      id: "fs-2-1",
      name: "灰门",
      description: "城门异动",
      status: "planted",
      plantedChapter: 2,
    })
  })

  it("同章同名新增幂等：更新描述不追加", () => {
    const store = createEmptyForeshadowingStore()
    const s = (desc: string) => snap({ chapterNumber: 2, foreshadowingChanges: [`新增伏笔：灰门-${desc}`] })
    applyForeshadowingChangesToStore(store, s("旧描述"))
    applyForeshadowingChangesToStore(store, s("新描述"))
    expect(store.items).toHaveLength(1)
    expect(store.items[0].description).toBe("新描述")
  })

  it("推进：状态/章次/备注累积", () => {
    const store = createEmptyForeshadowingStore()
    applyForeshadowingChangesToStore(store, snap({ chapterNumber: 2, foreshadowingChanges: ["新增：灰门"] }))
    applyForeshadowingChangesToStore(store, snap({ chapterNumber: 3, foreshadowingChanges: ["推进：灰门-守卫加强"] }))
    expect(store.items[0].status).toBe("advanced")
    expect(store.items[0].advancedChapters).toEqual([3])
    expect(store.items[0].notes).toBe("[第3章推进] 守卫加强")
  })

  it("推进同章重复不重复记章", () => {
    const store = createEmptyForeshadowingStore()
    applyForeshadowingChangesToStore(store, snap({ chapterNumber: 2, foreshadowingChanges: ["新增：灰门"] }))
    const s = snap({ chapterNumber: 3, foreshadowingChanges: ["推进：灰门-甲", "推进：灰门-乙"] })
    applyForeshadowingChangesToStore(store, s)
    expect(store.items[0].advancedChapters).toEqual([3])
    expect(store.items[0].notes).toContain("甲")
    expect(store.items[0].notes).toContain("乙")
  })

  it("推进空详情不写备注行", () => {
    const store = createEmptyForeshadowingStore()
    applyForeshadowingChangesToStore(store, snap({ chapterNumber: 2, foreshadowingChanges: ["新增：灰门"] }))
    applyForeshadowingChangesToStore(store, snap({ chapterNumber: 3, foreshadowingChanges: ["推进：灰门"] }))
    expect(store.items[0].status).toBe("advanced")
    expect(store.items[0].notes).toBe("")
  })

  it("回收：状态/resolvedChapter/备注", () => {
    const store = createEmptyForeshadowingStore()
    applyForeshadowingChangesToStore(store, snap({ chapterNumber: 2, foreshadowingChanges: ["新增：灰门"] }))
    applyForeshadowingChangesToStore(store, snap({ chapterNumber: 5, foreshadowingChanges: ["回收：灰门-真相揭晓"] }))
    expect(store.items[0].status).toBe("resolved")
    expect(store.items[0].resolvedChapter).toBe(5)
    expect(store.items[0].notes).toBe("[第5章回收] 真相揭晓")
  })

  it("推进/回收目标不存在则跳过", () => {
    const store = createEmptyForeshadowingStore()
    applyForeshadowingChangesToStore(store, snap({ foreshadowingChanges: ["推进：不存在", "回收：不存在"] }))
    expect(store.items).toHaveLength(0)
  })

  it("无法识别的行跳过", () => {
    const store = createEmptyForeshadowingStore()
    applyForeshadowingChangesToStore(store, snap({ foreshadowingChanges: ["今天天气不错"] }))
    expect(store.items).toHaveLength(0)
  })
})
