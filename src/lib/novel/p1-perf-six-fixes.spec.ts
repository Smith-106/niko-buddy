/**
 * P1 性能六项改造 regress spec（ISS-20260709-036 / 037 / 047 / 051 / ISS-20260713-002 / ISS-20260712-PERF-1）。
 *
 * 每项 ≥1 个等价性/性能断言；行为语义零变化，只钉性能形态：
 * - 036: N vr 串行→并行（Promise.all 保序回填）——并发度断言 + 保序断言。
 * - 037: 80 文件全量读→按需增量 + 复用缓存——readFile 调用计数断言 + 结果等价断言。
 * - 047: 逐次重建 compact→增量缓冲——多切分等价断言 + 增量语义断言。
 * - 051: .includes 去重 O(n²)→Set——纯函数首见序等价断言。
 * - 002: 六维冗余重建 contextPack→复用——build 跳过断言 + 注入包真实消费断言。
 * - PERF-1: 孪生收敛——双检索孪生公共投影一致 + 维度缓存规范序守卫。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PageSearchResult } from "@/lib/embedding"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import type { LlmConfig } from "@/stores/wiki-store"
import type { StreamCallbacks } from "@/lib/llm-client"
import type { FileNode } from "@/types/wiki"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
  listDirectory: vi.fn<(path: string) => Promise<FileNode[]>>(),
  searchByEmbedding: vi.fn<(pp: string, query: string, cfg: EmbeddingConfig, topK: number) => Promise<PageSearchResult[]>>(),
  streamChatMock: vi.fn(),
  buildContextPackMock: vi.fn(),
  hasUsableLlmMock: vi.fn(() => true),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: (...args: [string]) => mocks.readFile(...args),
    listDirectory: (...args: [string]) => mocks.listDirectory(...args),
  }
})

vi.mock("@/lib/embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embedding")>()
  return {
    ...actual,
    searchByEmbedding: (...args: [string, string, EmbeddingConfig, number]) =>
      mocks.searchByEmbedding(...args),
  }
})

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
    streamChat: mocks.streamChatMock,
    combineAbortSignals: (...signals: Array<AbortSignal | undefined>): AbortSignal | undefined => {
      const active = signals.filter(Boolean) as AbortSignal[]
      if (active.length === 0) return undefined
      if (active.length === 1) return active[0]
      const controller = new AbortController()
      return controller.signal
    },
  }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: {
      getState: () => ({
        llmConfig: {
          provider: "custom",
          apiKey: "test-key",
          model: "test-review-model",
          ollamaUrl: "",
          customEndpoint: "https://example.test/v1",
          maxContextSize: 120000,
          reasoning: { mode: "off" },
        },
        novelConfig: { reviewModel: "" },
        novelMode: true,
      }),
    },
  }
})

vi.mock("@/lib/has-usable-llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/has-usable-llm")>()
  return {
    ...actual,
    hasUsableLlm: () => mocks.hasUsableLlmMock(),
  }
})

vi.mock("./model-resolver", () => ({
  resolveNovelModel: (config: LlmConfig) => config,
}))

vi.mock("./novel-skill-hooks", () => ({
  createGoldScaleReadinessHook: () => ({ id: "gold-readiness", run: async () => {} }),
  createAvoidAiMechanicalSlopHook: () => ({ id: "avoid-ai-m", run: async () => {} }),
  createCedSoftReportHook: () => ({ id: "ced-soft", run: async () => {} }),
  createDeAiDualPassHook: () => ({ id: "deai-dual", run: async () => {} }),
  createStatisticalAiSignatureHook: () => ({ id: "ai-sig", run: async () => {} }),
  registerNovelSkillHook: () => {},
  runNovelSkillHooks: async () => ({
    projectPath: "PP",
    chapterNumber: 1,
    stage: "pre_six_dim_review",
    bag: { promptFragments: [], notes: [] },
  }),
}))

vi.mock("./context-engine", () => ({
  buildContextPack: mocks.buildContextPackMock,
  contextPackToPrompt: (pack: { task: string }) => `当前任务：${pack.task}`,
}))

import { runVectorSearchShared } from "./vector-search-core"
import { runVectorSearch } from "./search-adapter"
import { runVectorSearchForContext } from "./context-retrieval"
import {
  readChapterOutlineDirect,
} from "./context-engine-outline"
import {
  createRepeatedTailDetector,
  findRepeatedTailStart,
} from "./deep-chapter-utils"
import {
  appendRunEvent,
  createRunEventLedger,
  listReplayIds,
  type RunEventInput,
} from "./run-event-ledger"
import { normalizeUserSkill } from "./skill-library"
import { evaluateFullWindowDrift } from "../quality/full-window-drift-gate"
import {
  getCachedDimensionResults,
  runSixDimensionReview,
} from "./dimension-review-adapter"
import type { ContextPack } from "./context-engine"

const PP = "/proj"
const embOn = (): EmbeddingConfig => ({
  enabled: true,
  endpoint: "http://127.0.0.1:1",
  apiKey: "k",
  model: "m",
})

beforeEach(() => {
  mocks.readFile.mockReset()
  mocks.listDirectory.mockReset()
  mocks.searchByEmbedding.mockReset()
  mocks.streamChatMock.mockReset()
  mocks.buildContextPackMock.mockReset()
  mocks.hasUsableLlmMock.mockReturnValue(true)
  mocks.readFile.mockRejectedValue(new Error("no such file"))
  mocks.listDirectory.mockResolvedValue([])
})

// ── ISS-20260709-036 ──────────────────────────────────────────────
describe("ISS-20260709-036 runVectorSearchShared N vr 并行保序", () => {
  it("保序：慢 vr 先返回也不抢位，结果顺序与候选序一致", async () => {
    mocks.searchByEmbedding.mockResolvedValue([
      { id: "alpha", score: 0.9 },
      { id: "bravo", score: 0.9 },
      { id: "charlie", score: 0.9 },
    ])
    let active = 0
    let maxActive = 0
    mocks.readFile.mockImplementation(async (p: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        // 所有 probe 至少悬起一个 macrotask，使并发在途可被观测（同步完成的
        // mock 不会交叠，会把并行误测成串行）；bravo 额外慢 40ms 验证保序。
        if (p.endsWith("/entities/bravo.md")) await new Promise((r) => setTimeout(r, 40))
        else await new Promise((r) => setTimeout(r, 5))
        if (p.includes("/entities/")) {
          const slug = p.split("/").pop()?.replace(/\.md$/, "") ?? "x"
          return `# ${slug} title\n${slug} body content`
        }
        throw new Error("miss")
      } finally {
        active -= 1
      }
    })
    const hits = await runVectorSearchShared({ pp: PP, query: "q", limit: 3, embCfg: embOn() })
    expect(hits.map((h) => h.safeId)).toEqual(["alpha", "bravo", "charlie"])
    expect(hits.map((h) => h.path)).toEqual([
      `${PP}/wiki/entities/alpha.md`,
      `${PP}/wiki/entities/bravo.md`,
      `${PP}/wiki/entities/charlie.md`,
    ])
    // 性能断言：3 vr × 7 路径并发在途（串行外层最多 7 并发，>7 证明 vr 间并行）。
    expect(maxActive).toBeGreaterThan(7)
  })

  it("等价：缺文件 vr 跳过其余保留，顺序不变", async () => {
    mocks.searchByEmbedding.mockResolvedValue([
      { id: "alpha", score: 0.9 },
      { id: "ghost", score: 0.9 },
      { id: "charlie", score: 0.9 },
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.includes("ghost")) throw new Error("miss")
      if (p.includes("/entities/")) return `# T\nbody`
      throw new Error("miss")
    })
    const hits = await runVectorSearchShared({ pp: PP, query: "q", limit: 3, embCfg: embOn() })
    expect(hits.map((h) => h.safeId)).toEqual(["alpha", "charlie"])
  })
})

// ── ISS-20260709-037 ──────────────────────────────────────────────
describe("ISS-20260709-037 readChapterOutlineDirect 按需增量+缓存", () => {
  const outlineTree = (): FileNode[] =>
    Array.from({ length: 25 }, (_, i) => ({
      name: `outline-${i}.md`,
      path: `${PP}/wiki/outlines/outline-${i}.md`,
      is_dir: false,
    }))
  const contents = new Map<string, string>()
  const generic = (i: number) => `# 杂项 ${i}\n与目标无关的填充正文。`
  const ch3 = `---\nchapter_number: 3\n---\n# 第3章 大纲\n主角进入祠堂。`

  beforeEach(() => {
    contents.clear()
    for (let i = 0; i < 25; i += 1) contents.set(`${PP}/wiki/outlines/outline-${i}.md`, generic(i))
    contents.set(`${PP}/wiki/outlines/outline-2.md`, ch3)
    contents.set(`${PP}/wiki/outlines/outline-22.md`, `## 第7章 目标\n追查族谱缺页。`)
    mocks.listDirectory.mockImplementation(async (p: string) =>
      p.endsWith("/wiki/outlines") ? outlineTree() : [],
    )
  })

  it("frontmatter 首批命中只读首批 + 结果等价", async () => {
    let calls = 0
    mocks.readFile.mockImplementation(async (p: string) => {
      calls += 1
      const c = contents.get(p)
      if (c === undefined) throw new Error("miss")
      return c
    })
    const out = await readChapterOutlineDirect(PP, 3)
    expect(out).toContain("第3章")
    // 性能断言：25 文件只读首批 10 个（改前 25 全读）。
    expect(calls).toBe(10)
  })

  it("frontmatter 中部命中只读到命中批 + 结果等价", async () => {
    contents.set(`${PP}/wiki/outlines/outline-15.md`, `---\nchapter_number: 5\n---\n# 第5章 大纲\n推进。`)
    let calls = 0
    mocks.readFile.mockImplementation(async (p: string) => {
      calls += 1
      const c = contents.get(p)
      if (c === undefined) throw new Error("miss")
      return c
    })
    const out = await readChapterOutlineDirect(PP, 5)
    expect(out).toContain("第5章")
    // 性能断言：命中在第 16 个文件，只读前两批 20 个（改前 25 全读）。
    expect(calls).toBe(20)
  })

  it("无 frontmatter 时读完等价 heading 回退（语义不变）", async () => {
    let calls = 0
    mocks.readFile.mockImplementation(async (p: string) => {
      calls += 1
      const c = contents.get(p)
      if (c === undefined) throw new Error("miss")
      return c
    })
    const out = await readChapterOutlineDirect(PP, 7)
    expect(out).toContain("第7章")
    // heading 回退需排除全量 frontmatter，读完 25 个与改前一致（零行为差）。
    expect(calls).toBe(25)
  })
})

// ── ISS-20260709-047 ──────────────────────────────────────────────
describe("ISS-20260709-047 增量重复尾检测器", () => {
  const OPTS = { minChars: 100, windowChars: 120, hitLimit: 3 }
  const B = "ab".repeat(60)
  const repeatContent = `${"前".repeat(50)}${B}${B}${B}`
  const plainContent = Array.from({ length: 40 }, (_, i) => `第${i}节填充文本，无任何重复模式可言。`).join("\n")
  const crlfContent = `首段\r\n${"丁".repeat(50)} ${B}\n${B}\r\n${B} 尾`

  function chunked(content: string, size: number): string[] {
    const out: string[] = []
    for (let i = 0; i < content.length; i += size) out.push(content.slice(i, i + size))
    return out
  }

  it.each([repeatContent, plainContent, crlfContent])(
    "多切分等价：整串/7字块/单字块结果一致",
    (content) => {
      const expected = findRepeatedTailStart(content, OPTS)
      for (const size of [content.length, 7, 1]) {
        const d = createRepeatedTailDetector(OPTS)
        for (const chunk of chunked(content, size)) d.push(chunk)
        expect(d.check()).toBe(expected)
      }
    },
  )

  it("重复命中值等价 + 增量语义（compact 只增不重建）", () => {
    const expected = findRepeatedTailStart(repeatContent, OPTS)
    expect(expected).toBe(170)
    const d = createRepeatedTailDetector(OPTS)
    expect(d.compactLength).toBe(0)
    d.push(`${"前".repeat(50)}${B}`)
    const lenAfterFirst = d.compactLength
    expect(lenAfterFirst).toBe(170)
    expect(d.check()).toBeNull()
    d.push(`${B}${B}`)
    expect(d.compactLength).toBe(410)
    expect(d.check()).toBe(expected)
    d.reset()
    expect(d.compactLength).toBe(0)
    expect(d.check()).toBeNull()
  })

  it("性能：3000 token 增量喂入 + 单次 check 有界完成", () => {
    const d = createRepeatedTailDetector(OPTS)
    const started = Date.now()
    for (let i = 0; i < 3000; i += 1) d.push(`令牌${i}填充。`)
    const result = d.check()
    expect(Date.now() - started).toBeLessThan(3000)
    expect(result).toBeNull()
  })
})

// ── ISS-20260709-051 ──────────────────────────────────────────────
describe("ISS-20260709-051 includes 去重 sweep 改 Set", () => {
  function baseEvent(seq: number, overrides: Partial<RunEventInput> = {}): RunEventInput {
    return {
      seq,
      eventId: `evt-${seq}`,
      ts: "2026-09-12T00:00:00.000Z",
      kind: "stage",
      actor: "system",
      ...overrides,
    }
  }

  it("listReplayIds 首见序去重等价", () => {
    let ledger = createRunEventLedger()
    const inputs: RunEventInput[] = [
      baseEvent(0, { replayId: "rp-1" }),
      baseEvent(1, { replayId: "rp-2" }),
      baseEvent(2, { replayId: "rp-1" }),
      baseEvent(3),
      baseEvent(4, { replayId: "rp-2" }),
      baseEvent(5, { replayId: "rp-3" }),
    ]
    for (const input of inputs) ledger = appendRunEvent(ledger, input)
    expect(listReplayIds(ledger)).toEqual(["rp-1", "rp-2", "rp-3"])
  })

  it("normalizeUserSkill tags/stages 去重首见序等价", () => {
    const skill = normalizeUserSkill({
      tags: ["b", "a", "b", " a ", ""],
      stages: ["output", "rewrite", "output"],
    })
    expect(skill.tags).toEqual(["b", "a"])
    expect(skill.stages).toEqual(["output", "rewrite"])
  })

  it("evaluateFullWindowDrift 重叠窗去重等价（升序唯一）", () => {
    const result = evaluateFullWindowDrift([1, 1, 1, 0, 0, 0, 1, 1, 1])
    expect(result.triggered).toBe(true)
    expect(result.chaptersToRecheck).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(new Set(result.chaptersToRecheck).size).toBe(result.chaptersToRecheck.length)
  })
})

// ── ISS-20260713-002 ──────────────────────────────────────────────
describe("ISS-20260713-002 runSixDimensionReview 复用 contextPack", () => {
  const injectedPack = {
    task: "P1-六项复用断言专用任务",
    chapterGoal: "复用包章节目标",
    outline: "复用包大纲",
    recentSummaries: ["s1"],
    previousChapterEnding: "结尾",
    characterStates: "人物",
    soulDoc: "",
    characterAuras: "",
    cognitionStates: "认知",
    foreshadowingStates: "伏笔",
    timeline: "时间线",
    relatedSettings: "设定",
    canonRules: "",
    writingStyle: "风格",
    searchResults: "检索",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
  } as unknown as ContextPack

  beforeEach(() => {
    mocks.buildContextPackMock.mockResolvedValue(injectedPack)
    mocks.streamChatMock.mockImplementation(
      async (_c: unknown, messages: Array<{ content: string }>, callbacks: StreamCallbacks) => {
        const prompt = messages.map((m) => m.content).join("\n")
        if (prompt.includes("最终 JSON")) {
          callbacks.onToken(
            JSON.stringify({ score: 8, status: "pass", summary: "ok", issues: [] }),
          )
        } else {
          callbacks.onToken("分析")
        }
        callbacks.onDone()
      },
    )
  })

  it("注入包时跳过 buildContextPack 且 prompt 真实消费注入包", async () => {
    const seenPrompts: string[] = []
    mocks.streamChatMock.mockImplementation(
      async (_c: unknown, messages: Array<{ content: string }>, callbacks: StreamCallbacks) => {
        const prompt = messages.map((m) => m.content).join("\n")
        seenPrompts.push(prompt)
        if (prompt.includes("最终 JSON")) {
          callbacks.onToken(
            JSON.stringify({ score: 8, status: "pass", summary: "ok", issues: [] }),
          )
        } else {
          callbacks.onToken("分析")
        }
        callbacks.onDone()
      },
    )
    const results = await runSixDimensionReview({
      projectPath: PP,
      chapterContent: "正文",
      chapterNumber: 8,
      dimensionKeys: ["thrill"],
      contextPack: injectedPack,
    })
    expect(mocks.buildContextPackMock).not.toHaveBeenCalled()
    expect(results.thrill?.status).toBe("pass")
    expect(seenPrompts.some((p) => p.includes("P1-六项复用断言专用任务"))).toBe(true)
  })

  it("未注入时回退原 build 路径", async () => {
    const results = await runSixDimensionReview({
      projectPath: PP,
      chapterContent: "正文",
      chapterNumber: 8,
      dimensionKeys: ["thrill"],
    })
    expect(mocks.buildContextPackMock).toHaveBeenCalledTimes(1)
    expect(mocks.buildContextPackMock).toHaveBeenCalledWith(PP, "六维审查第8章", 8)
    expect(results.thrill?.status).toBe("pass")
  })
})

// ── ISS-20260712-PERF-1 孪生收敛 ──────────────────────────────────
describe("ISS-20260712-PERF-1 性能孪生剩余项收敛", () => {
  it("双检索孪生公共投影一致（同形 parity 未漂移）", async () => {
    mocks.searchByEmbedding.mockResolvedValue([
      { id: "alpha", score: 0.9 },
      { id: "bravo", score: 0.9 },
    ])
    mocks.readFile.mockImplementation(async (p: string) => {
      if (p.includes("/entities/")) return `# T\nbody text`
      throw new Error("miss")
    })
    const adapter = await runVectorSearch(PP, "q", 2, embOn())
    const context = await runVectorSearchForContext(PP, "q", 2, { embeddingConfig: embOn() })
    expect(context.map((r) => ({ path: r.path, title: r.title, snippet: r.snippet }))).toEqual(
      adapter.map((r) => ({ path: r.path, title: r.title, snippet: r.snippet })),
    )
  })

  it("维度缓存读取恒为规范六维序（结构孪生守卫）", () => {
    const mk = (key: "thrill" | "pull", summary: string) => ({
      dimensionKey: key,
      score: 8,
      status: "pass" as const,
      summary,
      thinking: "t",
      issues: [],
    })
    const out = getCachedDimensionResults({ pull: mk("pull", "p"), thrill: mk("thrill", "t") })
    expect(out.map((r) => r.dimensionKey)).toEqual(["thrill", "pull"])
  })
})
