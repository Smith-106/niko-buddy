/**
 * story-extractor.spec.ts — 全维度内容提取器行为测试
 *
 * 覆盖 extractStoryContent 全管线：
 * - 大纲读取（排序/过滤/单文件失败容错/目录缺失）
 * - 最近 N 章读取（章节号解析/排序/切片/快照摘要/标题回退）
 * - 记忆库读取（六路来源各自成功与失败降级）
 * - 角色提取（摄入产物合并/去重/档案叠加/光环绑定/认知回退/LLM 兜底）
 * - 世界规则与力量体系的 Markdown 章节定位
 * - onProgress 八次上报
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { extractStoryContent } from "./story-extractor"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  resolveEntityPath: vi.fn(),
  readSoulDoc: vi.fn(),
  loadCognitionState: vi.fn(),
  loadForeshadowingTracker: vi.fn(),
  getTimelineEvents: vi.fn(),
  loadCharacterStates: vi.fn(),
  characterStatesToContextText: vi.fn(),
  loadSnapshot: vi.fn(),
  listCharacterAuras: vi.fn(),
  getCharacterAuraBindings: vi.fn(),
  loadCharacterAuraSkillDocument: vi.fn(),
  streamChat: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: mocks.readFile, listDirectory: mocks.listDirectory }
})
vi.mock("../entity-subdir-resolver", () => ({
  resolveEntityPath: mocks.resolveEntityPath,
}))
vi.mock("@/lib/novel/soul-doc", () => ({ readSoulDoc: mocks.readSoulDoc }))
vi.mock("@/lib/novel/character-cognition", () => ({
  loadCognitionState: mocks.loadCognitionState,
}))
vi.mock("@/lib/novel/foreshadowing-tracker", () => ({
  loadForeshadowingTracker: mocks.loadForeshadowingTracker,
}))
vi.mock("@/lib/novel/timeline", () => ({ getTimelineEvents: mocks.getTimelineEvents }))
vi.mock("@/lib/novel/character-state", () => ({
  loadCharacterStates: mocks.loadCharacterStates,
  characterStatesToContextText: mocks.characterStatesToContextText,
}))
vi.mock("@/lib/novel/chapter-ingest", () => ({ loadSnapshot: mocks.loadSnapshot }))
vi.mock("@/lib/novel/character-aura", () => ({
  listCharacterAuras: mocks.listCharacterAuras,
  getCharacterAuraBindings: mocks.getCharacterAuraBindings,
  loadCharacterAuraSkillDocument: mocks.loadCharacterAuraSkillDocument,
}))
vi.mock("@/lib/llm-client", () => ({ streamChat: mocks.streamChat }))

const PP = "C:/proj"
const enoent = (p: string): Error => new Error(`ENOENT: ${p}`)
const node = (name: string, dir: string): { name: string; path: string; is_dir: boolean } => ({
  name,
  path: `${dir}/${name}`,
  is_dir: false,
})

function chapterMd(num: number | string, title?: string, body = "正文"): string {
  const titleLine = title === undefined ? "" : `title: ${title}\n`
  return `---\nchapter_number: ${num}\n${titleLine}---\n${body}\n`
}

function ingestJson(entries: unknown[]): string {
  return JSON.stringify({ wikiUpdatePatch: { entries } })
}

function charEntry(fields: Record<string, unknown>, title = "备用名"): unknown {
  return { entryType: "character", title, fields }
}

beforeEach(() => {
  vi.resetAllMocks()
  // 默认：空项目——所有目录缺失、所有文件缺失、各存储返回空
  mocks.listDirectory.mockRejectedValue(enoent("list"))
  mocks.readFile.mockRejectedValue(enoent("read"))
  mocks.resolveEntityPath.mockRejectedValue(enoent("entity"))
  mocks.readSoulDoc.mockResolvedValue("SOUL")
  mocks.loadCognitionState.mockResolvedValue(null)
  mocks.loadForeshadowingTracker.mockResolvedValue(null)
  mocks.getTimelineEvents.mockResolvedValue([])
  mocks.loadCharacterStates.mockResolvedValue({})
  mocks.characterStatesToContextText.mockReturnValue("")
  mocks.loadSnapshot.mockResolvedValue(null)
  mocks.listCharacterAuras.mockResolvedValue([])
  mocks.getCharacterAuraBindings.mockResolvedValue([])
  mocks.loadCharacterAuraSkillDocument.mockResolvedValue("")
  mocks.streamChat.mockRejectedValue(new Error("no llm"))
})

describe("extractStoryContent 空项目", () => {
  it("全部来源缺失时返回空结构并上报 8 次进度", async () => {
    const progress: Array<[number, string]> = []
    const result = await extractStoryContent(PP, {
      sourceChapters: 3,
      onProgress: (p, label) => progress.push([p, label]),
    })
    expect(result.characters).toEqual([])
    expect(result.chapterContents).toEqual([])
    expect(result.outlineContent).toBe("")
    expect(result.soulDoc).toBe("SOUL")
    expect(result.worldRules).toBe("")
    expect(result.powerSystem).toBe("")
    expect(result.memoryData).toEqual({
      characterStates: "",
      characterCognition: null,
      foreshadowingTracker: null,
      timeline: [],
      canonFacts: "",
      conflicts: "",
    })
    expect(result.foreshadowing).toBeNull()
    expect(result.timeline).toEqual([])
    expect(progress.map(([p]) => p)).toEqual([5, 15, 25, 40, 55, 70, 85, 100])
    expect(progress[0][1]).toContain("大纲")
    expect(progress[progress.length - 1][1]).toContain("完成")
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("无 onProgress 时不抛错", async () => {
    const result = await extractStoryContent(PP, { sourceChapters: 2 })
    expect(result.characters).toEqual([])
  })
})

describe("大纲读取 readOutlines", () => {
  function mockFs(outlineFiles: Record<string, string>, fail: string[] = []): void {
    mocks.listDirectory.mockImplementation(async (dir: string) => {
      if (String(dir).endsWith("/wiki/outlines")) {
        return Object.keys(outlineFiles).map((n) => node(n, String(dir)))
      }
      throw enoent(String(dir))
    })
    mocks.readFile.mockImplementation(async (p: string) => {
      if (fail.includes(String(p))) throw enoent(String(p))
      const hit = Object.entries(outlineFiles).find(([n]) => String(p).endsWith(`/${n}`))
      if (hit) return hit[1]
      throw enoent(String(p))
    })
  }

  it("按文件名 numeric 排序拼接并用 --- 分隔", async () => {
    mockFs({ "10.md": "# 第十章大纲", "2.md": "# 第二章大纲", "notes.txt": "忽略我" })
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.outlineContent).toBe("# 第二章大纲\n\n---\n\n# 第十章大纲")
  })

  it("单个文件读取失败被跳过其余保留", async () => {
    mockFs(
      { "a.md": "A", "b.md": "B" },
      [`${PP}/wiki/outlines/b.md`],
    )
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.outlineContent).toBe("A")
  })
})

describe("最近章节读取 readRecentChapters", () => {
  function mockChapters(files: Record<string, string>): void {
    mocks.listDirectory.mockImplementation(async (dir: string) => {
      if (String(dir).endsWith("/wiki/chapters")) {
        return Object.keys(files).map((n) => node(n, String(dir)))
      }
      throw enoent(String(dir))
    })
    mocks.readFile.mockImplementation(async (p: string) => {
      const hit = Object.entries(files).find(([n]) => String(p).endsWith(`/${n}`))
      if (hit) return hit[1]
      throw enoent(String(p))
    })
  }

  it("按章节号排序后取最后 N 章并从快照补摘要", async () => {
    mockChapters({
      "ch10.md": chapterMd(10, "终章", "终章正文"),
      "ch2.md": chapterMd(2, "中章", "中章正文"),
      "ch1.md": chapterMd(1, "开篇", "开篇正文"),
    })
    mocks.loadSnapshot.mockImplementation(async (_pp: string, n: number) => ({ summary: `摘要${n}` }))
    const result = await extractStoryContent(PP, { sourceChapters: 2 })
    expect(result.chapterContents.map((c) => c.chapterNumber)).toEqual([2, 10])
    expect(result.chapterContents[0]).toMatchObject({ title: "中章", summary: "摘要2", content: "中章正文\n" })
    expect(result.chapterContents[1]).toMatchObject({ title: "终章", summary: "摘要10" })
  })

  it("缺章节号/非法章节号/无快照时跳过或摘要留空", async () => {
    mockChapters({
      "no-num.md": "---\ntitle: 无号\n---\n正文\n",
      "bad-num.md": chapterMd("abc", "坏号"),
      "array-num.md": "---\nchapter_number: [\"7\"]\ntitle: [数组标题, 备用]\n---\n数组正文\n",
      "no-title.md": chapterMd(3),
    })
    mocks.loadSnapshot.mockRejectedValue(new Error("no snapshot"))
    const result = await extractStoryContent(PP, { sourceChapters: 10 })
    // 注意真实行为：缺 chapter_number → fmString→"" → Number("")===0（finite）
    // 于是 no-num.md 成为第 0 章；只有非法数字（"abc"→NaN）才被跳过
    expect(result.chapterContents.map((c) => c.chapterNumber)).toEqual([0, 3, 7])
    // 第 0 章有标题；标题缺失回退文件名
    expect(result.chapterContents[0]).toMatchObject({ title: "无号", summary: "" })
    expect(result.chapterContents[1]).toMatchObject({ title: "no-title", summary: "" })
    // 数组型 frontmatter 取首元素
    expect(result.chapterContents[2]).toMatchObject({ title: "数组标题", content: "数组正文\n" })
  })

  it("单个章节文件读取失败被跳过", async () => {
    mockChapters({ "ok.md": chapterMd(1, "好章"), "broken.md": chapterMd(2, "坏章") })
    mocks.readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith("/broken.md")) throw enoent(String(p))
      return chapterMd(1, "好章")
    })
    const result = await extractStoryContent(PP, { sourceChapters: 5 })
    expect(result.chapterContents.map((c) => c.chapterNumber)).toEqual([1])
  })
})

describe("记忆库读取 readMemoryData", () => {
  it("六路来源全部成功时映射为文本", async () => {
    mocks.loadCharacterStates.mockResolvedValue({ chars: 1 })
    mocks.characterStatesToContextText.mockReturnValue("状态文本")
    mocks.loadCognitionState.mockResolvedValue({ characters: [] })
    mocks.loadForeshadowingTracker.mockResolvedValue({ items: [] })
    mocks.getTimelineEvents.mockResolvedValue([{ event: "e1" }, { event: "e2" }])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith("canon-facts.md")) return "正史"
      if (String(p).endsWith("conflicts.md")) return "冲突"
      throw enoent(String(p))
    })
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.memoryData).toMatchObject({
      characterStates: "状态文本",
      timeline: ["e1", "e2"],
      canonFacts: "正史",
      conflicts: "冲突",
    })
    expect(result.memoryData.characterCognition).toEqual({ characters: [] })
    expect(result.memoryData.foreshadowingTracker).toEqual({ items: [] })
    expect(result.timeline).toEqual(["e1", "e2"])
    expect(result.foreshadowing).toEqual({ items: [] })
  })

  it("六路来源全部失败时降级为空", async () => {
    mocks.loadCharacterStates.mockRejectedValue(new Error("bad store"))
    mocks.characterStatesToContextText.mockImplementation(() => {
      throw new Error("unreachable")
    })
    mocks.loadCognitionState.mockRejectedValue(new Error("x"))
    mocks.loadForeshadowingTracker.mockRejectedValue(new Error("x"))
    mocks.getTimelineEvents.mockRejectedValue(new Error("x"))
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.memoryData).toEqual({
      characterStates: "",
      characterCognition: null,
      foreshadowingTracker: null,
      timeline: [],
      canonFacts: "",
      conflicts: "",
    })
  })
})

describe("角色提取：摄入产物主路径", () => {
  function mockIngest(files: Record<string, string>): void {
    mocks.listDirectory.mockImplementation(async (dir: string) => {
      if (String(dir).endsWith("/.novel/chapter-ingest-output")) {
        return Object.keys(files).map((n) => node(n, String(dir)))
      }
      throw enoent(String(dir))
    })
    mocks.readFile.mockImplementation(async (p: string) => {
      const hit = Object.entries(files).find(([n]) => String(p).endsWith(`/${n}`))
      if (hit) return hit[1]
      throw enoent(String(p))
    })
  }

  const fullFields = {
    name: "沈昭",
    aliases: ["阿昭"],
    identity: "剑修",
    faction: "青云门",
    goals: "复仇",
    arcChange: "从冷漠到担当",
    currentState: "重伤",
    appearanceChapters: [1, 2],
    cognition: { knows: ["秘闻"], doesNotKnow: ["真相"] },
  }

  it("完整字段构建档案并绑定光环/技能/实体档案", async () => {
    mockIngest({ "001.output.json": ingestJson([charEntry(fullFields)]) })
    mocks.getCharacterAuraBindings.mockResolvedValue([
      { characterName: "沈昭", aliases: [], auraId: "aura-1" },
    ])
    mocks.listCharacterAuras.mockResolvedValue([{ id: "aura-1", name: "剑心" }])
    mocks.loadCharacterAuraSkillDocument.mockResolvedValue("剑法技能书")
    mocks.resolveEntityPath.mockResolvedValue(`${PP}/wiki/entities/characters/沈昭.md`)
    mocks.readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith(".output.json")) {
        return ingestJson([charEntry(fullFields)])
      }
      if (String(p).endsWith("沈昭.md")) return "档案页补充"
      throw enoent(String(p))
    })
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.characters).toHaveLength(1)
    const ch = result.characters[0]
    expect(ch.id).toBe("沈昭")
    expect(ch.profile).toContain("身份：剑修")
    expect(ch.profile).toContain("阵营：青云门")
    expect(ch.profile).toContain("目标：复仇")
    expect(ch.profile).toContain("角色弧光：从冷漠到担当")
    expect(ch.profile).toContain("当前状态：重伤")
    expect(ch.profile).toContain("档案页补充")
    expect(ch.cognition).toEqual({ knows: ["秘闻"], doesNotKnow: ["真相"] })
    expect(ch.aura).toMatchObject({ id: "aura-1" })
    expect(ch.skillContent).toBe("剑法技能书")
    expect(ch.soul).toBe("")
  })

  it("同名角色跨文件合并：章节累加去重、档案保留最新、认知保留旧值", async () => {
    mockIngest({
      "001.output.json": ingestJson([
        charEntry({ ...fullFields, appearanceChapters: [1, 2] }),
      ]),
      "002.output.json": ingestJson([
        charEntry({
          name: "沈昭",
          aliases: ["阿昭"],
          identity: "掌门",
          appearanceChapters: [2, 3, "oops"],
          cognition: { knows: "不是数组", doesNotKnow: [] },
        }),
      ]),
      "003.output.json": "not-json{{{",
    })
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.characters).toHaveLength(1)
    const ch = result.characters[0]
    // 最新文件覆盖档案（只有身份一行），非法认知回退旧值
    expect(ch.profile).toBe("身份：掌门")
    expect(ch.cognition).toEqual({ knows: ["秘闻"], doesNotKnow: ["真相"] })
    expect(ch.aura).toBeNull()
    expect(ch.skillContent).toBe("")
  })

  it("无档案字段时沿用旧档案、无别名时为空数组、非角色条目与空名被跳过", async () => {
    mockIngest({
      "001.output.json": ingestJson([
        charEntry({ name: "叶远", identity: "医者", aliases: ["小叶"] }),
        charEntry({ name: "独行", identity: "散修" }, ""),
        { entryType: "location", title: "青云山", fields: { name: "青云山" } },
        charEntry({ name: "   " }, ""),
        // 无 title 又无 name：覆盖 f.name ?? entry.title ?? "" 的末端回退
        { entryType: "character", fields: { identity: "无名氏" } },
      ]),
      // 有别名但无档案字段 → 沿用旧档案（同时覆盖 existing.aliases 分支）
      "002.output.json": ingestJson([charEntry({ name: "叶远", aliases: ["小叶"] })]),
    })
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.characters.map((c) => c.name)).toEqual(["叶远", "独行"])
    const ye = result.characters[0]
    expect(ye.profile).toBe("身份：医者")
    expect(ye.cognition).toBeNull()
    // 首现即无别名 → 空数组
    expect(result.characters[1].profile).toBe("身份：散修")
  })

  it("别名双向匹配光环、认知走 cognitionState 回退、技能与档案失败留空", async () => {
    mockIngest({ "001.output.json": ingestJson([charEntry({ name: "阿昭", aliases: ["沈昭"] })]) })
    mocks.getCharacterAuraBindings.mockResolvedValue([
      { characterName: "沈昭", aliases: ["阿昭"], auraId: "aura-9" },
    ])
    mocks.listCharacterAuras.mockResolvedValue([{ id: "aura-9", name: "别名光环" }])
    mocks.loadCognitionState.mockResolvedValue({
      characters: [{ character: "阿昭", knows: ["k"], doesNotKnow: [] }],
    })
    mocks.loadCharacterAuraSkillDocument.mockRejectedValue(new Error("skill missing"))
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.characters[0].aura).toMatchObject({ id: "aura-9" })
    expect(result.characters[0].cognition).toEqual({ knows: ["k"], doesNotKnow: [] })
    expect(result.characters[0].skillContent).toBe("")
    // 无档案页（resolveEntityPath 默认抛错）→ profile 为空串
    expect(result.characters[0].profile).toBe("")
  })

  it("摄入产物目录缺失且无 LLM 时返回空角色", async () => {
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.characters).toEqual([])
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("摄入产物文件读取失败被跳过", async () => {
    mocks.listDirectory.mockImplementation(async (dir: string) => {
      if (String(dir).endsWith("/.novel/chapter-ingest-output")) {
        return [node("001.output.json", String(dir))]
      }
      throw enoent(String(dir))
    })
    mocks.readFile.mockRejectedValue(enoent("read"))
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.characters).toEqual([])
  })
})

describe("角色提取：LLM 兜底路径", () => {
  function mockChaptersForLlm(): void {
    mocks.listDirectory.mockImplementation(async (dir: string) => {
      if (String(dir).endsWith("/wiki/chapters")) {
        return [node("ch1.md", String(dir))]
      }
      throw enoent(String(dir))
    })
    mocks.readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith("ch1.md")) return chapterMd(1, "开篇", "正文正文")
      throw enoent(String(p))
    })
  }

  const llmConfig = { provider: "test", model: "m" } as never

  it("摄入为空时用 LLM 从正文提取角色并做别名/章节号清洗", async () => {
    mockChaptersForLlm()
    mocks.streamChat.mockImplementation(
      async (_cfg: unknown, _msgs: unknown, cb: { onToken: (t: string) => void; onDone: () => void }) => {
        cb.onToken(
          '前言 [{"name":"李白","aliases":["太白"],"identity":"诗人","personality":"豪放","goals":"仗剑天涯","faction":"唐","appearanceChapters":[1,"2","坏"]}, {"name":"   "}, {"name":"杜甫","appearanceChapters":"不是数组"}] 后记',
        )
        cb.onDone()
      },
    )
    const result = await extractStoryContent(PP, {
      sourceChapters: 3,
      llmConfig,
    })
    expect(result.characters).toHaveLength(2)
    expect(result.characters[0]).toMatchObject({ id: "李白", name: "李白" })
    expect(result.characters[0].profile).toContain("身份：诗人")
    expect(result.characters[0].profile).toContain("性格：豪放")
    expect(result.characters[0].profile).toContain("目标：仗剑天涯")
    expect(result.characters[0].profile).toContain("阵营：唐")
    expect(result.characters[0].cognition).toBeNull()
    expect(result.characters[1].name).toBe("杜甫")
  })

  it("LLM 无 JSON / 非数组 / 抛错时返回空角色", async () => {
    mockChaptersForLlm()
    mocks.streamChat.mockImplementation(
      async (_c: unknown, _m: unknown, cb: { onToken: (t: string) => void; onDone: () => void }) => {
        cb.onToken("纯文本，没有数组")
        cb.onDone()
      },
    )
    expect(
      (await extractStoryContent(PP, { sourceChapters: 3, llmConfig })).characters,
    ).toEqual([])

    mocks.streamChat.mockImplementation(
      async (_c: unknown, _m: unknown, cb: { onToken: (t: string) => void; onDone: () => void }) => {
        cb.onToken('{"name":"不是数组"}')
        cb.onDone()
      },
    )
    expect(
      (await extractStoryContent(PP, { sourceChapters: 3, llmConfig })).characters,
    ).toEqual([])

    mocks.streamChat.mockRejectedValue(new Error("llm down"))
    expect(
      (await extractStoryContent(PP, { sourceChapters: 3, llmConfig })).characters,
    ).toEqual([])
  })

  it("有章节但无 llmConfig 时不走 LLM", async () => {
    mockChaptersForLlm()
    const result = await extractStoryContent(PP, { sourceChapters: 3 })
    expect(result.characters).toEqual([])
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })
})

describe("补充分支覆盖", () => {
  function mockDirs(
    outlines?: Record<string, string>,
    chapters?: Record<string, string>,
    ingest?: Record<string, string>,
  ): void {
    mocks.listDirectory.mockImplementation(async (dir: string) => {
      const d = String(dir)
      if (d.endsWith("/wiki/outlines") && outlines) {
        return Object.keys(outlines).map((n) => node(n, d))
      }
      if (d.endsWith("/wiki/chapters") && chapters) {
        return Object.keys(chapters).map((n) => node(n, d))
      }
      if (d.endsWith("/.novel/chapter-ingest-output") && ingest) {
        return Object.keys(ingest).map((n) => node(n, d))
      }
      throw enoent(d)
    })
    const all = { ...outlines, ...chapters, ...ingest }
    mocks.readFile.mockImplementation(async (p: string) => {
      const hit = Object.entries(all).find(([n]) => String(p).endsWith(`/${n}`))
      if (hit) return hit[1]
      throw enoent(String(p))
    })
  }

  it("标题空数组回退文件名（fmString ?? 空分支）", async () => {
    mockDirs(undefined, { "t.md": "---\nchapter_number: 1\ntitle: []\n---\n正文\n" })
    const result = await extractStoryContent(PP, { sourceChapters: 5 })
    expect(result.chapterContents[0]).toMatchObject({ chapterNumber: 1, title: "t" })
  })

  it("摄入 JSON 无 entries 且条目无 fields 时按 title 建档", async () => {
    mockDirs(undefined, undefined, {
      "001.output.json": "{}",
      "002.output.json": ingestJson([{ entryType: "character", title: "有名" }]),
    })
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.characters).toHaveLength(1)
    expect(result.characters[0]).toMatchObject({ name: "有名", profile: "" })
  })

  it("有 llmConfig 但无章节正文时直接返回空且不调 LLM", async () => {
    const result = await extractStoryContent(PP, {
      sourceChapters: 3,
      llmConfig: { provider: "t", model: "m" } as never,
    })
    expect(result.characters).toEqual([])
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("LLM onError 被忽略、无名条目被跳过", async () => {
    mockDirs(undefined, { "c.md": chapterMd(1, "开篇", "正文") })
    mocks.streamChat.mockImplementation(
      async (_c: unknown, _m: unknown, cb: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void }) => {
        cb.onToken('[{"identity":"无名项"},{"name":"白居易","identity":"诗人"}]')
        cb.onError(new Error("mid-stream"))
        cb.onDone()
      },
    )
    const result = await extractStoryContent(PP, {
      sourceChapters: 3,
      llmConfig: { provider: "t", model: "m" } as never,
    })
    expect(result.characters).toHaveLength(1)
    expect(result.characters[0]).toMatchObject({ name: "白居易" })
  })

  it("光环匹配走第三条件且 id 缺失回退 null；三条件全空则无绑定", async () => {
    mockDirs(undefined, undefined, {
      "001.output.json": ingestJson([
        charEntry({ name: "乙", aliases: ["Y"] }, ""),
        charEntry({ name: "甲", aliases: ["A"] }, ""),
      ]),
    })
    // binding 无 aliases 字段：乙经 info.aliases 命中但光环 id 缺失 → null；
    // 甲三条件全空 → 无绑定
    mocks.getCharacterAuraBindings.mockResolvedValue([{ characterName: "Y", auraId: "a-missing" }])
    mocks.listCharacterAuras.mockResolvedValue([{ id: "other", name: "他山之石" }])
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.characters.find((c) => c.name === "乙")!.aura).toBeNull()
    expect(result.characters.find((c) => c.name === "甲")!.aura).toBeNull()
  })

  it("cognitionState 无匹配角色时认知保持 null", async () => {
    mockDirs(undefined, undefined, {
      "001.output.json": ingestJson([charEntry({ name: "丙" }, "")]),
    })
    mocks.loadCognitionState.mockResolvedValue({
      characters: [{ character: "丁", knows: ["k"], doesNotKnow: [] }],
    })
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.characters[0].cognition).toBeNull()
  })

  it("光环/绑定/认知三补充源失败时降级为空仍出角色", async () => {
    mockDirs(undefined, undefined, {
      "001.output.json": ingestJson([charEntry({ name: "庚", identity: "侠客" }, "")]),
    })
    mocks.listCharacterAuras.mockRejectedValue(new Error("aura down"))
    mocks.getCharacterAuraBindings.mockRejectedValue(new Error("binding down"))
    mocks.loadCognitionState.mockRejectedValue(new Error("cog down"))
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.characters).toHaveLength(1)
    expect(result.characters[0]).toMatchObject({ name: "庚", aura: null, cognition: null })
  })

  it("档案页空串跳过、空档案配有内容档案页直接采用", async () => {
    mockDirs(undefined, undefined, {
      "001.output.json": ingestJson([
        charEntry({ name: "戊" }, ""),
        charEntry({ name: "己", identity: "渔夫" }, ""),
      ]),
    })
    mocks.resolveEntityPath.mockImplementation(async (pp: string, name: string) => `${pp}/e/${name}.md`)
    const ingestRaw = ingestJson([
      charEntry({ name: "戊" }, ""),
      charEntry({ name: "己", identity: "渔夫" }, ""),
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith("戊.md")) return "档案正文"
      if (String(p).endsWith("己.md")) return ""
      if (String(p).endsWith(".output.json")) return ingestRaw
      throw enoent(String(p))
    })
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.characters.find((c) => c.name === "戊")!.profile).toBe("档案正文")
    expect(result.characters.find((c) => c.name === "己")!.profile).toBe("身份：渔夫")
  })
})

describe("世界规则与力量体系 extractSectionByKeyword", () => {
  function mockOutline(content: string): void {
    mocks.listDirectory.mockImplementation(async (dir: string) => {
      if (String(dir).endsWith("/wiki/outlines")) return [node("o.md", String(dir))]
      throw enoent(String(dir))
    })
    mocks.readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith("o.md")) return content
      throw enoent(String(p))
    })
  }

  it("定位关键词章节并截断到下一标题", async () => {
    mockOutline(
      "# 大纲\n\n## 世界规则\n灵气复苏\n境界划分\n\n## 人物\nxxx\n\n## 修炼体系\n炼气筑基\n",
    )
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.outlineContent).toContain("世界规则")
    expect(result.worldRules).toBe("灵气复苏\n境界划分")
    expect(result.powerSystem).toBe("炼气筑基")
  })

  it("空章节跳过并继续匹配下一关键词标题、无匹配返回空", async () => {
    mockOutline("## 世界规则设定\n## 世界观设定\n真正的规则\n\n## 其他\n")
    const result = await extractStoryContent(PP, { sourceChapters: 0 })
    expect(result.worldRules).toBe("真正的规则")
    expect(result.powerSystem).toBe("")
  })
})
