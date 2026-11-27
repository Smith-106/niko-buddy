/**
 * context-engine-technique-sources.spec.ts — B1 技法偏好重排的**可失败**行为证据。
 *
 * 该文件是 context-engine.ts 的纯搬迁拆分产物，此前无独立 spec：
 * 常态路径由 context-engine*.spec / b-improvements.spec 间接覆盖，但两条
 * 「降级回原序」的 catch 守卫（偏好读取失败 / 重排核抛错）没有入口。
 *
 * 纪律：这两个 catch 是**优雅降级守卫**（与 relatedChapters 同款），
 * 不是死代码 —— 它们保证技法注入面在任何偏好数据故障下都退回原序、不阻断装配。
 * 本 spec 用可控故障（Proxy getter 抛错 / store.load 拒绝）证明降级真的生效。
 */
import { afterEach, describe, expect, it, vi } from "vitest"

// 快照可控：默认透传真实入库快照（九个规则包都有 chapter_task_brief 块），
// 仅「快照无该注入面」用例把块清空 —— 这是真实运行态（快照不完整/旧版本）。
const compilerStub = vi.hoisted(() => ({ dropTaskBriefBlocks: false }))
const canonMocks = vi.hoisted(() => ({
  loadNovelSessionStatus: vi.fn(),
  queryCanonEdges: vi.fn(),
  resolveChapterPovCharacter: vi.fn(),
  loadTemporalFactsCached: vi.fn(),
}))

vi.mock("./novel-session-status", () => ({
  loadNovelSessionStatus: (...args: unknown[]) => canonMocks.loadNovelSessionStatus(...args),
}))
vi.mock("./canon-graph-client", () => ({
  queryCanonEdges: (...args: unknown[]) => canonMocks.queryCanonEdges(...args),
}))
vi.mock("./character-cognition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./character-cognition")>()
  return {
    ...actual,
    resolveChapterPovCharacter: (...args: unknown[]) => canonMocks.resolveChapterPovCharacter(...args),
  }
})
vi.mock("./context-engine-temporal", () => ({
  loadTemporalFactsCached: (...args: unknown[]) => canonMocks.loadTemporalFactsCached(...args),
}))

vi.mock("./craft/technique-compiler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./craft/technique-compiler")>()
  return {
    ...actual,
    compileFromCommittedSnapshot: () => {
      const registry = actual.compileFromCommittedSnapshot()
      if (!compilerStub.dropTaskBriefBlocks) return registry
      return {
        ...registry,
        packs: registry.packs.map((pack) => ({
          ...pack,
          promptBlocks: pack.promptBlocks.filter((b) => b.injectionPoint !== "chapter_task_brief"),
        })),
      }
    },
  }
})

import {
  loadCanonSourceFacts,
  loadTechniqueBlocks,
  orderTechniqueBlocksByPreference,
  reorderTechniqueBlocksByPreference,
} from "./context-engine-technique-sources"
import type { TechniquePromptBlock } from "./craft/technique-compiler"
import { preferenceStore, type PreferenceMap } from "./technique-preference"
import type { CanonFact } from "./canon-graph-client"
import type { TemporalFact } from "./temporal-memory"

function block(id: string, injectionPoint: TechniquePromptBlock["injectionPoint"] = "chapter_task_brief"): TechniquePromptBlock {
  return { blockId: id, title: `标题-${id}`, body: `正文-${id}`, injectionPoint }
}

const ids = (blocks: readonly TechniquePromptBlock[]): string[] => blocks.map((b) => b.blockId)

afterEach(() => {
  vi.restoreAllMocks()
  compilerStub.dropTaskBriefBlocks = false
  canonMocks.loadNovelSessionStatus.mockReset()
  canonMocks.queryCanonEdges.mockReset()
  canonMocks.resolveChapterPovCharacter.mockReset()
  canonMocks.loadTemporalFactsCached.mockReset()
})

describe("loadTechniqueBlocks — 快照 → 注入文本", () => {
  it("快照无 chapter_task_brief 块 → 返回空文本且不读偏好（不注入、不白读 IO）", async () => {
    compilerStub.dropTaskBriefBlocks = true
    const load = vi.spyOn(preferenceStore, "load")
    await expect(loadTechniqueBlocks("E:/proj")).resolves.toBe("")
    expect(load).not.toHaveBeenCalled()
  })

  it("快照有块 → 渲染为 `【标题】正文` 行", async () => {
    vi.spyOn(preferenceStore, "load").mockResolvedValue({})
    const text = await loadTechniqueBlocks("E:/proj")
    expect(text.length).toBeGreaterThan(0)
    // 首行必须是 `【标题】正文` 形式（标题非空且被中文书名号包裹）
    expect(text).toMatch(/^【[^】]+】\S/)
  })
})

describe("orderTechniqueBlocksByPreference — 纯核重排", () => {
  it("正分技法前移，且不增删块（并列保原序）", () => {
    const blocks = [block("a"), block("b"), block("c")]
    const prefs: PreferenceMap = { b: { accept: 3, reject: 0 }, c: { accept: 1, reject: 1 } }
    const ordered = orderTechniqueBlocksByPreference(blocks, prefs)
    expect(ids(ordered)).toEqual(["b", "a", "c"])
    expect(ordered).toHaveLength(blocks.length)
  })

  it("全零/全负分 → 原序（默认行为不变）", () => {
    const blocks = [block("a"), block("b")]
    const negative: PreferenceMap = { a: { accept: 0, reject: 2 }, b: { accept: 1, reject: 3 } }
    expect(ids(orderTechniqueBlocksByPreference(blocks, negative))).toEqual(["a", "b"])
    expect(ids(orderTechniqueBlocksByPreference([], negative))).toEqual([])
  })

  it("读偏好时抛错 → 捕获并原样返回入参数组（不抛、不乱序）", () => {
    const blocks = [block("a"), block("b")]
    // 偏好表访问即抛：模拟上游偏好数据形状损坏（跨模块契约漂移）。
    const throwingPrefs = new Proxy({} as PreferenceMap, {
      get(): never {
        throw new Error("preference-map corrupted")
      },
    })
    const ordered = orderTechniqueBlocksByPreference(blocks, throwingPrefs)
    expect(ordered).toBe(blocks)
    expect(ids(ordered)).toEqual(["a", "b"])
  })
})

describe("reorderTechniqueBlocksByPreference — IO 壳降级", () => {
  it("无 projectPath / 空串 → 不读 store，原样返回", async () => {
    const load = vi.spyOn(preferenceStore, "load")
    const blocks = [block("a"), block("b")]
    expect(await reorderTechniqueBlocksByPreference(blocks)).toBe(blocks)
    expect(await reorderTechniqueBlocksByPreference(blocks, "   ")).toBe(blocks)
    expect(load).not.toHaveBeenCalled()
  })

  it("store 读到偏好 → 按偏好重排", async () => {
    vi.spyOn(preferenceStore, "load").mockResolvedValue({ b: { accept: 5, reject: 0 } })
    const blocks = [block("a"), block("b")]
    expect(ids(await reorderTechniqueBlocksByPreference(blocks, "E:/proj"))).toEqual(["b", "a"])
  })

  it("store.load 拒绝 → 降级原序（装配不被偏好 IO 故障阻断）", async () => {
    vi.spyOn(preferenceStore, "load").mockRejectedValue(new Error("EACCES: preference.json"))
    const blocks = [block("a"), block("b"), block("c")]
    const ordered = await reorderTechniqueBlocksByPreference(blocks, "E:/proj")
    expect(ordered).toBe(blocks)
    expect(ids(ordered)).toEqual(["a", "b", "c"])
  })
})

describe("TASK-006: loadCanonSourceFacts — dual/shadow 读路径与 facts.json 确定性回退", () => {
  const legacyFact: TemporalFact = {
    id: "legacy-1",
    subject: "林澈",
    predicate: "佩剑",
    object: "黑剑",
    validFrom: 1,
    source: "facts.json",
  }

  it("targetChapter <= 0 → 短路返回 { current: null, former: [] } 且零查询", async () => {
    await expect(loadCanonSourceFacts("E:/proj", 0)).resolves.toEqual({ current: null, former: [] })
    expect(canonMocks.loadNovelSessionStatus).not.toHaveBeenCalled()
    expect(canonMocks.queryCanonEdges).not.toHaveBeenCalled()
  })

  it("canon_migration='dual' → 返回 world_fact + belief + hypothesis 边与 formerFacts，不触发 legacy 回退", async () => {
    canonMocks.loadNovelSessionStatus.mockResolvedValue({ canon_migration: "dual" })
    canonMocks.resolveChapterPovCharacter.mockResolvedValue("林澈")
    const currentEdges: CanonFact[] = [
      {
        id: "ch1-wf-a",
        sourceId: "林澈",
        targetId: "霜刃",
        predicate: "佩剑",
        edgeKind: "world_fact",
        validAt: 2,
        modality: "assertive",
        archived: false,
      },
      {
        id: "ch2-mod-b",
        sourceId: "林澈",
        targetId: "沈舟无辜",
        predicate: "认为",
        edgeKind: "world_fact",
        validAt: 2,
        modality: "belief",
        archived: false,
      },
      {
        id: "ch2-mod-c",
        sourceId: "苏未晞",
        targetId: "密道在城北",
        predicate: "猜测",
        edgeKind: "world_fact",
        validAt: 2,
        modality: "hypothesis",
        archived: false,
      },
    ]
    const formerEdges: CanonFact[] = [
      {
        id: "ch1-wf-old",
        sourceId: "林澈",
        targetId: "黑剑",
        predicate: "佩剑",
        edgeKind: "world_fact",
        validAt: 1,
        invalidAt: 2,
        modality: "assertive",
        archived: false,
      },
    ]
    canonMocks.queryCanonEdges
      .mockResolvedValueOnce(currentEdges)
      .mockResolvedValueOnce(formerEdges)

    const result = await loadCanonSourceFacts("E:/proj", 3)

    expect(canonMocks.queryCanonEdges).toHaveBeenNthCalledWith(1, "E:/proj", {
      valid_at_chapter: 3,
      archived: false,
    })
    expect(canonMocks.queryCanonEdges).toHaveBeenNthCalledWith(2, "E:/proj", {
      valid_at_chapter: 3,
      archived: false,
      include_invalidated: true,
      known_by: "林澈",
    })
    expect(result.current?.map((f) => [f.id, f.modality])).toEqual([
      ["ch1-wf-a", "assertive"],
      ["ch2-mod-b", "belief"],
      ["ch2-mod-c", "hypothesis"],
    ])
    expect(result.former).toHaveLength(1)
    expect(result.former[0]).toMatchObject({ id: "ch1-wf-old", former: true, object: "黑剑" })
    expect(canonMocks.loadTemporalFactsCached).not.toHaveBeenCalled()
  })

  it("canon_migration='dual' 且 canon.db 返回空数组，但 .novel/facts.json 有事实 → 确定性回退 legacy facts", async () => {
    canonMocks.loadNovelSessionStatus.mockResolvedValue({ canon_migration: "dual" })
    canonMocks.resolveChapterPovCharacter.mockResolvedValue(null)
    canonMocks.queryCanonEdges.mockResolvedValue([])
    canonMocks.loadTemporalFactsCached.mockResolvedValue([legacyFact])

    const result = await loadCanonSourceFacts("E:/proj", 3)
    expect(result).toEqual({ current: [legacyFact], former: [] })
    expect(canonMocks.loadTemporalFactsCached).toHaveBeenCalledWith("E:/proj")
  })

  it("canon_migration='dual' 且 canon.db 与 legacy 均为空 → 返回 { current: [], former: [] }", async () => {
    canonMocks.loadNovelSessionStatus.mockResolvedValue({ canon_migration: "dual" })
    canonMocks.resolveChapterPovCharacter.mockResolvedValue(null)
    canonMocks.queryCanonEdges.mockResolvedValue([])
    canonMocks.loadTemporalFactsCached.mockResolvedValue([])

    const result = await loadCanonSourceFacts("E:/proj", 3)
    expect(result).toEqual({ current: [], former: [] })
  })

  it("canon_migration='dual' 且 queryCanonEdges 抛错，但 legacy 有事实 → 回退返回 legacy facts", async () => {
    canonMocks.loadNovelSessionStatus.mockResolvedValue({ canon_migration: "dual" })
    canonMocks.queryCanonEdges.mockRejectedValue(new Error("canon.db unavailable"))
    canonMocks.loadTemporalFactsCached.mockResolvedValue([legacyFact])

    const result = await loadCanonSourceFacts("E:/proj", 3)
    expect(result).toEqual({ current: [legacyFact], former: [] })
  })

  it("canon_migration='dual' 且 queryCanonEdges 抛错且无 legacy 事实 → 返回 { current: null, former: [] }", async () => {
    canonMocks.loadNovelSessionStatus.mockResolvedValue({ canon_migration: "dual" })
    canonMocks.queryCanonEdges.mockRejectedValue(new Error("ipc down"))
    canonMocks.loadTemporalFactsCached.mockResolvedValue([])

    const result = await loadCanonSourceFacts("E:/proj", 3)
    expect(result).toEqual({ current: null, former: [] })
  })

  it("canon_migration='legacy' 或缺省 → 不触 queryCanonEdges，直接走 loadTemporalFactsCached", async () => {
    canonMocks.loadNovelSessionStatus.mockResolvedValue({ canon_migration: "legacy" })
    canonMocks.loadTemporalFactsCached.mockResolvedValue([legacyFact])

    const result = await loadCanonSourceFacts("E:/proj", 3)
    expect(result).toEqual({ current: [legacyFact], former: [] })
    expect(canonMocks.queryCanonEdges).not.toHaveBeenCalled()
  })
})
