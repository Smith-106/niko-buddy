// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  createDirectorPipeline,
  createEmptyForeshadowingStore,
  createEmptyStoryCompass,
  createEmptySubplotBoardStore,
  type BookRules,
  type DirectorPersistedFile,
  type DirectorSnapshot,
  type ForeshadowingStore,
  type StoryCompass,
  type SubplotBoardStore,
  type WorldBlueprint,
} from "@/lib/novel"
import {
  runCompassUpdate,
  runDirectorCommitPhase,
  runDirectorUpsertWorld,
  runForeshadowingUpsert,
  runRulesUpsertBookRules,
  runSubplotUpsert,
} from "./planning-write-tools"

const passThroughLock = async <T>(_pp: string, fn: () => Promise<T>): Promise<T> => fn()

describe("planning-write-tools — 架构与零 LLM/零深导入边界", () => {
  it("严格零深导入 @/lib/novel/*（仅经 @/lib/novel barrel 导入）且不调用/导入采纳接口", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/mcp/planning-write-tools.ts"), "utf8")
    expect(src).not.toMatch(/from\s+["']@\/lib\/novel\/[^"']+["']/)
    expect(src).not.toMatch(/\bacceptChapterDraft\s*\(/)
    expect(src).not.toMatch(/import\s*\{[\s\S]*?\bacceptChapterDraft\b/)
  })
})

describe("planning-write-tools — 1. director.upsert_world", () => {
  it("支持 merge / replace / fillMissingRequired 与可选 null 容错，零 LLM 且不改正式章", async () => {
    let saved: WorldBlueprint | null = null
    const res1 = await runDirectorUpsertWorld(
      "/proj",
      {
        worldType: "东方玄幻",
        mode: null,
        layers: {
          axioms: ["灵气守恒", "灵气守恒"],
          background: ["三千年前天倾"],
          magicSystem: null,
        },
        crossRefs: [{ from: "axioms", to: "background", term: "三千年前天倾" }],
        fillMissingRequired: true,
      },
      {
        withLock: passThroughLock,
        loadWorldBlueprint: async () => saved,
        saveWorldBlueprint: async (_pp, bp) => {
          saved = bp
        },
        loadDirectorPersisted: async () => ({
          fileVersion: 1,
          state: createDirectorPipeline(),
          ideaInput: { title: "青云录", genre: "东方玄幻", coreConflict: "正魔决战" },
        }),
      },
    )

    expect(res1.meta).toEqual({ llmCalls: 0, draftFirst: true, formalChaptersMutated: false })
    expect(res1.validation.verdict).toBe("complete")
    expect(res1.missingRequiredLayers).toEqual([])
    const savedBp = saved as WorldBlueprint | null
    expect(savedBp?.layers.axioms).toEqual(["灵气守恒"])
    expect(savedBp?.layers.conflicts?.[0]).toContain("正魔决战")

    const res2 = await runDirectorUpsertWorld(
      "/proj",
      {
        mode: "replace",
        layers: { axioms: ["新公理"] },
      },
      {
        withLock: passThroughLock,
        loadWorldBlueprint: async () => saved,
        saveWorldBlueprint: async (_pp, bp) => {
          saved = bp
        },
      },
    )
    expect(res2.blueprint.layers.axioms).toEqual(["新公理"])
    expect(res2.blueprint.layers.background).toEqual(["三千年前天倾"])
  })

  it("支持 deriveFromEntities 推导并与补丁合并", async () => {
    let saved: WorldBlueprint | null = null
    const deriveSpy = vi.fn(async () => ({
      version: "1.0",
      worldType: "奇幻",
      layers: { geography: ["长安城"] },
      crossRefs: [],
    }))
    const res = await runDirectorUpsertWorld(
      "/proj",
      { worldType: "奇幻", deriveFromEntities: true, layers: { axioms: ["等价交换"] } },
      {
        withLock: passThroughLock,
        loadWorldBlueprint: async () => saved,
        saveWorldBlueprint: async (_pp, bp) => {
          saved = bp
        },
        deriveWorldBlueprint: deriveSpy,
        loadDirectorPersisted: async () => ({
          fileVersion: 1,
          state: createDirectorPipeline(),
          ideaInput: { title: "书", genre: "奇幻", coreConflict: "争" },
        }),
      },
    )
    expect(deriveSpy).toHaveBeenCalledTimes(1)
    expect(res.blueprint.layers.geography).toEqual(["长安城"])
    expect(res.blueprint.layers.axioms).toEqual(["等价交换"])
  })

  it("拒绝空参数、未知世界层、未知键与未打开项目", async () => {
    await expect(runDirectorUpsertWorld("", { worldType: "x" })).rejects.toThrow("需要已打开的项目")
    await expect(runDirectorUpsertWorld("/proj", {})).rejects.toThrow("至少需提供")
    await expect(
      runDirectorUpsertWorld("/proj", { layers: { bogus: ["a"] } }),
    ).rejects.toThrow("未知世界层")
    await expect(
      runDirectorUpsertWorld("/proj", { worldType: "x", extra: null }),
    ).rejects.toThrow("未知参数")
  })
})

describe("planning-write-tools — 2. director.commit_phase", () => {
  function emptySnapshot(idea: { title: string; genre: string; coreConflict: string }): DirectorSnapshot {
    return {
      idea,
      worldComplete: false,
      protagonistNamed: false,
      antagonistNamed: false,
      frameworkChosen: false,
      volumesPlanned: false,
      firstChapterReady: false,
    }
  }

  it("严格走真实阶段门：idea 过门推进至 world；world 残缺时绝不绕过门；补齐后推进至 character", async () => {
    let persisted: DirectorPersistedFile = {
      fileVersion: 1,
      state: createDirectorPipeline(),
      ideaInput: { title: "", genre: "", coreConflict: "" },
    }
    let bp: WorldBlueprint | null = null

    const commit1 = await runDirectorCommitPhase(
      "/proj",
      {
        idea: { title: "租借之躯", genre: "都市异能", coreConflict: "赎回本体" },
        expectedPhase: "idea",
        persistOnBlocked: null,
      },
      {
        withLock: passThroughLock,
        loadDirectorPersisted: async () => persisted,
        saveDirectorPersisted: async (_pp, f) => {
          persisted = f
        },
        collectProjectSnapshot: async (_pp, idea) => emptySnapshot(idea),
        loadWorldBlueprint: async () => bp,
      },
    )
    expect(commit1.advanced).toBe(true)
    expect(commit1.previousPhase).toBe("idea")
    expect(commit1.currentPhase).toBe("world")
    expect(commit1.state.statuses.idea).toBe("done")
    expect(commit1.meta.llmCalls).toBe(0)

    // Phase 2 未补齐世界蓝图 → 必须阻断，且默认不污染 retryCount
    const blocked = await runDirectorCommitPhase(
      "/proj",
      { expectedPhase: "world" },
      {
        withLock: passThroughLock,
        loadDirectorPersisted: async () => persisted,
        saveDirectorPersisted: async (_pp, f) => {
          persisted = f
        },
        collectProjectSnapshot: async (_pp, idea) => emptySnapshot(idea),
        loadWorldBlueprint: async () => bp,
      },
    )
    expect(blocked.advanced).toBe(false)
    expect(blocked.persisted).toBe(false)
    expect(blocked.blockedReason).toContain("世界骨架未完备")
    expect(blocked.currentPhase).toBe("world")

    // 补齐 5 必填层后 → 真实过门推进至 character
    bp = {
      version: "1.0",
      worldType: "都市异能",
      layers: {
        axioms: ["法则"],
        background: ["背景"],
        geography: ["地理"],
        cultures: ["文化"],
        conflicts: ["冲突"],
      },
    }
    const commit2 = await runDirectorCommitPhase(
      "/proj",
      { expectedPhase: "world" },
      {
        withLock: passThroughLock,
        loadDirectorPersisted: async () => persisted,
        saveDirectorPersisted: async (_pp, f) => {
          persisted = f
        },
        collectProjectSnapshot: async (_pp, idea) => emptySnapshot(idea),
        loadWorldBlueprint: async () => bp,
      },
    )
    expect(commit2.advanced).toBe(true)
    expect(commit2.currentPhase).toBe("character")
    expect(commit2.state.statuses.world).toBe("done")
  })

  it("expectedPhase 不匹配时抛错且不落盘；已完成管线保持幂等不回退", async () => {
    const saveSpy = vi.fn(async () => {})
    await expect(
      runDirectorCommitPhase(
        "/proj",
        { expectedPhase: "outline" },
        {
          withLock: passThroughLock,
          loadDirectorPersisted: async () => ({
            fileVersion: 1,
            state: createDirectorPipeline(),
            ideaInput: { title: "a", genre: "b", coreConflict: "c" },
          }),
          saveDirectorPersisted: saveSpy,
          collectProjectSnapshot: async (_pp, idea) => emptySnapshot(idea),
        },
      ),
    ).rejects.toThrow("expectedPhase 不匹配")
    expect(saveSpy).not.toHaveBeenCalled()

    const doneState = createDirectorPipeline()
    doneState.currentPhase = "chapters"
    doneState.statuses = {
      idea: "done",
      world: "done",
      character: "done",
      outline: "done",
      chapters: "done",
    }
    const doneRes = await runDirectorCommitPhase(
      "/proj",
      {},
      {
        withLock: passThroughLock,
        loadDirectorPersisted: async () => ({
          fileVersion: 1,
          state: doneState,
          ideaInput: { title: "a", genre: "b", coreConflict: "c" },
        }),
        saveDirectorPersisted: saveSpy,
        collectProjectSnapshot: async (_pp, idea) => emptySnapshot(idea),
      },
    )
    expect(doneRes.alreadyCompleted).toBe(true)
    expect(doneRes.completed).toBe(true)
    expect(doneRes.advanced).toBe(false)
    expect(saveSpy).not.toHaveBeenCalled()
  })
})

describe("planning-write-tools — 3. rules.upsert_book_rules", () => {
  it("支持 merge 去重与 replace 全量替换，并产出 promptFragment", async () => {
    let saved: BookRules | null = null
    const deps = {
      withLock: passThroughLock,
      loadBookRules: async () => saved,
      saveBookRules: async (_pp: string, rules: BookRules) => {
        saved = rules
      },
    }

    const r1 = await runRulesUpsertBookRules(
      "/proj",
      {
        prohibitions: ["主角死亡"],
        protagonist: { name: "林澈", personalityLock: ["冷静"], behavioralConstraints: null },
        genreLock: { primary: "刑侦", forbidden: ["修仙"] },
        eraConstraints: { enabled: true, anachronismTerms: ["智能手机"], period: "1990s" },
        fanficMode: null,
      },
      deps,
    )
    expect(r1.rules.prohibitions).toEqual(["主角死亡"])
    expect(r1.promptFragment).toContain("林澈 性格锁：冷静")
    expect(r1.meta.llmCalls).toBe(0)

    const r2 = await runRulesUpsertBookRules(
      "/proj",
      {
        prohibitions: ["主角死亡", "降智"],
        allowedDeviations: ["梦境片段"],
      },
      deps,
    )
    expect(r2.rules.prohibitions).toEqual(["主角死亡", "降智"])
    expect(r2.rules.protagonist?.name).toBe("林澈")

    const r3 = await runRulesUpsertBookRules("/proj", { mode: "replace" }, deps)
    expect(r3.rules.prohibitions).toEqual([])
    expect(r3.rules.protagonist).toBeUndefined()
  })

  it("拒绝空 merge 与非法 fanficMode", async () => {
    await expect(runRulesUpsertBookRules("/proj", {})).rejects.toThrow("至少需提供一个规则字段")
    await expect(
      runRulesUpsertBookRules("/proj", { fanficMode: "bad" }),
    ).rejects.toThrow("fanficMode")
  })
})

describe("planning-write-tools — 4. compass.update", () => {
  it("更新终局方向、增删活跃长线并宣告收官卷", async () => {
    let compass: StoryCompass = createEmptyStoryCompass("2026-01-01T00:00:00Z")
    const deps = {
      withLock: passThroughLock,
      loadStoryCompass: async () => compass,
      saveStoryCompass: async (_pp: string, next: StoryCompass) => {
        compass = next
      },
      now: () => "2026-11-27T00:00:00Z",
    }

    const r1 = await runCompassUpdate(
      "/proj",
      {
        endingDirection: "在权力与良知间抉择",
        newThreads: ["古玉之谜", "旧案真相"],
        estimatedScale: "预计 4-6 卷",
        resolvedThreads: null,
      },
      deps,
    )
    expect(r1.compass.openThreads).toEqual(["古玉之谜", "旧案真相"])
    expect(r1.addedThreads).toEqual(["古玉之谜", "旧案真相"])
    expect(r1.openThreadCount).toBe(2)

    const r2 = await runCompassUpdate(
      "/proj",
      { resolvedThreads: ["旧案真相"], declareFinalVolume: 5 },
      deps,
    )
    expect(r2.compass.openThreads).toEqual(["古玉之谜"])
    expect(r2.removedThreads).toEqual(["旧案真相"])
    expect(r2.compass.finalVolumeDeclared).toBe(true)
    expect(r2.compass.finalVolumeNumber).toBe(5)
  })

  it("拒绝空参数与越界收官卷号", async () => {
    await expect(runCompassUpdate("/proj", {})).rejects.toThrow("至少需提供")
    await expect(
      runCompassUpdate("/proj", { declareFinalVolume: 0 }),
    ).rejects.toThrow("declareFinalVolume")
  })
})

describe("planning-write-tools — 5. foreshadowing.upsert", () => {
  it("新建自动生成稳定 ASCII id、按 id/name 更新并执行 markAbandoned 转移守卫", async () => {
    let store: ForeshadowingStore = createEmptyForeshadowingStore()
    const deps = {
      withLock: passThroughLock,
      loadForeshadowingTracker: async () => store,
      saveForeshadowingTracker: async (_pp: string, next: ForeshadowingStore) => {
        store = next
      },
      now: () => "2026-11-27T00:00:00Z",
    }

    const created = await runForeshadowingUpsert(
      "/proj",
      {
        name: "青铜古镜",
        description: "映出前世残影",
        plantedChapter: 1,
        relatedCharacters: ["林澈"],
        resolvedChapter: null,
      },
      deps,
    )
    expect(created.action).toBe("created")
    expect(created.item.id).toMatch(/^fs_[a-f0-9]{12}$/)
    expect(created.activeCount).toBe(1)

    const resolved = await runForeshadowingUpsert(
      "/proj",
      {
        id: created.item.id,
        status: "resolved",
        advancedChapters: [5, 3, 5],
        resolvedChapter: 12,
      },
      deps,
    )
    expect(resolved.action).toBe("updated")
    expect(resolved.item.advancedChapters).toEqual([3, 5])
    expect(resolved.item.resolvedChapter).toBe(12)
    expect(resolved.activeCount).toBe(0)

    // 已 resolved 的伏笔禁止改回 abandoned（复用 markAbandoned 守卫）
    await expect(
      runForeshadowingUpsert("/proj", { id: created.item.id, status: "abandoned" }, deps),
    ).rejects.toThrow("无法废弃")
  })

  it("拒绝缺少 id/name 与新建直接 abandoned", async () => {
    await expect(runForeshadowingUpsert("/proj", {})).rejects.toThrow("至少需提供")
    await expect(
      runForeshadowingUpsert(
        "/proj",
        { name: "废伏笔", status: "abandoned" },
        {
          withLock: passThroughLock,
          loadForeshadowingTracker: async () => createEmptyForeshadowingStore(),
          saveForeshadowingTracker: async () => {},
        },
      ),
    ).rejects.toThrow("不允许直接设为 abandoned")
  })
})

describe("planning-write-tools — 6. subplot.upsert", () => {
  it("创建并按 title/id 更新支线，追加去重 progressEntry", async () => {
    let store: SubplotBoardStore = createEmptySubplotBoardStore()
    const deps = {
      withLock: passThroughLock,
      loadSubplotBoard: async () => store,
      saveSubplotBoard: async (_pp: string, next: SubplotBoardStore) => {
        store = next
      },
      now: () => "2026-11-27T00:00:00Z",
    }

    const created = await runSubplotUpsert(
      "/proj",
      {
        title: "旧港区失踪案",
        startChapter: 2,
        targetResolutionChapter: 25,
        summary: "调查三年前船员失踪真相",
        progressEntry: "第2章拿到残缺航海志",
        notes: null,
      },
      deps,
    )
    expect(created.action).toBe("created")
    expect(created.item.id).toMatch(/^sp_[a-f0-9]{12}$/)
    expect(created.item.progress).toEqual(["第2章拿到残缺航海志"])
    expect(created.activeCount).toBe(1)

    const updated = await runSubplotUpsert(
      "/proj",
      {
        id: created.item.id,
        lastSeenChapter: 8,
        progressEntry: "第8章锁定幕后船东",
        status: "resolved",
        resolvedChapter: 24,
      },
      deps,
    )
    expect(updated.action).toBe("updated")
    expect(updated.item.progress).toEqual(["第2章拿到残缺航海志", "第8章锁定幕后船东"])
    expect(updated.activeCount).toBe(0)
  })

  it("拒绝缺少 id/title 与非法 status", async () => {
    await expect(runSubplotUpsert("/proj", {})).rejects.toThrow("至少需提供")
    await expect(
      runSubplotUpsert("/proj", { title: "支线", status: "invalid" }),
    ).rejects.toThrow("status")
  })
})
