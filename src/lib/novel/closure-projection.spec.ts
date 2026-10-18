/**
 * closure-projection — Closure 级叙事结构面只读投影。
 *
 * 断言都「可失败」：空真源必须得空数组 + 逐条中文 N/A；有数据必须得正确行数/字段；
 * 排序必须是码点序（localeCompare 会给相反结果，见「排序用码点比较」用例）；
 * 真实 loader 必须真读既有 `.novel/` 真源（读不到 → 空 + N/A，不造数据）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: (path: string) => mocks.readFile(path),
  }
})

import { loadClosureProjection, projectClosureState } from "./closure-projection"
import { TEMPORAL_OPEN, type NarrativeDeclaration, type VisibilityDeclaration } from "./narrative-state"

function decl(overrides: Partial<NarrativeDeclaration>): NarrativeDeclaration {
  return {
    declarationId: "d1",
    entityId: "loc-cafe",
    entityType: "location",
    property: "atmosphere",
    description: "咖啡厅角落有暗门",
    modality: "fact",
    validFrom: "ch1",
    validTo: TEMPORAL_OPEN,
    recordedAt: "t1",
    ...overrides,
  }
}

function vis(overrides: Partial<VisibilityDeclaration>): VisibilityDeclaration {
  return {
    declarationId: "d1",
    characterId: "c1",
    state: "known",
    source: "explicit",
    validFrom: "ch1",
    validTo: TEMPORAL_OPEN,
    isExplicit: true,
    ...overrides,
  }
}

describe("projectClosureState（纯函数）", () => {
  it("空真源（无参）→ 三个空数组 + 逐条中文 N/A，不造 0 行", () => {
    const p = projectClosureState()

    expect(p.infoGaps).toEqual([])
    expect(p.worldEvents).toEqual([])
    expect(p.ripples).toEqual([])
    expect(p.missingSources).toHaveLength(4)
    expect(p.missingSources[0]).toContain("信息差")
    expect(p.missingSources[1]).toContain(".novel/timeline.json")
    expect(p.missingSources[2]).toContain("故事时间级")
    expect(p.missingSources[3]).toContain("涟漪")
  })

  it("显式 null 真源与无参等价（缺源不是空对象）", () => {
    const p = projectClosureState({ narrativeState: null, timelineEntries: null })
    expect(p.infoGaps).toEqual([])
    expect(p.worldEvents).toEqual([])
    expect(p.ripples).toEqual([])
    expect(p.missingSources).toHaveLength(4)
  })

  it("有声明 → 信息差行字段正确；章号无真源 → null（不写 0）；计数为真实值", () => {
    const p = projectClosureState({
      narrativeState: {
        declarations: [
          decl({
            declarationId: "d2",
            entityId: "hero",
            property: "identity",
            modality: "belief",
            description: "其实是旧王之子",
          }),
          decl({ declarationId: "d1" }),
        ],
        visibilities: [
          vis({ declarationId: "d1", characterId: "c2", state: "unknown" }),
          vis({ declarationId: "d1", characterId: "c1", state: "known" }),
          // 同一角色重复可见性 → 计数必须去重（否则 2 是假的）
          vis({ declarationId: "d1", characterId: "c1", state: "known" }),
        ],
      },
    })

    expect(p.infoGaps.map((r) => r.id)).toEqual(["d1", "d2"])
    const d1 = p.infoGaps[0]
    expect(d1.kind).toBe("info-gap")
    expect(d1.source).toBe(".novel/narrative-state.json")
    expect(d1.label).toBe("loc-cafe.atmosphere")
    expect(d1.detail).toBe("咖啡厅角落有暗门")
    expect(d1.modality).toBe("fact")
    expect(d1.storyTime).toBe("ch1")
    expect(d1.chapterNumber).toBeNull()
    expect(d1.knownCount).toBe(1)
    expect(d1.unknownCount).toBe(1)
    expect(d1.relatedIds).toEqual(["c1", "c2"])
    expect(d1.consequenceCount).toBeNull()

    // d2 没有任何可见性 → 0/0 是**真实计数**（有真源），不是缺失
    expect(p.infoGaps[1].knownCount).toBe(0)
    expect(p.infoGaps[1].unknownCount).toBe(0)
    expect(p.infoGaps[1].relatedIds).toEqual([])
    expect(p.infoGaps[1].modality).toBe("belief")

    expect(p.missingSources.some((s) => s.includes("信息差"))).toBe(false)
  })

  it("排序用码点比较：大写字母排在小写之前（localeCompare 会给相反结果）", () => {
    const p = projectClosureState({
      narrativeState: {
        declarations: [decl({ declarationId: "a1" }), decl({ declarationId: "B2" })],
      },
    })
    // 码点：'B'(66) < 'a'(97)；localeCompare("a1","B2") 会返回 -1（顺序相反）
    expect(p.infoGaps.map((r) => r.id)).toEqual(["B2", "a1"])
  })

  it("timeline entries → 章级世界事件行（章号升序；故事时间无真源 → null）", () => {
    const p = projectClosureState({
      timelineEntries: [
        { chapterNumber: 3, event: "城门失守" },
        { chapterNumber: 1, event: "王子出走" },
      ],
    })

    expect(p.worldEvents.map((r) => r.id)).toEqual(["timeline:1:王子出走", "timeline:3:城门失守"])
    const first = p.worldEvents[0]
    expect(first.kind).toBe("world-event")
    expect(first.source).toBe(".novel/timeline.json")
    expect(first.label).toBe("王子出走")
    expect(first.chapterNumber).toBe(1)
    expect(first.storyTime).toBeNull()
    expect(first.detail).toBeNull()
    expect(first.modality).toBeNull()
    expect(first.knownCount).toBeNull()
    expect(first.unknownCount).toBeNull()
    expect(first.consequenceCount).toBeNull()
    expect(p.missingSources.some((s) => s.includes("timeline.json"))).toBe(false)
  })

  it("narrative-state events → 故事时间级世界事件行；有章号的行排在前", () => {
    const p = projectClosureState({
      timelineEntries: [{ chapterNumber: 2, event: "章级事件" }],
      narrativeState: {
        events: [
          { eventId: "e2", type: "death", storyTime: "ch9", entityId: "hero", causedBy: "e1", summary: "英雄死亡" },
          { eventId: "e1", type: "birth", storyTime: "ch1", entityId: "hero", summary: "英雄出生" },
        ],
      },
    })

    expect(p.worldEvents.map((r) => r.id)).toEqual(["timeline:2:章级事件", "event:e1", "event:e2"])
    const e2 = p.worldEvents[2]
    expect(e2.source).toBe(".novel/narrative-state.json")
    expect(e2.label).toBe("英雄死亡")
    expect(e2.storyTime).toBe("ch9")
    expect(e2.chapterNumber).toBeNull()
    expect(e2.relatedIds).toEqual(["e1"])
    expect(p.missingSources.some((s) => s.includes("故事时间级"))).toBe(false)
  })

  it("涟漪：沿 causedBy 派生直接下游（不做传递闭包），下游 id 码点升序", () => {
    const p = projectClosureState({
      narrativeState: {
        events: [
          { eventId: "root", type: "change", storyTime: "ch1", entityId: "world", summary: "王城大火" },
          { eventId: "b2", type: "change", storyTime: "ch2", entityId: "a", causedBy: "root" },
          { eventId: "A1", type: "death", storyTime: "ch3", entityId: "b", causedBy: "root" },
          { eventId: "leaf", type: "change", storyTime: "ch4", entityId: "c", causedBy: "b2" },
        ],
      },
    })

    expect(p.ripples.map((r) => r.id)).toEqual(["ripple:b2", "ripple:root"])
    const root = p.ripples[1]
    expect(root.kind).toBe("ripple")
    expect(root.label).toBe("王城大火")
    expect(root.consequenceCount).toBe(2)
    expect(root.relatedIds).toEqual(["A1", "b2"])
    expect(root.storyTime).toBe("ch1")
    expect(root.chapterNumber).toBeNull()

    // b2 的直接下游只有 leaf（root 是它的上游，不算涟漪下游）
    expect(p.ripples[0].consequenceCount).toBe(1)
    expect(p.ripples[0].relatedIds).toEqual(["leaf"])
    expect(p.missingSources.some((s) => s.includes("涟漪"))).toBe(false)
  })

  it("有事件但无 causedBy → 涟漪空数组 + N/A（不造空行假装有涟漪）", () => {
    const p = projectClosureState({
      narrativeState: { events: [{ eventId: "e1", type: "birth", storyTime: "ch1", entityId: "x" }] },
    })

    expect(p.ripples).toEqual([])
    expect(p.missingSources.some((s) => s.includes("涟漪"))).toBe(true)
    expect(p.worldEvents).toHaveLength(1)
  })

  it("causedBy 悬空 → 仍投影该上游行并如实标注（不静默丢行）", () => {
    const p = projectClosureState({
      narrativeState: {
        events: [{ eventId: "e1", type: "change", storyTime: "ch2", entityId: "x", causedBy: "ghost" }],
      },
    })

    expect(p.ripples).toHaveLength(1)
    const r = p.ripples[0]
    expect(r.id).toBe("ripple:ghost")
    expect(r.label).toBe("ghost")
    expect(r.detail).toContain("悬空")
    expect(r.storyTime).toBeNull()
    expect(r.consequenceCount).toBe(1)
    expect(r.relatedIds).toEqual(["e1"])
  })

  it("部分真源缺失：只列缺的那条，不误报已就绪的真源", () => {
    const p = projectClosureState({
      timelineEntries: [{ chapterNumber: 1, event: "x" }],
      narrativeState: { declarations: [decl({})] },
    })

    expect(p.missingSources.some((s) => s.includes("信息差"))).toBe(false)
    expect(p.missingSources.some((s) => s.includes("timeline.json"))).toBe(false)
    expect(p.missingSources.some((s) => s.includes("故事时间级"))).toBe(true)
    expect(p.missingSources.some((s) => s.includes("涟漪"))).toBe(true)
  })
})

describe("loadClosureProjection（真实 loader：读既有 .novel/ 真源）", () => {
  beforeEach(() => {
    mocks.readFile.mockReset()
  })

  it("两个真源都在 → 行来自真源文件内容，missingSources 为空", async () => {
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith(".novel/narrative-state.json")) {
        return JSON.stringify({
          declarations: [decl({})],
          visibilities: [vis({})],
          locatedInRelations: [],
          events: [
            { eventId: "e1", type: "change", storyTime: "ch1", entityId: "world", summary: "世界变动" },
            { eventId: "e2", type: "change", storyTime: "ch2", entityId: "world", causedBy: "e1" },
          ],
          lastUpdated: "2026-01-01T00:00:00.000Z",
        })
      }
      if (path.endsWith(".novel/timeline.json")) {
        return JSON.stringify({
          version: 1,
          entries: [{ chapterNumber: 5, event: "章级事件" }],
          serial: 1,
          updatedAt: "",
        })
      }
      throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" })
    })

    const p = await loadClosureProjection("E:/Novel")

    expect(p.infoGaps.map((r) => r.id)).toEqual(["d1"])
    expect(p.worldEvents.map((r) => r.id)).toEqual(["timeline:5:章级事件", "event:e1", "event:e2"])
    expect(p.ripples.map((r) => r.id)).toEqual(["ripple:e1"])
    expect(p.ripples[0].consequenceCount).toBe(1)
    expect(p.missingSources).toEqual([])
  })

  it("真源文件缺失（ENOENT）→ 空数组 + N/A（真实 loader 不崩、不造数据）", async () => {
    mocks.readFile.mockImplementation(async (path: string) => {
      throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" })
    })

    const p = await loadClosureProjection("E:/Novel")

    expect(p.infoGaps).toEqual([])
    expect(p.worldEvents).toEqual([])
    expect(p.ripples).toEqual([])
    expect(p.missingSources).toHaveLength(4)
  })
})

describe("信息差时态口径（审查回归）：撤销的记录不计入已知/未知", () => {
  it("validTo 早于声明 validFrom 的可见性被排除；仍覆盖的保留", () => {
    const projection = projectClosureState({
      narrativeState: {
        declarations: [
          {
            declarationId: "d1",
            entityId: "林昭",
            entityType: "character",
            property: "身世",
            description: "半人半妖",
            modality: "fact",
            validFrom: "第3章",
            validTo: "Infinity",
            recordedAt: "2026-10-18T00:00:00.000Z",
          },
        ],
        visibilities: [
          {
            declarationId: "d1",
            characterId: "甲",
            state: "known",
            source: "explicit",
            isExplicit: true,
            validFrom: "第3章",
            validTo: "Infinity",
            recordedAt: "2026-10-18T00:00:00.000Z",
          },
          {
            declarationId: "d1",
            characterId: "乙",
            state: "unknown",
            source: "inferred",
            isExplicit: false,
            validFrom: "第1章",
            validTo: "第2章",
            recordedAt: "2026-10-18T00:00:00.000Z",
          },
        ],
        events: [],
      },
    })
    const row = projection.infoGaps[0]
    expect(row).toBeTruthy()
    expect(row?.knownCount).toBe(1)
    // 乙 的可见性在「第3章」之前就闭合了（validTo=第2章 < 第3章）→ 不计入未知
    expect(row?.unknownCount).toBe(0)
    expect(row?.relatedIds).toEqual(["甲"])
  })
})
