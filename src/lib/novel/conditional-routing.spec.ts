import { beforeEach, describe, expect, it, vi } from "vitest"

// fs mocks — selectActiveEntities 用 listDirectory + readFile（entity pages
// 在 wiki/entities/ 下，graph-adapter.ts:577 entitiesDir 现存路径 read-only 复用）。
const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(async (_path: string): Promise<any[]> => []),
  readFile: vi.fn(async (_path: string): Promise<string> => ""),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: fsMocks.readFile,
      listDirectory: fsMocks.listDirectory,
      // context-engine import chain 引用 writeFileAtomic/createDirectory 等，
      // 但 selectActiveEntities 路径不调用它们 — 给空 stub 避免未模拟告警。
      writeFileAtomic: vi.fn(async (_path: string, _contents: string): Promise<void> => {}),
      createDirectory: vi.fn(async (_path: string): Promise<void> => {}),
      getFileModifiedTime: vi.fn(async (_path: string): Promise<number> => 0),
    
  }
})

import { selectActiveEntities } from "./context-engine"

/** 构造一个 entity page markdown（graph-adapter.ts:440 现存 frontmatter 格式）。 */
function entityPage(name: string, type: string, tags: string[]): string {
  return [
    "---",
    `type: ${type}`,
    `title: "${name}"`,
    `tags: [${tags.map((t) => `"${t}"`).join(", ")}]`,
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n")
}

/** FileNode 最小集（listDirectory 返回值）。 */
function fileNode(name: string, path: string): { name: string; path: string; is_dir: boolean } {
  return { name, path, is_dir: false }
}

describe("EPIC-003 / ADR-32 / TASK-006: conditional entity-tags routing", () => {
  beforeEach(() => {
    fsMocks.listDirectory.mockReset()
    fsMocks.readFile.mockReset()
  })

  it("entity 匹配双源：chapter outline mentions + scene characters", async () => {
    // 三个 entity page：A 在 outline 提及（源 A），B 在 characterStates 提及（源 B），
    // C 既不在 outline 也不在 characterStates（不应匹配）。
    fsMocks.listDirectory.mockResolvedValue([
      fileNode("alice.md", "/P/wiki/entities/alice.md"),
      fileNode("bob.md", "/P/wiki/entities/bob.md"),
      fileNode("carol.md", "/P/wiki/entities/carol.md"),
    ])
    const readFileMap: Record<string, string> = {
      "/P/wiki/entities/alice.md": entityPage("Alice", "character", ["relevance:high"]),
      "/P/wiki/entities/bob.md": entityPage("Bob", "character", ["relevance:medium"]),
      "/P/wiki/entities/carol.md": entityPage("Carol", "character", ["relevance:low"]),
    }
    fsMocks.readFile.mockImplementation(async (path: string) => readFileMap[path] ?? "")

    // outline mentions Alice（源 A）；characterStates 提及 Bob（源 B）；Carol 两源都不在。
    const result = await selectActiveEntities("/P", {
      chapterNumber: 3,
      outline: "第3章：Alice 进入森林",
      sceneCharacters: "第2章：Bob 发现线索",
    })

    const names = result.map((e) => e.name)
    expect(names).toContain("Alice") // chapter outline mentions
    expect(names).toContain("Bob") // scene characters
    expect(names).not.toContain("Carol") // 双源都不匹配 — 不注入
  })

  it("零 entity 优雅降级：双源匹配为空时回退全量（additive，不减少上下文）+ warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    fsMocks.listDirectory.mockResolvedValue([
      fileNode("alice.md", "/P/wiki/entities/alice.md"),
      fileNode("bob.md", "/P/wiki/entities/bob.md"),
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("alice.md")) return entityPage("Alice", "character", [])
      if (path.endsWith("bob.md")) return entityPage("Bob", "character", [])
      return ""
    })

    // outline + sceneCharacters 都不提及任何 entity name → 零匹配 → 回退全量。
    const result = await selectActiveEntities("/P", {
      chapterNumber: 1,
      outline: "完全无关的大纲文本",
      sceneCharacters: "完全无关的角色状态文本",
    })

    // 回退全量（加性原则 — 不减少现有上下文）。
    expect(result.map((e) => e.name).sort()).toEqual(["Alice", "Bob"])
    // 标 warning（grep 'warning'/'回退'/'fallback' convergence）。
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("conditional routing matched zero entities"),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("falling back to all entities"),
    )
    warnSpy.mockRestore()
  })

  it("entities 目录不存在时优雅降级返回空（项目未摄取过章节）", async () => {
    fsMocks.listDirectory.mockRejectedValue(new Error("dir not found"))
    const result = await selectActiveEntities("/Empty", {
      chapterNumber: 1,
      outline: "x",
      sceneCharacters: "y",
    })
    expect(result).toEqual([])
  })

  it("entities 目录为空时返回空", async () => {
    fsMocks.listDirectory.mockResolvedValue([])
    const result = await selectActiveEntities("/P", {
      chapterNumber: 1,
      outline: "x",
      sceneCharacters: "y",
    })
    expect(result).toEqual([])
  })

  it("entity 优先级：relevance:high(主线) > medium(配角) > low(背景)", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      fileNode("low.md", "/P/wiki/entities/low.md"),
      fileNode("high.md", "/P/wiki/entities/high.md"),
      fileNode("med.md", "/P/wiki/entities/med.md"),
    ])
    const readFileMap: Record<string, string> = {
      "/P/wiki/entities/high.md": entityPage("High", "character", ["relevance:high"]),
      "/P/wiki/entities/med.md": entityPage("Med", "character", ["relevance:medium"]),
      "/P/wiki/entities/low.md": entityPage("Low", "character", ["relevance:low"]),
    }
    fsMocks.readFile.mockImplementation(async (path: string) => readFileMap[path] ?? "")

    // 三个都在 outline 提及 → 全匹配，按优先级排序。
    const result = await selectActiveEntities("/P", {
      chapterNumber: 1,
      outline: "High Med Low 都在",
      sceneCharacters: "",
    })

    const names = result.map((e) => e.name)
    expect(names).toEqual(["High", "Med", "Low"]) // 主线 > 配角 > 背景
  })

  it("location:chapter-N tag 提升当前章节关联 entity 至主线层级", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      fileNode("loc.md", "/P/wiki/entities/loc.md"),
      fileNode("other.md", "/P/wiki/entities/other.md"),
    ])
    const readFileMap: Record<string, string> = {
      "/P/wiki/entities/loc.md": entityPage("Forest", "location", ["location:chapter-3", "relevance:low"]),
      "/P/wiki/entities/other.md": entityPage("Other", "character", ["relevance:medium"]),
    }
    fsMocks.readFile.mockImplementation(async (path: string) => readFileMap[path] ?? "")

    const result = await selectActiveEntities("/P", {
      chapterNumber: 3, // 匹配 location:chapter-3
      outline: "Forest Other",
      sceneCharacters: "",
    })

    // Forest 因 location:chapter-3 匹配当前章节 → 提升至 rank 0（主线），排第一。
    expect(result[0].name).toBe("Forest")
  })

  it("tags 缺失的 entity 仍参与匹配（additive frontmatter only）", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      fileNode("plain.md", "/P/wiki/entities/plain.md"),
    ])
    // entity page 无 tags 字段（additive — tags 是可选 frontmatter）。
    fsMocks.readFile.mockResolvedValue(
      ["---", "type: entity", 'title: "Plain"', "---", "", "# Plain", ""].join("\n"),
    )

    const result = await selectActiveEntities("/P", {
      chapterNumber: 1,
      outline: "Plain 出现在大纲",
      sceneCharacters: "",
    })

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Plain")
    expect(result[0].tags).toEqual([])
  })

  it("sidecar 存在时源 A 走字段匹配", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      fileNode("alice.md", "/P/wiki/entities/alice.md"),
      fileNode("bob.md", "/P/wiki/entities/bob.md"),
    ])
    const sidecar = JSON.stringify({
      schemaVersion: 2,
      updatedAt: "2026-11-01",
      volumes: [
        {
          number: 1,
          title: "第1卷",
          arc: "",
          chapters: [
            {
              id: "v01c001",
              volume: 1,
              chapter: 1,
              title: "断桥",
              pov: "",
              arc: "",
              entities: ["Alice"],
              foreshadow: { plant: [], payoff: [] },
              constraints: [],
              prose: { goal: "", scenes: [], emotion: "" },
              updatedAt: "2026-11-01",
            },
          ],
        },
      ],
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "/P/.novel/outline-model.json") return sidecar
      if (path.endsWith("alice.md")) return entityPage("Alice", "character", [])
      if (path.endsWith("bob.md")) return entityPage("Bob", "character", [])
      return ""
    })

    // outline 文本提到 Bob，但 sidecar 的 chapter.entities 只有 Alice → Bob 不再因文本命中。
    const result = await selectActiveEntities("/P", {
      chapterNumber: 1,
      outline: "Bob 出现在大纲",
      sceneCharacters: "",
    })

    expect(result.map((e) => e.name)).toEqual(["Alice"])
  })

  it("HARD-1 守恒：selectActiveEntities 函数体不写 status.json", async () => {
    // 静态检查：源码不含 writeStatus/saveStatus/persistCheckpoint 调用。
    // entity 路由仅读 entity-page frontmatter，MUST NOT 写 status.json。
    const { readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const srcPath = resolve(__dirname, "context-engine.ts")
    const srcText = readFileSync(srcPath, "utf-8")
    // 提取 selectActiveEntities 函数体（从函数签名到下一个 export）。
    const fnStart = srcText.indexOf("export async function selectActiveEntities")
    expect(fnStart).toBeGreaterThanOrEqual(0)
    const nextExport = srcText.indexOf("export ", fnStart + 10)
    const fnBody = nextExport > 0 ? srcText.slice(fnStart, nextExport) : srcText.slice(fnStart)
    // HARD-1：entity 路由块内无 status.json 写操作。
    expect(fnBody).not.toMatch(/writeStatus|saveStatus|persistCheckpoint/)
  })
})

/**
 * s5-autotest 补测试轮：context-engine 源 A（sidecar 字段寻址）回退矩阵（任务缺口 3）。
 *
 * 六条路径各一条 it，加上两条附加边界：
 *   ① sidecar 缺失 → 文本路径
 *   ② sidecar 损坏 → 文本路径（不抛错）
 *   ③ 该章 entities 为空数组 → 文本路径 + 记账（R-05）
 *   ④ entities 非空命中 → 字段寻址（既有 it「sidecar 存在时源 A 走字段匹配」已覆盖）
 *   ⑤ entities 非空但零命中 → 回退全量 + 降级记账
 *   ⑥ ≥2 章同号歧义 → 文本路径 + 记账
 *   ⑦ sidecar 无该章号（0 命中）→ 文本路径，不注入错误实体
 *   ⑧ 无 chapterNumber → 根本不读 sidecar
 *
 * 判定标准：把任一条回退分支改坏（例如空数组不再回退、歧义不再回退），对应 it 必须转红。
 */
const SIDECAR_PATH = "/P/.novel/outline-model.json"

interface SidecarChapter {
  chapter: number
  volume?: number
  entities: unknown
}

/** 构造合法 sidecar（v2）：按卷分组，其余字段填最小合法值。 */
function sidecarJson(chapters: SidecarChapter[]): string {
  const byVolume = new Map<number, Array<Record<string, unknown>>>()
  for (const entry of chapters) {
    const volume = entry.volume ?? 1
    const bucket = byVolume.get(volume) ?? []
    bucket.push({
      id: `v0${volume}c${String(entry.chapter).padStart(3, "0")}`,
      volume,
      chapter: entry.chapter,
      title: `章${entry.chapter}`,
      pov: "",
      arc: "",
      entities: entry.entities,
      foreshadow: { plant: [], payoff: [] },
      constraints: [],
      prose: { goal: "", scenes: [], emotion: "" },
      updatedAt: "2026-11-01",
    })
    byVolume.set(volume, bucket)
  }
  return JSON.stringify({
    schemaVersion: 2,
    updatedAt: "2026-11-01",
    volumes: [...byVolume.entries()].map(([number, list]) => ({
      number,
      title: `第${number}卷`,
      arc: "",
      chapters: list,
    })),
  })
}

/** 两个 entity page（Alice / Bob）+ 指定 sidecar 文本（null = 读盘失败）。 */
function stubProject(sidecarText: string | null): void {
  fsMocks.listDirectory.mockResolvedValue([
    fileNode("alice.md", "/P/wiki/entities/alice.md"),
    fileNode("bob.md", "/P/wiki/entities/bob.md"),
  ])
  fsMocks.readFile.mockImplementation(async (path: string) => {
    if (path === SIDECAR_PATH) {
      if (sidecarText === null) throw new Error("ENOENT: no such file or directory")
      return sidecarText
    }
    if (path.endsWith("alice.md")) return entityPage("Alice", "character", [])
    if (path.endsWith("bob.md")) return entityPage("Bob", "character", [])
    return ""
  })
}

describe("EPIC-003 源 A 回退矩阵：sidecar 缺失 / 损坏 / 空数组 / 零命中 / 歧义（s5-autotest）", () => {
  beforeEach(() => {
    fsMocks.listDirectory.mockReset()
    fsMocks.readFile.mockReset()
  })

  it("① sidecar 缺失（读盘 ENOENT）→ 源 A 回退 outline 文本匹配", async () => {
    stubProject(null)
    const result = await selectActiveEntities("/P", {
      chapterNumber: 1,
      outline: "第1章：Alice 进入森林",
      sceneCharacters: "",
    })

    // 文本路径生效的证据：文本命中的 Alice 进，未命中的 Bob 不进（若误判为「回退全量」会多出 Bob）。
    expect(result.map((entity) => entity.name)).toEqual(["Alice"])
  })

  it("② sidecar 损坏（非法 JSON）→ 同样回退文本匹配，且不抛错", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    stubProject("{not json")

    const result = await selectActiveEntities("/P", {
      chapterNumber: 1,
      outline: "第1章：Alice 进入森林",
      sceneCharacters: "",
    })

    expect(result.map((entity) => entity.name)).toEqual(["Alice"])
    // DEBT-R15：当前唯一生产消费者丢弃 loaded.error（静默降级），因此这里不该有 warn。
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("③ 该章 entities 为空数组 → 与 null 同路回退文本匹配并记账（R-05）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    stubProject(sidecarJson([{ chapter: 1, entities: [] }]))

    const result = await selectActiveEntities("/P", {
      chapterNumber: 1,
      outline: "第1章：Alice 进入森林",
      sceneCharacters: "",
    })

    // 空数组对 `if` 是 truthy：旧写法会跳过文本回退 ⇒ 结果变「回退全量」[Alice, Bob]。
    expect(result.map((entity) => entity.name)).toEqual(["Alice"])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("该章未列 entities"))
    warnSpy.mockRestore()
  })

  it("⑤ entities 非空但与 wiki 名零命中 → 回退全量 + 降级记账（加性原则）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    stubProject(sidecarJson([{ chapter: 1, entities: ["Zed"] }]))

    const result = await selectActiveEntities("/P", {
      chapterNumber: 1,
      outline: "第1章：Alice 进入森林",
      sceneCharacters: "",
    })

    // 字段寻址命中 0 个 ⇒ 不减少上下文（回退全量），并留降级证据。
    expect(result.map((entity) => entity.name).sort()).toEqual(["Alice", "Bob"])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("conditional routing matched zero entities"),
    )
    warnSpy.mockRestore()
  })

  it("⑥ ≥2 章同号（卷内章号重启）→ 判定歧义，回退文本匹配并记账", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    stubProject(
      sidecarJson([
        { chapter: 3, volume: 1, entities: ["Bob"] },
        { chapter: 3, volume: 2, entities: ["Alice"] },
      ]),
    )

    const result = await selectActiveEntities("/P", {
      chapterNumber: 3,
      outline: "第3章：Alice 进入森林",
      sceneCharacters: "",
    })

    // 歧义不得任选一卷采信：若采信第 1 卷会只返回 Bob。
    expect(result.map((entity) => entity.name)).toEqual(["Alice"])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("章号歧义"))
    warnSpy.mockRestore()
  })

  it("⑦ sidecar 存在但没有该章号 → 回退文本匹配，不注入错误实体", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    stubProject(sidecarJson([{ chapter: 7, entities: ["Bob"] }]))

    const result = await selectActiveEntities("/P", {
      chapterNumber: 1,
      outline: "第1章：Alice 进入森林",
      sceneCharacters: "",
    })

    expect(result.map((entity) => entity.name)).toEqual(["Alice"])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("⑧ 无 chapterNumber → 根本不读 sidecar（缺章号不得触发无意义读盘/误匹配）", async () => {
    stubProject(sidecarJson([{ chapter: 1, entities: ["Bob"] }]))

    const result = await selectActiveEntities("/P", {
      outline: "Alice 出现在大纲",
      sceneCharacters: "",
    })

    expect(result.map((entity) => entity.name)).toEqual(["Alice"])
    expect(fsMocks.readFile).not.toHaveBeenCalledWith(SIDECAR_PATH)
  })
})
