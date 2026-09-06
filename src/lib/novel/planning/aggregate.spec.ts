import { describe, expect, it } from "vitest"
import { buildChapterPlanView, type ChapterPlanInput } from "./aggregate"
import type { ForeshadowingStore } from "../foreshadowing-tracker"
import type { CharacterStateStore } from "../character-state"
import type { Subplot } from "../subplot-board"

function makeForeshadowingStore(): ForeshadowingStore {
  return {
    lastUpdated: "2026-08-18T00:00:00.000Z",
    items: [
      {
        id: "f1",
        name: "青铜古戒",
        description: "主角戒指的秘密",
        status: "planted",
        plantedChapter: 2,
        advancedChapters: [],
        relatedCharacters: ["林动"],
        relatedEvents: [],
        notes: "",
      },
      {
        id: "f2",
        name: "神秘黑衣人",
        description: "幕后黑手",
        status: "advanced",
        plantedChapter: 1,
        advancedChapters: [5],
        relatedCharacters: [],
        relatedEvents: [],
        notes: "",
      },
      {
        id: "f3",
        name: "已回收伏笔",
        description: "已解决",
        status: "resolved",
        plantedChapter: 1,
        advancedChapters: [3],
        resolvedChapter: 4,
        relatedCharacters: [],
        relatedEvents: [],
        notes: "",
      },
    ],
  }
}

function makeCharacterStore(): CharacterStateStore {
  return {
    lastUpdated: "2026-08-18T00:00:00.000Z",
    characters: [
      {
        characterName: "林动",
        currentLocation: "青山镇",
        status: "健康",
        equipment: [],
        abilities: [],
        relationships: {},
        lastUpdatedChapter: 3,
        lastUpdatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        characterName: "应欢欢",
        currentLocation: "道宗",
        status: "闭关",
        equipment: [],
        abilities: [],
        relationships: {},
        lastUpdatedChapter: 1,
        lastUpdatedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  }
}

function makeSubplots(): Subplot[] {
  return [
    {
      id: "s1",
      title: "宗门大比",
      status: "active",
      startChapter: 1,
      relatedCharacters: ["林动"],
      summary: "",
      progress: ["第1章：报名", "第2章：初赛", "第3章：复赛", "第4章：决赛"],
      notes: "",
    },
    {
      id: "s2",
      title: "寻父线",
      status: "active",
      startChapter: 1,
      relatedCharacters: [],
      summary: "",
      progress: ["第1章：线索"],
      notes: "",
    },
  ]
}

function makeInput(overrides: Partial<ChapterPlanInput> = {}): ChapterPlanInput {
  return {
    currentChapter: 8,
    chapterOutline: "林动在青山镇与应欢欢重逢，宗门大比决战开启",
    foreshadowing: makeForeshadowingStore(),
    characterStates: makeCharacterStore(),
    appearances: [
      { character: "林动", chapters: [1, 2, 3, 5, 7] },
      { character: "应欢欢", chapters: [1] },
    ],
    subplots: makeSubplots(),
    ...overrides,
  }
}

describe("buildChapterPlanView", () => {
  it("组合三类数据并产出 summary（债务分/开放支线/逾期角色）", () => {
    const view = buildChapterPlanView(makeInput())
    expect(view.chapterNumber).toBe(8)
    expect(view.summary.openThreads).toBe(2)
    // 逾期角色：应欢欢上次第1章出场，距第8章 7 章 < 10 → 不计；林动大纲命中 → 不计
    expect(view.summary.charactersDue).toBe(0)
    expect(view.foreshadowing.status).toBe("ok")
    expect(view.characters.status).toBe("ok")
    expect(view.threads.status).toBe("ok")
  })

  it("伏笔按 debtLevel 排序且 resolved 被排除", () => {
    const view = buildChapterPlanView(makeInput())
    const names = view.foreshadowing.report!.items.map((i) => i.name)
    // 第2章植入的 planted 伏笔（8-2=6 章）应为 critical 或 warning，排在 advanced 之前
    expect(names).not.toContain("已回收伏笔")
    expect(names[0]).toBe("青铜古戒")
  })

  it("角色按大纲命中优先、其次最久未出场排序", () => {
    // 大纲只命中林动（应欢欢不在大纲 → 未命中优先序靠后）
    const view = buildChapterPlanView(makeInput({ chapterOutline: "林动在青山镇修炼，宗门大比决战开启" }))
    const items = view.characters.items
    expect(items[0].name).toBe("林动")
    expect(items[0].inCurrentOutline).toBe(true)
    expect(items[1].name).toBe("应欢欢")
    expect(items[1].inCurrentOutline).toBe(false)
    // 应欢欢 store.lastSeenChapter=1，快照出场 [1] → 距第8章 7 章
    expect(items[1].chaptersSinceSeen).toBe(7)
  })

  it("lastSeen 取 store 与快照出场索引的较新者", () => {
    const view = buildChapterPlanView(makeInput({ chapterOutline: "林动在青山镇修炼" }))
    const lin = view.characters.items.find((c) => c.name === "林动")!
    // store.lastSeenChapter=3，快照出场末位 7 → 取 7
    expect(lin.lastSeenChapter).toBe(7)
    expect(lin.chaptersSinceSeen).toBe(1)
  })

  it("dormantThreshold 生效：超过阈值的未出场角色计入 charactersDue", () => {
    const view = buildChapterPlanView(
      makeInput({ chapterOutline: "林动在青山镇修炼，宗门大比决战开启" }),
      { dormantThreshold: 5 },
    )
    expect(view.summary.charactersDue).toBe(1)
  })

  it("无大纲时 inCurrentOutline 全 false 且不抛错", () => {
    const view = buildChapterPlanView(makeInput({ chapterOutline: undefined }))
    expect(view.characters.items.every((c) => !c.inCurrentOutline)).toBe(true)
  })

  it("空数据源 → ok 状态 + 空列表（合法空数据非 degraded）", () => {
    const view = buildChapterPlanView(
      makeInput({
        foreshadowing: { items: [], lastUpdated: "" },
        characterStates: { characters: [], lastUpdated: "" },
        appearances: [],
        subplots: [],
      }),
    )
    expect(view.foreshadowing.status).toBe("ok")
    expect(view.foreshadowing.report!.items).toEqual([])
    expect(view.characters.items).toEqual([])
    expect(view.threads.items).toEqual([])
    expect(view.summary.openThreads).toBe(0)
  })

  it("foreshadowingTopN / charactersTopN 截断生效", () => {
    const view = buildChapterPlanView(makeInput(), { foreshadowingTopN: 1, charactersTopN: 1 })
    expect(view.foreshadowing.report!.items).toHaveLength(1)
    expect(view.characters.items).toHaveLength(1)
  })

  it("同 debtLevel 伏笔按 chaptersSincePlanted 降序（rankDiff === 0 分支）", () => {
    const store = makeForeshadowingStore()
    // 两个 normal 级伏笔：植入章 1 与 3 → 距第8章 7 与 5 → 7 在前
    store.items = [
      { ...store.items[0], id: "n1", name: "普通伏笔A", status: "planted", plantedChapter: 3 },
      { ...store.items[0], id: "n2", name: "普通伏笔B", status: "planted", plantedChapter: 1 },
    ]
    const view = buildChapterPlanView(makeInput({ foreshadowing: store }))
    expect(view.foreshadowing.report!.items.map((i) => i.name)).toEqual(["普通伏笔B", "普通伏笔A"])
  })

  it("大纲命中排序：a 命中 b 未命中 → a 在前（三元 truthy 分支）", () => {
    const store = makeCharacterStore()
    // 未命中角色放最前 → 排序时 comparator(a=命中, b=未命中) 必然出现
    store.characters.unshift({
      characterName: "绫清竹",
      currentLocation: "大炎王朝",
      status: "健康",
      equipment: [],
      abilities: [],
      relationships: {},
      lastUpdatedChapter: 2,
      lastUpdatedAt: "2026-08-01T00:00:00.000Z",
    })
    const view = buildChapterPlanView(
      makeInput({ chapterOutline: "林动与应欢欢重逢，宗门大比决战开启", characterStates: store }),
    )
    const names = view.characters.items.map((c) => c.name)
    expect(names.indexOf("林动")).toBeLessThan(names.indexOf("绫清竹"))
    expect(names.indexOf("应欢欢")).toBeLessThan(names.indexOf("绫清竹"))
  })

  it("无出场记录角色 lastSeenChapter undefined → 排序按 MAX 兜底", () => {
    const store = makeCharacterStore()
    store.characters.push({
      characterName: "新角色",
      currentLocation: "未知",
      status: "健康",
      equipment: [],
      abilities: [],
      relationships: {},
      lastUpdatedChapter: 0,
      lastUpdatedAt: "2026-08-01T00:00:00.000Z",
    })
    const view = buildChapterPlanView(
      makeInput({ chapterOutline: undefined, characterStates: store, appearances: [] }),
    )
    const item = view.characters.items.find((c) => c.name === "新角色")!
    expect(item.lastSeenChapter).toBeUndefined()
    // 无出场者排最后
    expect(view.characters.items[view.characters.items.length - 1].name).toBe("新角色")
  })
})

// ============================ P2-IMP-11 四新维 ============================

import type { CognitionState } from "../character-cognition"
import type { EncounterMatrixStore } from "../encounter-matrix"
import type { ParticleLedgerStore } from "../particle-ledger"
import type { ResourceLedgerStore } from "../resource-ledger"
import type { ChapterSummariesStore } from "../chapter-summaries"
import type { PlanSource } from "./aggregate"
import { PLAN_DIMENSION_CHAR_BUDGET } from "./aggregate"

function okSource<TData>(data: TData): PlanSource<TData> {
  return { status: "ok", data }
}

function degradedSource<TData>(): PlanSource<TData> {
  return { status: "degraded", data: null }
}

function makeCognition(): CognitionState {
  return {
    characters: [
      {
        character: "林动",
        knows: ["父亲失踪"],
        doesNotKnow: ["黑市入口在城西", "神秘黑衣人是他父亲"],
      },
      { character: "应欢欢", knows: [], doesNotKnow: ["林动左臂受伤"] },
    ],
    readerKnows: [],
    lastUpdatedChapter: 7,
  }
}

function makeMatrix(): EncounterMatrixStore {
  return {
    edges: [
      { a: "林动", b: "应欢欢", chapter: 3, context: "青山镇", witnessedBy: [] },
      // 本章（第 8 章）共现 —— 'past' 口径必须排除（P2-IMP-05 复用）
      { a: "林动", b: "绫清竹", chapter: 8, context: "宗门大比", witnessedBy: [] },
      // 未来章边 —— 两种口径都排除
      { a: "林动", b: "赫费", chapter: 9, context: "未来", witnessedBy: [] },
    ],
    lastUpdated: "",
  }
}

function makeParticles(): ParticleLedgerStore {
  return {
    entries: [
      { kind: "money", character: "林动", name: "灵石", chapter: 2, delta: 100, state: "余额 100", note: "" },
      { kind: "injury", character: "林动", name: "左臂", chapter: 7, delta: 1, state: "骨折未愈", note: "" },
      { kind: "technique", character: "林动", name: "大荒掌印", chapter: 5, delta: 1, state: "第三重", note: "" },
      // 非 POV 持有 —— 必须被过滤
      { kind: "money", character: "应欢欢", name: "银两", chapter: 4, delta: 20, state: "余额 20", note: "" },
    ],
    lastUpdated: "",
  }
}

function makeResources(): ResourceLedgerStore {
  return {
    entries: [
      { item: "青铜古戒", currentHolder: "林动", acquiredChapter: 2, transferHistory: [] },
    ],
    lastUpdated: "",
  }
}

function makeSummaries(): ChapterSummariesStore {
  return {
    entries: [
      {
        chapter: 5,
        happened: "第五章发生了什么",
        stateChanges: [{ kind: "character", entity: "林动", change: "林动：突破到造形境" }],
        keyReveals: [],
        endingHook: "",
      },
      {
        chapter: 6,
        happened: "第六章发生了什么",
        stateChanges: [{ kind: "relationship", entity: "林动/应欢欢", change: "林动与应欢欢：结盟" }],
        keyReveals: [],
        endingHook: "",
      },
      {
        chapter: 7,
        happened: "第七章发生了什么",
        stateChanges: [{ kind: "item", entity: "青铜古戒", change: "归属 → 林动" }],
        keyReveals: [],
        endingHook: "",
      },
      {
        chapter: 8,
        happened: "第八章发生了什么",
        stateChanges: [{ kind: "character", entity: "林动", change: "林动：左臂骨折" }],
        keyReveals: [],
        endingHook: "",
      },
    ],
    lastUpdated: "",
  }
}

/** 四新维源齐备的输入（POV = 林动，当前第 8 章） */
function makePovInput(overrides: Partial<ChapterPlanInput> = {}): ChapterPlanInput {
  return {
    currentChapter: 8,
    chapterOutline: "林动在宗门大比决战",
    foreshadowing: makeForeshadowingStore(),
    characterStates: makeCharacterStore(),
    appearances: [{ character: "林动", chapters: [1, 2, 3, 5, 7] }],
    subplots: makeSubplots(),
    povCharacter: "林动",
    cognition: okSource(makeCognition()),
    encounterMatrix: okSource(makeMatrix()),
    resources: okSource(makeResources()),
    particles: okSource(makeParticles()),
    chapterSummaries: okSource(makeSummaries()),
    ...overrides,
  }
}

describe("buildChapterPlanView — P2-IMP-11 四新维三态", () => {
  it("四源各有 → 四维 ok 且条目来自既有契约函数", () => {
    const view = buildChapterPlanView(makePovInput())
    expect(view.povCharacter).toBe("林动")
    expect(view.cognition!.status).toBe("ok")
    expect(view.cognition!.items).toEqual(["黑市入口在城西", "神秘黑衣人是他父亲"])
    expect(view.encounter!.status).toBe("ok")
    expect(view.encounter!.items).toEqual(["应欢欢"])
    expect(view.particles!.status).toBe("ok")
    expect(view.particles!.items.map((p) => p.kind)).toEqual(["money", "injury", "technique"])
    expect(view.recentStateDeltas!.status).toBe("ok")
    // 默认取近 3 章（6/7/8）且最近优先
    expect(view.recentStateDeltas!.items.map((d) => d.chapter)).toEqual([8, 7, 6])
  })

  it("四源全缺（无 POV + 无 store）→ 四维 degraded 且视图仍完整产出（绝不整体失败）", () => {
    const view = buildChapterPlanView(
      makeInput({
        povCharacter: undefined,
        cognition: undefined,
        encounterMatrix: undefined,
        resources: undefined,
        particles: undefined,
        chapterSummaries: undefined,
      }),
    )
    expect(view.cognition!.status).toBe("degraded")
    expect(view.encounter!.status).toBe("degraded")
    expect(view.particles!.status).toBe("degraded")
    expect(view.recentStateDeltas!.status).toBe("degraded")
    expect(view.cognition!.items).toEqual([])
    expect(view.cognition!.text).toBe("")
    expect(view.cognition!.reason).toContain("POV")
    expect(view.recentStateDeltas!.reason).toContain("章节摘要")
    // 既有三维不受影响
    expect(view.foreshadowing.status).toBe("ok")
    expect(view.characters.items.length).toBeGreaterThan(0)
  })

  it("部分降级：POV 已声明但见面矩阵/粒子源不可用 → 只降该两维，认知与状态变更仍 ok", () => {
    const view = buildChapterPlanView(
      makePovInput({
        encounterMatrix: degradedSource<EncounterMatrixStore>(),
        particles: degradedSource<ParticleLedgerStore>(),
      }),
    )
    expect(view.encounter!.status).toBe("degraded")
    expect(view.encounter!.reason).toContain("见面矩阵")
    expect(view.particles!.status).toBe("degraded")
    expect(view.particles!.reason).toContain("粒子账本")
    expect(view.cognition!.status).toBe("ok")
    expect(view.cognition!.items).toHaveLength(2)
    expect(view.recentStateDeltas!.status).toBe("ok")
  })

  it("合法空数据（源在但无条目）→ ok 而非 degraded（面板可区分空与不可用）", () => {
    const view = buildChapterPlanView(
      makePovInput({
        cognition: okSource({ characters: [], readerKnows: [], lastUpdatedChapter: 0 }),
        encounterMatrix: okSource({ edges: [], lastUpdated: "" }),
        particles: okSource({ entries: [], lastUpdated: "" }),
        chapterSummaries: okSource({ entries: [], lastUpdated: "" }),
      }),
    )
    expect(view.cognition!.status).toBe("ok")
    expect(view.cognition!.items).toEqual([])
    expect(view.encounter!.status).toBe("ok")
    expect(view.particles!.status).toBe("ok")
    expect(view.recentStateDeltas!.status).toBe("ok")
    expect(view.recentStateDeltas!.truncated).toBe(false)
  })

  it("cognition 装载抛错（degraded）与文件缺失（ok + null data）语义可区分", () => {
    const corrupt = buildChapterPlanView(makePovInput({ cognition: degradedSource<CognitionState | null>() }))
    expect(corrupt.cognition!.status).toBe("degraded")
    const missing = buildChapterPlanView(makePovInput({ cognition: okSource<CognitionState | null>(null) }))
    expect(missing.cognition!.status).toBe("ok")
    expect(missing.cognition!.items).toEqual([])
  })

  it("resources 缺失不影响四新维（heldItems 不进计划渲染面）", () => {
    const view = buildChapterPlanView(makePovInput({ resources: degradedSource<ResourceLedgerStore>() }))
    expect(view.cognition!.status).toBe("ok")
    expect(view.encounter!.status).toBe("ok")
    expect(view.particles!.status).toBe("ok")
  })

  it("POV 别名形态经 resolveCanonicalName 归一后仍能命中（单一可见性契约复用）", () => {
    const cognition: CognitionState = {
      characters: [{ character: "菜月昴", knows: [], doesNotKnow: ["艾蜜莉雅的真实身份"] }],
      readerKnows: [],
      lastUpdatedChapter: 3,
    }
    const view = buildChapterPlanView(
      makePovInput({
        povCharacter: "菜月・昴",
        cognition: okSource(cognition),
        encounterMatrix: okSource({ edges: [], lastUpdated: "" }),
        particles: okSource({ entries: [], lastUpdated: "" }),
      }),
    )
    expect(view.cognition!.status).toBe("ok")
    expect(view.cognition!.items).toEqual(["艾蜜莉雅的真实身份"])
  })
})

describe("buildChapterPlanView — P2-IMP-11 逐维预算封顶（TencentDB L0-L3 模式）", () => {
  it("逐维 topN 生效且互不挤占（认知 1 / 粒子 2 / 状态变更 2）", () => {
    const view = buildChapterPlanView(makePovInput(), {
      cognitionTopN: 1,
      particlesTopN: 2,
      stateDeltaTopN: 2,
      encounterTopN: 1,
    })
    expect(view.cognition!.items).toHaveLength(1)
    expect(view.cognition!.truncated).toBe(true)
    expect(view.particles!.items).toHaveLength(2)
    expect(view.particles!.truncated).toBe(true)
    expect(view.recentStateDeltas!.items).toHaveLength(2)
    expect(view.encounter!.items).toHaveLength(1)
    expect(view.encounter!.truncated).toBe(false)
  })

  it("字符预算封顶按整行丢弃（不切半行）并标 truncated", () => {
    // 两行分别 10 / 7 字，拼接成本 10 + 1 + 7 = 18 > 15 → 第二行整行丢弃
    const budget = 15
    const view = buildChapterPlanView(
      makePovInput({
        cognition: okSource({
          characters: [{ character: "林动", knows: [], doesNotKnow: ["一二三四五六七八九十", "另一条盲区事实"] }],
          readerKnows: [],
          lastUpdatedChapter: 1,
        }),
      }),
      { dimensionCharBudget: budget },
    )
    expect(view.cognition!.status).toBe("ok")
    expect(view.cognition!.text).toBe("一二三四五六七八九十")
    expect(view.cognition!.text.length).toBeLessThanOrEqual(budget)
    // items 与 text 行一一对应（面板与 prefill 共用同一份截断结果）
    expect(view.cognition!.items).toEqual(["一二三四五六七八九十"])
    expect(view.cognition!.truncated).toBe(true)
  })

  it("预算 0 → 整维清空但仍 ok（可见截断而非静默）", () => {
    const view = buildChapterPlanView(makePovInput(), { dimensionCharBudget: 0 })
    expect(view.cognition!.status).toBe("ok")
    expect(view.cognition!.text).toBe("")
    expect(view.cognition!.items).toEqual([])
    expect(view.cognition!.truncated).toBe(true)
    expect(view.recentStateDeltas!.truncated).toBe(true)
  })

  it("默认预算下不截断（预算足够容纳默认 topN）", () => {
    expect(PLAN_DIMENSION_CHAR_BUDGET).toBeGreaterThan(0)
    const view = buildChapterPlanView(makePovInput())
    expect(view.cognition!.truncated).toBe(false)
    expect(view.encounter!.truncated).toBe(false)
    expect(view.particles!.truncated).toBe(false)
    expect(view.recentStateDeltas!.truncated).toBe(false)
    expect(view.cognition!.text).toBe("黑市入口在城西\n神秘黑衣人是他父亲")
    expect(view.particles!.text).toBe("[money] 灵石 → 余额 100\n[injury] 左臂 → 骨折未愈\n[technique] 大荒掌印 → 第三重")
  })

  it("stateDeltaChapters 窗口生效：只取近 1 章", () => {
    const view = buildChapterPlanView(makePovInput(), { stateDeltaChapters: 1 })
    expect(view.recentStateDeltas!.items.map((d) => d.chapter)).toEqual([8])
  })
})
