// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest"
import type { ChapterDraft, ForeshadowingStore, OutlineModel, StyleExemplar } from "@/lib/novel"
import {
  runChapterSearch,
  runCharacterRead,
  runForeshadowingList,
  runOutlineRead,
  runStyleExemplars,
} from "./atomic-read-tools"

describe("atomic-read-tools: foreshadowing.list", () => {
  const sampleStore: ForeshadowingStore = {
    lastUpdated: "2026-11-26T00:00:00Z",
    items: [
      {
        id: "fs-normal",
        name: "铜钥匙",
        description: "门房留下的铜钥匙",
        status: "planted",
        plantedChapter: 10,
        advancedChapters: [],
        relatedCharacters: ["林雾"],
        relatedEvents: [],
        notes: "",
      },
      {
        id: "fs-critical",
        name: "旧怀表",
        description: "陈砚父亲失踪前留下的坏怀表",
        status: "planted",
        plantedChapter: 1,
        advancedChapters: [],
        relatedCharacters: ["陈砚"],
        relatedEvents: [],
        notes: "",
      },
      {
        id: "fs-warning",
        name: "黑衣船夫",
        description: "反复出现在雾港码头的船夫",
        status: "advanced",
        plantedChapter: 2,
        advancedChapters: [3],
        relatedCharacters: ["陈砚", "苏九"],
        relatedEvents: [],
        notes: "",
      },
      {
        id: "fs-resolved",
        name: "旧密信",
        description: "已揭晓真伪的密信",
        status: "resolved",
        plantedChapter: 1,
        advancedChapters: [2],
        resolvedChapter: 4,
        relatedCharacters: ["陈砚"],
        relatedEvents: [],
        notes: "",
      },
    ],
  }

  it("按 critical > warning > normal 排序，支持 overdue、character 过滤、debt 附带与分页", async () => {
    const allRes = await runForeshadowingList(
      "/proj",
      { currentChapter: 14, includeDebt: true },
      { loadTracker: async () => sampleStore },
    )
    expect(allRes.currentChapter).toBe(14)
    expect(allRes.watermarkChapter).toBe(10)
    expect(allRes.total).toBe(4)
    expect(allRes.countsByStatus).toEqual({
      planted: 2,
      advanced: 1,
      resolved: 1,
      abandoned: 0,
    })
    expect(allRes.items.map((i) => i.id)).toEqual([
      "fs-critical",
      "fs-warning",
      "fs-normal",
      "fs-resolved",
    ])
    expect(allRes.debt?.criticalCount).toBe(1)
    expect(allRes.debt?.warningCount).toBe(1)
    expect(allRes.meta).toEqual({ readOnly: true, llmCalls: 0, diskWrites: 0 })

    const overdueRes = await runForeshadowingList(
      "/proj",
      { status: "overdue", currentChapter: 14, character: "陈砚" },
      { loadTracker: async () => sampleStore },
    )
    expect(overdueRes.items.map((i) => i.id)).toEqual(["fs-critical", "fs-warning"])
    expect(overdueRes.debt).toBeDefined()

    const paged = await runForeshadowingList(
      "/proj",
      { currentChapter: 14, offset: 1, limit: 2 },
      { loadTracker: async () => sampleStore },
    )
    expect(paged.items.map((i) => i.id)).toEqual(["fs-warning", "fs-normal"])
    expect(paged.hasMore).toBe(true)
  })

  it("拒绝非法 status / debtLevel / 未知参数", async () => {
    await expect(runForeshadowingList("/proj", { status: "bad" })).rejects.toThrow(/status/)
    await expect(runForeshadowingList("/proj", { debtLevel: "high" })).rejects.toThrow(/debtLevel/)
    await expect(runForeshadowingList("/proj", { extra: 1 })).rejects.toThrow(/未知/)
  })
})

describe("atomic-read-tools: character.read", () => {
  it("聚合角色状态/灵魂/实体页，支持 name 精确查询、aliveOnly、includeAura 默认策略与损坏 JSON 降级警告", async () => {
    const baseDeps = {
      loadCharacterStates: async () => ({
        lastUpdated: "2026-11-26T00:00:00Z",
        characters: [
          {
            characterName: "陈砚",
            currentLocation: "雾港码头",
            status: "轻伤",
            equipment: ["铜钥匙"],
            abilities: ["推理"],
            relationships: { 苏九: "合作" } as Record<string, string>,
            lastUpdatedChapter: 5,
            lastUpdatedAt: "2026-11-26",
            isAlive: true,
          },
          {
            characterName: "老周",
            currentLocation: "旧仓库",
            status: "已故",
            equipment: [] as string[],
            abilities: [] as string[],
            relationships: {} as Record<string, string>,
            lastUpdatedChapter: 3,
            lastUpdatedAt: "2026-11-25",
            isAlive: false,
            deathChapter: 3,
          },
        ],
      }),
      listBindableNovelCharacters: async () => ["陈砚", "苏九"],
      getCharacterAuraBindings: async () => [
        { characterName: "陈砚", auraId: "builtin-lu-xun", aliases: ["阿砚"] },
      ],
      listCharacterAuras: async () => [
        {
          id: "builtin-lu-xun",
          builtIn: true,
          name: "鲁迅",
          category: "文学思想",
          sourceNote: "内置",
          corpus: "冷峻",
          styleDescription: "解剖刀般冷峻",
          behaviorRules: "直面骨头",
          boundaries: "不冒充真人",
          notes: "",
        },
      ],
      listEntityFiles: async () => [
        { name: "陈砚", path: "/proj/wiki/entities/characters/陈砚.md" },
      ],
      readFileText: async (path: string) => `# 实体页\n${path}`,
    }

    // 单角色查询：默认 includeAura=true 并附带 entityMarkdown
    const single = await runCharacterRead("/proj", { name: "阿砚" }, baseDeps)
    expect(single.filteredTotal).toBe(1)
    expect(single.characters[0]?.name).toBe("陈砚")
    expect(single.characters[0]?.aura?.aura?.name).toBe("鲁迅")
    expect(single.characters[0]?.entityMarkdown).toContain("# 实体页")
    expect(single.meta).toEqual({ readOnly: true, llmCalls: 0, diskWrites: 0 })

    // 列表查询：默认 includeAura=false，aliveOnly 排除已死角色，includeRelationships=false 隐藏关系
    const list = await runCharacterRead(
      "/proj",
      { aliveOnly: true, includeRelationships: false },
      baseDeps,
    )
    expect(list.characters.map((c) => c.name)).not.toContain("老周")
    expect(list.characters.map((c) => c.name)).toContain("陈砚")
    expect(list.characters[0]?.aura).toBeUndefined()
    expect(list.characters[0]?.relationships).toBeUndefined()
    expect(list.characters[0]?.state?.relationships).toBeUndefined()

    // 损坏 character-states.json 优雅降级为脱敏 warnings
    const corrupt = await runCharacterRead("/proj", {}, {
      ...baseDeps,
      loadCharacterStates: async () => {
        throw new Error("SyntaxError: secret raw JSON {bad}")
      },
    })
    expect(corrupt.warnings).toHaveLength(1)
    expect(corrupt.warnings[0]).not.toContain("secret raw JSON")
    expect(corrupt.characters.map((c) => c.name)).toContain("苏九")
  })

  it("严格拒绝 name 路径遍历字符", async () => {
    for (const badName of ["../evil", "a/b", "a\\b", "bad\0name"]) {
      await expect(runCharacterRead("/proj", { name: badName })).rejects.toThrow(/name 非法/)
    }
  })
})

describe("atomic-read-tools: outline.read (零 searchWiki / 零网络)", () => {
  const sampleModel: OutlineModel = {
    schemaVersion: 2,
    updatedAt: "2026-11-26T00:00:00Z",
    volumes: [
      {
        number: 1,
        title: "第一卷 雾港",
        arc: "调查失踪案",
        chapters: [1, 2, 3, 4, 5].map((n) => ({
          id: `v01c00${n}`,
          volume: 1,
          chapter: n,
          title: `第${n}章`,
          pov: "陈砚",
          arc: "开篇弧",
          entities: ["陈砚"],
          foreshadow: { plant: n === 1 ? ["fs1"] : [], payoff: [] },
          constraints: ["不揭晓幕后真凶"],
          prose: { goal: `第${n}章目标`, scenes: [`场景${n}`], emotion: "悬疑" },
          updatedAt: "2026-11-26",
        })),
      },
    ],
  }

  it("支持 chapterNumber+window 窗口读取 + directMarkdown，且 includeSummaryOnly=true 跳过全文", async () => {
    const readDirect = vi.fn(async () => "# 第3章本地细纲")
    const winRes = await runOutlineRead(
      "/proj",
      { chapterNumber: 3, window: 1 },
      {
        loadOutlineModel: async () => ({ model: sampleModel, migratedFrom: null }),
        readChapterOutlineDirect: readDirect,
        listDirectory: async () => [
          { name: "story-outline.md", path: "/proj/wiki/outlines/story-outline.md", is_dir: false },
        ],
        readFileText: async () => "# 总纲",
      },
    )
    expect(winRes.mode).toBe("chapter_window")
    expect(winRes.range).toEqual({ start: 2, end: 4 })
    expect(winRes.chapters?.map((c) => c.chapter)).toEqual([2, 3, 4])
    expect(winRes.directMarkdown).toBe("# 第3章本地细纲")
    expect(readDirect).toHaveBeenCalledTimes(1)

    readDirect.mockClear()
    const summaryOnly = await runOutlineRead(
      "/proj",
      { chapterNumber: 3, window: 1, includeSummaryOnly: true },
      {
        loadOutlineModel: async () => ({ model: sampleModel, migratedFrom: null }),
        readChapterOutlineDirect: readDirect,
        listDirectory: async () => [],
        readFileText: async () => "",
      },
    )
    expect(summaryOnly.directMarkdown).toBeNull()
    expect(readDirect).not.toHaveBeenCalled()
    expect((summaryOnly.chapters?.[0] as { goal?: string }).goal).toBe("第2章目标")
  })

  it("filename 与 chapterNumber/volume 互斥，且严格校验单段安全 .md 文件名", async () => {
    await expect(
      runOutlineRead("/proj", { filename: "story-outline.md", chapterNumber: 1 }),
    ).rejects.toThrow(/参数冲突/)
    await expect(
      runOutlineRead("/proj", { filename: "../escape.md" }),
    ).rejects.toThrow(/filename 非法/)
    await expect(
      runOutlineRead("/proj", { filename: "CON.md" }),
    ).rejects.toThrow(/保留/)

    const fileRes = await runOutlineRead(
      "/proj",
      { filename: "story-outline.md", offset: 0, limit: 10 },
      {
        loadOutlineModel: async () => ({ model: null, migratedFrom: null }),
        readChapterOutlineDirect: async () => "",
        listDirectory: async () => [],
        readFileText: async () => "0123456789ABCDEF",
      },
    )
    expect(fileRes.mode).toBe("file")
    expect(fileRes.content).toBe("0123456789")
    expect(fileRes.hasMore).toBe(true)
  })
})

describe("atomic-read-tools: style.exemplars", () => {
  const exemplars: StyleExemplar[] = [
    {
      exemplarId: "ex-1",
      chapterId: "chapter-1",
      text: "雨声砸在铁皮棚上，像碎银子落盘。",
      markType: "style",
      note: "环境描写",
      createdAt: "2026-11-25T10:00:00Z",
    },
    {
      exemplarId: "ex-2",
      chapterId: "chapter-2",
      text: "「你以为我没查过账？」他把杯子轻轻放下。".repeat(20),
      markType: "voice",
      note: "压迫对话",
      createdAt: "2026-11-26T10:00:00Z",
    },
  ]

  it("支持 markTypes、category（按 markType 或 note）、topK 与 maxCharsPerItem 截断", async () => {
    const byMarkCategory = await runStyleExemplars(
      "/proj",
      { category: "voice", maxCharsPerItem: 60 },
      { loadStyleExemplars: async () => exemplars },
    )
    expect(byMarkCategory.items).toHaveLength(1)
    expect(byMarkCategory.items[0]?.exemplarId).toBe("ex-2")
    expect(byMarkCategory.items[0]?.truncated).toBe(true)
    expect(byMarkCategory.items[0]?.text.length).toBe(60)

    const byNoteCategory = await runStyleExemplars(
      "/proj",
      { category: "环境" },
      { loadStyleExemplars: async () => exemplars },
    )
    expect(byNoteCategory.items.map((i) => i.exemplarId)).toEqual(["ex-1"])

    const topKRes = await runStyleExemplars(
      "/proj",
      { topK: 1 },
      { loadStyleExemplars: async () => exemplars },
    )
    expect(topKRes.items).toHaveLength(1)
    expect(topKRes.meta).toEqual({ readOnly: true, llmCalls: 0, diskWrites: 0 })
  })

  it("topK 模式不提前硬截断为 2000 字：按原文诚实计算 originalChars 与 truncated，并兼容重复 exemplarId", async () => {
    const longText3000 = "雨".repeat(3000)
    const dupA = "甲".repeat(2600)
    const dupB = "乙".repeat(3100)
    const longExemplars: StyleExemplar[] = [
      {
        exemplarId: "ex-long-3000",
        chapterId: "chapter-10",
        text: longText3000,
        markType: "style",
        note: "长段范例",
        createdAt: "2026-11-26T12:00:00Z",
      },
      {
        exemplarId: "ex-dup",
        chapterId: "chapter-11",
        text: dupA,
        markType: "voice",
        note: "重复ID条目A",
        createdAt: "2026-11-26T11:00:00Z",
      },
      {
        exemplarId: "ex-dup",
        chapterId: "chapter-12",
        text: dupB,
        markType: "pacing",
        note: "重复ID条目B",
        createdAt: "2026-11-26T10:00:00Z",
      },
    ]

    // maxCharsPerItem=3500 -> 返回完整 3000 字，originalChars=3000，truncated=false
    const fullRes = await runStyleExemplars(
      "/proj",
      { topK: 3, maxCharsPerItem: 3500 },
      { loadStyleExemplars: async () => longExemplars },
    )
    expect(fullRes.items).toHaveLength(3)
    const item3000 = fullRes.items.find((i) => i.exemplarId === "ex-long-3000")
    expect(item3000?.text).toBe(longText3000)
    expect(item3000?.text.length).toBe(3000)
    expect(item3000?.originalChars).toBe(3000)
    expect(item3000?.truncated).toBe(false)

    // 重复 exemplarId 各自精确还原原未截断文本
    const dupVoice = fullRes.items.find((i) => i.exemplarId === "ex-dup" && i.markType === "voice")
    const dupPacing = fullRes.items.find((i) => i.exemplarId === "ex-dup" && i.markType === "pacing")
    expect(dupVoice?.text).toBe(dupA)
    expect(dupVoice?.originalChars).toBe(2600)
    expect(dupVoice?.truncated).toBe(false)
    expect(dupPacing?.text).toBe(dupB)
    expect(dupPacing?.originalChars).toBe(3100)
    expect(dupPacing?.truncated).toBe(false)

    // maxCharsPerItem=2000 -> 截断到 2000 字，originalChars 仍为 3000，truncated=true
    const truncRes = await runStyleExemplars(
      "/proj",
      { topK: 3, maxCharsPerItem: 2000 },
      { loadStyleExemplars: async () => longExemplars },
    )
    const truncItem = truncRes.items.find((i) => i.exemplarId === "ex-long-3000")
    expect(truncItem?.text.length).toBe(2000)
    expect(truncItem?.text).toBe(longText3000.slice(0, 2000))
    expect(truncItem?.originalChars).toBe(3000)
    expect(truncItem?.truncated).toBe(true)
  })

  it("损坏文件一律抛脱敏错误 'style exemplars file is corrupt'", async () => {
    await expect(
      runStyleExemplars("/proj", {}, {
        loadStyleExemplars: async () => {
          throw new Error("raw file path C:/secret/style-exemplars.json broken")
        },
      }),
    ).rejects.toThrow(/^style exemplars file is corrupt$/)
  })
})

describe("atomic-read-tools: chapter.search (Watchlist #9 零出网 + 本地补全先过滤后 limit)", () => {
  it("强制传 includeVector:false, rerank:false，本地章节范围过滤在 limit 之前生效，支持 drafts 范围", async () => {
    const searchWikiSpy = vi.fn(async () => [
      {
        path: "/proj/wiki/entities/characters/陈砚.md",
        title: "陈砚",
        snippet: "陈砚持有铜钥匙",
        titleMatch: false,
        score: 99,
        images: [],
      },
    ])

    const chapterContents = new Map<string, string>([
      ["/proj/wiki/chapters/chapter-001.md", "# 第1章\n铜钥匙初次出现。"],
      ["/proj/wiki/chapters/chapter-005.md", "# 第5章\n" + "前文铺垫".repeat(60) + "铜钥匙开启密室" + "后续内容".repeat(60)],
      ["/proj/wiki/chapters/chapter-008.md", "# 第8章\n铜钥匙折断在锁孔里。"],
    ])

    const chRes = await runChapterSearch(
      "/proj",
      { query: "铜钥匙", scope: "chapters", chapterStart: 4, chapterEnd: 6, limit: 1, contextChars: 30 },
      {
        searchWiki: searchWikiSpy,
        listChapters: async () =>
          [...chapterContents.keys()].map((p) => ({ name: p.split("/").pop()!, path: p })),
        readFileText: async (p) => chapterContents.get(p) ?? "",
      },
    )

    expect(searchWikiSpy).toHaveBeenCalledWith("/proj", "铜钥匙", {
      includeVector: false,
      rerank: false,
      topK: 100,
    })
    expect(chRes.results).toHaveLength(1)
    expect(chRes.results[0]?.chapterNumber).toBe(5)
    expect(chRes.results[0]?.snippet).toContain("铜钥匙")
    expect(chRes.results[0]?.snippet.length).toBeLessThanOrEqual(80)
    expect(chRes.meta).toEqual({
      readOnly: true,
      llmCalls: 0,
      diskWrites: 0,
      networkUsed: false,
    })

    // drafts 范围本地扫描 listChapterDrafts，不调用 searchWiki
    searchWikiSpy.mockClear()
    const drafts: ChapterDraft[] = [
      {
        id: "draft_9",
        chapterName: "第9章-余波",
        content: "陈砚把铜钥匙扔进海里。",
        createdAt: 1000,
        status: "draft",
      },
    ]
    const draftRes = await runChapterSearch(
      "/proj",
      { query: "铜钥匙", scope: "drafts" },
      {
        searchWiki: searchWikiSpy,
        listDrafts: async () => drafts,
      },
    )
    expect(searchWikiSpy).not.toHaveBeenCalled()
    expect(draftRes.results).toHaveLength(1)
    expect(draftRes.results[0]?.draftId).toBe("draft_9")
    expect(draftRes.results[0]?.chapterNumber).toBe(9)
  })

  it("拒绝空 query 与倒挂 chapterStart > chapterEnd", async () => {
    await expect(runChapterSearch("/proj", { query: "  " })).rejects.toThrow(/query/)
    await expect(
      runChapterSearch("/proj", { query: "线索", chapterStart: 10, chapterEnd: 5 }),
    ).rejects.toThrow(/chapterStart/)
  })
})
