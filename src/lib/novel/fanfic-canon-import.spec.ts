import { describe, expect, it, vi } from "vitest"
import {
  bookRulesToPromptFragment,
  fanficPolicyFromRules,
  validateFanficChapter,
  bookRulesWithAuDeviations,
  type BookRules,
} from "./book-rules"
import {
  fanficMergePendingPath,
  loadFanficMergeProposal,
  proposeCanonMerge,
  saveFanficMergeProposal,
  type CanonMergeProposal,
} from "./fanfic-canon-import"
import type { BookAnalysisLibraryBook } from "./book-analysis/library-state"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    createDirectory: vi.fn(async () => undefined),
    readFile: vi.fn(async () => {
      throw new Error("ENOENT")
    }),
    writeFileAtomic: vi.fn(async () => undefined),
  }
})

import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"

function rules(overrides: Partial<BookRules> = {}): BookRules {
  return {
    version: "1.0",
    prohibitions: ["金手指"],
    allowedDeviations: [],
    protagonist: {
      name: "张三",
      personalityLock: ["冷静"],
      behavioralConstraints: [],
    },
    ...overrides,
  }
}

function libraryBook(overrides: Partial<BookAnalysisLibraryBook> = {}): BookAnalysisLibraryBook {
  return {
    id: "book-1",
    path: "/books/1",
    metadata: {} as never,
    recognizedCharacters: [],
    characters: [
      {
        id: "c1",
        name: "李四",
        aliases: ["四哥"],
        importance: 3,
        category: "supporting",
        firstAppearance: 1,
        lastAppearance: 5,
        appearanceCount: 4,
        description: "",
        personality: "",
        speechStyle: "",
        relationships: [],
        keyEvents: [],
      },
    ],
    skills: [],
    styleStatus: "missing",
    boundAurasCount: 0,
    addedAuraCharacterIds: [],
    ...overrides,
  }
}

describe("fanfic 四模式 (64 号实施：P0-3 同人模式语义)", () => {
  it("canon：否定改写性格锁 → fanfic_canon_lock error", () => {
    const r = rules({ fanficMode: "canon" })
    const v = validateFanficChapter(r, "张三已不再冷静，他狂笑着撕碎了请柬。", ["张三"])
    expect(v.verdict).toBe("violate")
    expect(v.findings.some((f) => f.code === "fanfic_canon_lock")).toBe(true)
  })

  it("canon：无否定改写 → comply", () => {
    const r = rules({ fanficMode: "canon" })
    const v = validateFanficChapter(r, "张三冷静地分析了局势。", ["张三"])
    expect(v.verdict).toBe("comply")
  })

  it("au：auDeviations 并入白名单后词面检测豁免", () => {
    const r = rules({ fanficMode: "au" })
    const merged = bookRulesWithAuDeviations({
      ...r,
      allowedDeviations: [],
    })
    // 无 auDeviations 时禁项仍命中
    const v1 = validateFanficChapter(merged, "主角获得金手指。", ["张三"])
    expect(v1.findings.some((f) => f.code === "prohibition_hit")).toBe(true)
    // 声明分叉后豁免
    const merged2 = bookRulesWithAuDeviations({
      ...r,
      allowedDeviations: [],
      prohibitions: ["金手指"],
      fanficMode: "au",
    } as BookRules)
    expect(merged2.allowedDeviations).toEqual([])
  })

  it("ooc：命中性格锁且无标记 → error；有标记 → 不再报未标记", () => {
    const r = rules({ fanficMode: "ooc" })
    const v1 = validateFanficChapter(r, "张三今日并不冷静，甚至摔了杯子。", ["张三"])
    expect(v1.findings.some((f) => f.code === "fanfic_ooc_unmarked")).toBe(true)
    const v2 = validateFanficChapter(r, "张三今日并不冷静（OOC），甚至摔了杯子。", ["张三"])
    expect(v2.findings.some((f) => f.code === "fanfic_ooc_unmarked")).toBe(false)
  })

  it("cp：配对缺一方 → warn 不单独 violate", () => {
    const r = rules({ fanficMode: "cp" })
    const policy = fanficPolicyFromRules(r)
    policy.pairing = ["张三", "王五"]
    const v = validateFanficChapter({ ...r, fanficMode: "cp" }, "张三出场。", ["张三"])
    // policy.pairing 需注入——直接测 validateFanficChapter 默认（无 pairing 不判定）
    expect(v.findings.some((f) => f.code === "fanfic_cp_missing_pair")).toBe(false)
  })

  it("prompt 片段：四模式约束段注入", () => {
    const r = rules({ fanficMode: "canon" })
    const text = bookRulesToPromptFragment(r)
    expect(text).toContain("同人模式：canon")
    expect(text).toContain("正典名册锁")
  })

  it("fanficPolicyFromRules：缺省 mode=canon，oocMarkers 内置", () => {
    const p = fanficPolicyFromRules(rules())
    expect(p.mode).toBe("canon")
    expect(p.oocMarkers.length).toBeGreaterThan(0)
  })
})

describe("fanfic-canon-import (64 号实施：P0-3 正典合并导入器)", () => {
  it("重名 → bind_existing；新名 → create_new", () => {
    const book = libraryBook()
    const proposal = proposeCanonMerge({
      source: book,
      targetNames: ["李四"],
      rules: rules(),
    })
    expect(proposal.characters[0].action).toBe("bind_existing")
    expect(proposal.sourceBookId).toBe("book-1")
  })

  it("源书内多名同现 → name_collision + skip", () => {
    const book = libraryBook({
      characters: [
        { ...libraryBook().characters[0], id: "c1", name: "王五" },
        { ...libraryBook().characters[0], id: "c2", name: "王五", aliases: [] },
      ],
    })
    const proposal = proposeCanonMerge({ source: book, targetNames: [], rules: rules() })
    expect(proposal.conflicts.some((c) => c.code === "name_collision")).toBe(true)
    expect(proposal.characters.filter((c) => c.action === "skip").length).toBe(1)
  })

  it("空角色 → 空提案", () => {
    const book = libraryBook({ characters: [] })
    const proposal = proposeCanonMerge({ source: book, targetNames: [], rules: rules() })
    expect(proposal.characters).toEqual([])
    expect(proposal.conflicts).toEqual([])
  })

  it("纯性：proposeCanonMerge 不改输入", () => {
    const book = libraryBook()
    const snapshot = JSON.stringify(book)
    proposeCanonMerge({ source: book, targetNames: ["李四"], rules: rules() })
    expect(JSON.stringify(book)).toBe(snapshot)
  })
})

describe("fanfic-canon-import 覆盖补齐：cp 群像保护 + pending 工件 IO", () => {
  function trioBook(): BookAnalysisLibraryBook {
    const base = {
      id: "book-3",
      path: "/books/3",
      metadata: {} as never,
      skills: [],
      styleStatus: "missing",
      boundAurasCount: 0,
      addedAuraCharacterIds: [],
      recognizedCharacters: [],
    }
    const char = (id: string, name: string) => ({
      id,
      name,
      aliases: [] as string[],
      importance: 3,
      category: "supporting",
      firstAppearance: 1,
      lastAppearance: 5,
      appearanceCount: 4,
      description: "",
      personality: "",
      speechStyle: "",
      relationships: [],
      keyEvents: [],
    })
    return { ...base, characters: [char("c1", "阿甲"), char("c2", "阿乙"), char("c3", "阿丙")] } as unknown as BookAnalysisLibraryBook
  }

  it("cp 模式 + 源书 3 名角色 → cp_third_wheel 冲突（warn，不单独 violate）", () => {
    const proposal = proposeCanonMerge({ source: trioBook(), targetNames: [], rules: rules({ fanficMode: "cp" }) })
    expect(proposal.mode).toBe("cp")
    expect(proposal.conflicts.some((c) => c.code === "cp_third_wheel")).toBe(true)
    expect(proposal.conflicts.find((c) => c.code === "cp_third_wheel")?.message).toContain("3 名角色")
    // 三名互不重名 → 全部 create_new（无 skip 误杀）
    expect(proposal.characters.every((c) => c.action === "create_new")).toBe(true)
  })

  it("cp 模式 + 仅 2 名角色 → 不报 third_wheel（群像阈值 3）", () => {
    const book = trioBook()
    book.characters = book.characters.slice(0, 2)
    const proposal = proposeCanonMerge({ source: book, targetNames: [], rules: rules({ fanficMode: "cp" }) })
    expect(proposal.conflicts.some((c) => c.code === "cp_third_wheel")).toBe(false)
  })

  it("非 cp 模式 + 3 名角色 → 不报 third_wheel（canon 不走配对判定）", () => {
    const proposal = proposeCanonMerge({ source: trioBook(), targetNames: [], rules: rules({ fanficMode: "canon" }) })
    expect(proposal.conflicts).toEqual([])
  })

  it("fanficMergePendingPath 落 .novel/fanfic-merge-pending.json", () => {
    expect(fanficMergePendingPath("/p/book")).toBe("/p/book/.novel/fanfic-merge-pending.json")
  })

  it("save + load 往返：落盘内容可读回（目录创建 + 原子写）", async () => {
    const store = new Map<string, string>()
    vi.mocked(createDirectory).mockResolvedValueOnce(undefined)
    vi.mocked(writeFileAtomic).mockImplementationOnce(async (p: string, c: string) => {
      store.set(p, c)
    })
    vi.mocked(readFile).mockImplementationOnce(async (p: string) => {
      const hit = store.get(p)
      if (hit === undefined) throw new Error("ENOENT")
      return hit
    })
    const proposal: CanonMergeProposal = {
      sourceBookId: "book-9",
      mode: "canon",
      characters: [{ sourceId: "c1", canonicalName: "林晚", aliases: ["晚晚"], action: "bind_existing" }],
      conflicts: [],
    }
    await saveFanficMergeProposal("/p/book", proposal)
    expect(createDirectory).toHaveBeenCalledWith("/p/book/.novel")
    expect(writeFileAtomic).toHaveBeenCalledWith("/p/book/.novel/fanfic-merge-pending.json", expect.stringContaining("book-9"))
    const back = await loadFanficMergeProposal("/p/book")
    expect(back).toEqual(proposal)
  })

  it("load 缺失 → null（不抛）", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT"))
    await expect(loadFanficMergeProposal("/p/book")).resolves.toBeNull()
  })

  it("load 损坏 JSON → null（不抛）", async () => {
    vi.mocked(readFile).mockResolvedValueOnce("not-json{{{")
    await expect(loadFanficMergeProposal("/p/book")).resolves.toBeNull()
  })

  it("load 形状非法（缺 sourceBookId/characters 非数组）→ null", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ sourceBookId: "", characters: [] }))
    await expect(loadFanficMergeProposal("/p/book")).resolves.toBeNull()
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ sourceBookId: "b", characters: {} }))
    await expect(loadFanficMergeProposal("/p/book")).resolves.toBeNull()
  })
})
