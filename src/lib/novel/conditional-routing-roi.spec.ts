import { beforeEach, describe, expect, it, vi } from "vitest"

// fs mocks — appendRoutingROISample 用 loadCognitionState/saveCognitionState
// （经 fileExists + readFile + createDirectory + writeFileAtomic）写 cognition-state.json。
const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(async (_path: string): Promise<boolean> => false),
  readFile: vi.fn(async (_path: string): Promise<string> => ""),
  writeFileAtomic: vi.fn(async (_path: string, _contents: string): Promise<void> => {}),
  createDirectory: vi.fn(async (_path: string): Promise<void> => {}),
  listDirectory: vi.fn(async (_path: string): Promise<any[]> => []),
  getFileModifiedTime: vi.fn(async (_path: string): Promise<number> => 0),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  fileExists: fsMocks.fileExists,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
  listDirectory: fsMocks.listDirectory,
  getFileModifiedTime: fsMocks.getFileModifiedTime,
}))

import {
  computeIrrelevantRatio,
  type ContextPack,
  type ContextEntity,
} from "./context-engine"
import {
  appendRoutingROISample,
  loadCognitionState,
  type CognitionState,
  type RoutingROISample,
} from "./character-cognition"

/** 构造最小 ContextPack（仅 ROI 关心的 3 字段：characterStates/relatedSettings/cognitionStates）。 */
function packWith(fields: Partial<Pick<ContextPack, "characterStates" | "relatedSettings" | "cognitionStates">>): ContextPack {
  return {
    task: "",
    chapterGoal: "",
    outline: "",
    recentSummaries: [],
    previousChapterEnding: "",
    characterStates: fields.characterStates ?? "",
    soulDoc: "",
    characterAuras: "",
    cognitionStates: fields.cognitionStates ?? "",
    foreshadowingStates: "",
    timeline: "",
    relatedSettings: fields.relatedSettings ?? "",
    canonRules: "",
    writingStyle: "",
    searchResults: "",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
    gaps: [],
    styleExemplars: [],
    activeEntities: [],
  }
}

function entity(name: string): ContextEntity {
  return { entityId: `/P/wiki/entities/${name}.md`, name, type: "character", tags: [] }
}

describe("EPIC-003 / ADR-32 / TASK-008: 条件路由 ROI 验证", () => {
  beforeEach(() => {
    fsMocks.fileExists.mockReset()
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockReset()
    fsMocks.createDirectory.mockReset()
  })

  describe("computeIrrelevantRatio — enabled variant < disabled variant", () => {
    it("enabled（activeEntities 覆盖候选）irrelevantRatio < disabled（零 activeEntities）", () => {
      // contextPack 含 3 个候选 entity name（cognitionStates + characterStates）。
      const pack = packWith({
        cognitionStates: "Alice知道：线索\nBob不知道：真相\nCarol知道：秘密",
        characterStates: "- Alice：在场\n- Bob：缺席\n- Carol：在场",
      })

      // enabled variant：activeEntities 覆盖 Alice + Bob（2/3）→ Carol 无关 → 1/3。
      const enabledRatio = computeIrrelevantRatio(pack, [entity("Alice"), entity("Bob")])
      // disabled variant：零 activeEntities → 全候选无关 → 1.0。
      const disabledRatio = computeIrrelevantRatio(pack, [])

      // 核心断言：条件路由 enabled 降低无关占比。
      expect(enabledRatio).toBeLessThan(disabledRatio)
      expect(enabledRatio).toBeCloseTo(1 / 3, 5)
      expect(disabledRatio).toBe(1)
    })

    it("enabled 全覆盖时 irrelevantRatio = 0（条件路由完全消除无关内容）", () => {
      const pack = packWith({
        cognitionStates: "Alice知道：线索\nBob不知道：真相",
      })
      // activeEntities 覆盖全部候选 → 0 无关。
      const ratio = computeIrrelevantRatio(pack, [entity("Alice"), entity("Bob")])
      expect(ratio).toBe(0)
    })

    it("disabled（零 activeEntities）irrelevantRatio = 1（全候选视为无关）", () => {
      const pack = packWith({
        cognitionStates: "Alice知道：线索\nBob不知道：真相",
      })
      // 零 activeEntities → 全候选无关（disabled variant 典型）。
      const ratio = computeIrrelevantRatio(pack, [])
      expect(ratio).toBe(1)
    })

    it("零候选时 irrelevantRatio = 0（无法判定，保守返回 0）", () => {
      const pack = packWith({ cognitionStates: "", characterStates: "", relatedSettings: "" })
      const ratio = computeIrrelevantRatio(pack, [entity("Alice")])
      expect(ratio).toBe(0)
    })

    it("relatedSettings 候选也参与占比统计", () => {
      const pack = packWith({
        relatedSettings: "- 森林：地点\n- 城堡：地点\n- 河流：地点",
      })
      // activeEntities 覆盖 1/3 → 2/3 无关。
      const ratio = computeIrrelevantRatio(pack, [entity("森林")])
      expect(ratio).toBeCloseTo(2 / 3, 5)
    })
  })

  describe("appendRoutingROISample — 写 cognition-state.json（HARD-1 守恒）", () => {
    it("写入 cognition-state.json routingROIBuckets 字段（A/B 字段齐全）", async () => {
      // cognition-state.json 不存在 → 创建最小 state 承载样本。
      fsMocks.fileExists.mockResolvedValue(false)

      const sample: RoutingROISample = {
        variant: "enabled",
        irrelevantRatio: 0.33,
        chapterId: "5",
        timestamp: "2026-07-10T03:00:00.000Z",
      }
      await appendRoutingROISample("/P", sample)

      // writeFileAtomic 被调用（写 cognition-state.json）。
      expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
      const [writePath, writeContent] = fsMocks.writeFileAtomic.mock.calls[0]
      expect(writePath).toContain("cognition-state.json")
      const written = JSON.parse(writeContent) as CognitionState
      // routingROIBuckets 含 1 条样本，字段齐全。
      expect(written.routingROIBuckets).toHaveLength(1)
      const writtenSample = written.routingROIBuckets![0]
      expect(writtenSample.variant).toBe("enabled")
      expect(writtenSample.irrelevantRatio).toBe(0.33)
      expect(writtenSample.chapterId).toBe("5")
      expect(writtenSample.timestamp).toBe("2026-07-10T03:00:00.000Z")
    })

    it("append 到现有 cognition-state.json（不覆盖 characters/readerKnows）", async () => {
      // 现有 cognition-state.json 含 character cognition 数据。
      const existing: CognitionState = {
        characters: [{ character: "Alice", knows: ["线索"], doesNotKnow: [] }],
        readerKnows: [],
        lastUpdatedChapter: 5,
      }
      fsMocks.fileExists.mockResolvedValue(true)
      fsMocks.readFile.mockResolvedValue(JSON.stringify(existing))

      await appendRoutingROISample("/P", {
        variant: "disabled",
        irrelevantRatio: 1,
        chapterId: "6",
        timestamp: "2026-07-10T04:00:00.000Z",
      })

      const [, writeContent] = fsMocks.writeFileAtomic.mock.calls[0]
      const written = JSON.parse(writeContent) as CognitionState
      // 现有 character cognition 保留（不被覆盖）。
      expect(written.characters).toEqual(existing.characters)
      expect(written.lastUpdatedChapter).toBe(5)
      // routingROIBuckets 追加 1 条。
      expect(written.routingROIBuckets).toHaveLength(1)
      expect(written.routingROIBuckets![0].variant).toBe("disabled")
    })

    it("HARD-1 守恒：ROI 写入路径不含 status.json（仅 cognition-state.json）", async () => {
      fsMocks.fileExists.mockResolvedValue(false)
      await appendRoutingROISample("/P", {
        variant: "enabled",
        irrelevantRatio: 0,
        chapterId: "1",
        timestamp: "2026-07-10T05:00:00.000Z",
      })
      const [writePath] = fsMocks.writeFileAtomic.mock.calls[0]
      // 写入路径必须是 cognition-state.json，MUST NOT 写 status.json。
      expect(writePath).toContain("cognition-state.json")
      expect(writePath).not.toMatch(/status\.json/i)
    })

    it("跨章节累积多样本（enabled vs disabled A/B 统计）", async () => {
      fsMocks.fileExists.mockResolvedValue(false)

      // 模拟跨章节装配：3 次 enabled（低 irrelevantRatio）+ 3 次 disabled（高）。
      for (let i = 0; i < 3; i++) {
        // 后续调用读到前一次写入的状态（mock readFile 返回上次写的内容）。
        const lastWrittenCalls = fsMocks.writeFileAtomic.mock.calls
        const lastWritten = lastWrittenCalls.length > 0
          ? lastWrittenCalls[lastWrittenCalls.length - 1][1]
          : undefined
        fsMocks.fileExists.mockResolvedValue(true)
        if (lastWritten) fsMocks.readFile.mockResolvedValue(lastWritten)
        await appendRoutingROISample("/P", {
          variant: "enabled",
          irrelevantRatio: 0.2 + i * 0.05,
          chapterId: String(i + 1),
          timestamp: `2026-07-10T0${i + 1}:00:00.000Z`,
        })
      }

      const finalWritten = JSON.parse(
        fsMocks.writeFileAtomic.mock.calls[fsMocks.writeFileAtomic.mock.calls.length - 1][1],
      ) as CognitionState
      expect(finalWritten.routingROIBuckets).toHaveLength(3)
      // 3 条 enabled 样本平均 irrelevantRatio < 0.3。
      const enabledAvg =
        finalWritten.routingROIBuckets!.reduce((s, b) => s + b.irrelevantRatio, 0) /
        finalWritten.routingROIBuckets!.length
      expect(enabledAvg).toBeLessThan(0.3)
    })

    it("上限保护：超过 1024 条样本时弹最旧（LRU-ish）", async () => {
      // 预填 1024 条样本。
      const existing: CognitionState = {
        characters: [],
        readerKnows: [],
        lastUpdatedChapter: 0,
        routingROIBuckets: Array.from({ length: 1024 }, (_, i) => ({
          variant: "enabled" as const,
          irrelevantRatio: 0.1,
          chapterId: String(i),
          timestamp: `2026-07-10T00:0${i % 10}:00.000Z`,
        })),
      }
      fsMocks.fileExists.mockResolvedValue(true)
      fsMocks.readFile.mockResolvedValue(JSON.stringify(existing))

      await appendRoutingROISample("/P", {
        variant: "enabled",
        irrelevantRatio: 0.5,
        chapterId: "1024",
        timestamp: "2026-07-10T06:00:00.000Z",
      })

      const written = JSON.parse(
        fsMocks.writeFileAtomic.mock.calls[fsMocks.writeFileAtomic.mock.calls.length - 1][1],
      ) as CognitionState
      // 上限 1024，弹最旧（chapterId "0"）。
      expect(written.routingROIBuckets).toHaveLength(1024)
      expect(written.routingROIBuckets![0].chapterId).toBe("1")
      expect(written.routingROIBuckets![1023].chapterId).toBe("1024")
    })
  })

  describe("loadCognitionState — routingROIBuckets 向后兼容", () => {
    it("pre-TASK-008 cognition-state.json 无 routingROIBuckets 字段 → undefined（向后兼容）", async () => {
      const legacy = {
        characters: [{ character: "Alice", knows: ["x"], doesNotKnow: [] }],
        readerKnows: [],
        lastUpdatedChapter: 3,
      }
      fsMocks.fileExists.mockResolvedValue(true)
      fsMocks.readFile.mockResolvedValue(JSON.stringify(legacy))

      const state = await loadCognitionState("/P")
      expect(state).not.toBeNull()
      expect(state!.routingROIBuckets).toBeUndefined()
      expect(state!.characters).toEqual(legacy.characters)
    })
  })
})
