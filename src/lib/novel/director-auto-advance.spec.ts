import { beforeEach, describe, expect, it, vi } from "vitest"

// 内存 fs：writeFileAtomic / createDirectory / readFile 全部走内存，测试零磁盘。
const files = new Map<string, string>()
vi.mock("@/commands/fs", () => ({
  fileExists: async (path: string) => files.has(path),
  readFile: async (path: string) => {
    const found = files.get(path)
    if (found === undefined) throw new Error(`ENOENT ${path}`)
    return found
  },
  writeFile: async (path: string, contents: string) => {
    files.set(path, contents)
  },
  writeFileAtomic: async (path: string, contents: string) => {
    files.set(path, contents)
  },
  createDirectory: async () => {},
  listDirectory: async (path: string) => {
    const prefix = path.endsWith("/") ? path : `${path}/`
    return [...files.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ name: key.slice(prefix.length), path: key, is_dir: false }))
  },
}))

vi.mock("./module-heat", () => ({ recordModuleHit: () => {} }))

const {
  advanceDirectorAutomatically,
  advanceDirectorToStall,
  assertIrreversible,
  recoveryCursor,
  isPipelineCompleted,
} = await import("./director-auto-advance")
const { createDirectorPipeline, advanceDirectorPhase, DIRECTOR_PHASES } = await import("./director-pipeline")
const { memoryJournal } = await import("./stage-output-journal-test-helpers")

import type { DirectorSnapshot } from "./director-orchestrator"
import type { LlmConfig } from "@/stores/wiki-store"

const LLM = { provider: "custom", apiKey: "k", model: "m", customEndpoint: "https://x/v1" } as unknown as LlmConfig

const PROJECT = "/proj"

const IDEA_JSON = JSON.stringify({
  title: "身体都是租的",
  genre: "都市异能",
  coreConflict: "主角要赎身，房东要收回他的身体",
  logline: "l",
  hooks: ["h1", "h2"],
})
const CHARACTER_JSON = JSON.stringify({
  characters: [
    { name: "陈默", role: "protagonist", desire: "赎身", flaw: "撒谎" },
    { name: "房东", role: "antagonist", desire: "收租", flaw: "赌" },
  ],
})
const OUTLINE_JSON = JSON.stringify({
  framework: "三幕",
  volumes: [
    { title: "第一卷", arc: "起", chapterCount: 30 },
    { title: "第二卷", arc: "转", chapterCount: 30 },
  ],
})
const CHAPTERS_JSON = JSON.stringify({
  firstChapter: { title: "第一章 租约", beats: ["签合同", "让渡"], hook: "房东用了他的脸" },
})
const PROSE = "正文".repeat(400)

function stageCompleter(counter: { calls: number }) {
  return async (messages: Array<{ role: string; content: string }>) => {
    counter.calls += 1
    const prompt = messages[1]?.content ?? ""
    if (prompt.includes("character 阶段")) return CHARACTER_JSON
    if (prompt.includes("outline 阶段")) return OUTLINE_JSON
    if (prompt.includes("chapters 阶段")) return CHAPTERS_JSON
    return IDEA_JSON
  }
}

/** 门输入：产物落盘后（generatedStages 命中）对应门为真，模拟真实门读取。 */
function snapshotFactory(generated: Set<string>): (projectPath: string, idea: { title: string; genre: string; coreConflict: string }) => Promise<DirectorSnapshot> {
  return async (_projectPath, idea) => ({
    idea,
    worldComplete: generated.has("world"),
    protagonistNamed: generated.has("character"),
    antagonistNamed: generated.has("character"),
    frameworkChosen: generated.has("outline"),
    volumesPlanned: generated.has("outline"),
    firstChapterReady: generated.has("chapters"),
  })
}

function deps(
  generated: Set<string>,
  counter: { calls: number },
  journal?: ReturnType<typeof memoryJournal>["runtime"],
  overrides: Record<string, unknown> = {},
) {
  return {
    llmConfig: LLM,
    complete: stageCompleter(counter),
    completeProse: async () => PROSE,
    collectSnapshot: snapshotFactory(generated),
    persistArtifacts: async (_projectPath: string, stage: string) => {
      generated.add(stage)
    },
    deriveWorld: async () => {
      generated.add("world")
    },
    writeFirstChapterDraft: async (_p: string, _chapterName: string, content: string) => {
      generated.add("chapters")
      return { id: "draft_test_1", chars: content.length }
    },
    ...(journal ? { journal } : {}),
    ...overrides,
  }
}

beforeEach(() => {
  files.clear()
})

describe("开书导演自动推进 · 门未过 → 生成 → 门过 → 推进", () => {
  it("idea 阶段：生成立意卡后过门并推进到 world", async () => {
    const counter = { calls: 0 }
    const generated = new Set<string>()
    const state = createDirectorPipeline()
    const outcome = await advanceDirectorAutomatically(
      PROJECT,
      state,
      { title: "", genre: "", coreConflict: "" },
      deps(generated, counter),
    )

    expect(outcome.generated).toBe(true)
    expect(outcome.stage).toBe("idea")
    expect(outcome.advanced).toBe(true)
    expect(outcome.state.currentPhase).toBe("world")
    expect(outcome.state.statuses.idea).toBe("done")
    expect(counter.calls).toBe(1)
    // 产物存档可用于后续阶段当上游
    const artifacts = JSON.parse(files.get(`${PROJECT}/.novel/director-stage-artifacts.json`) ?? "{}")
    expect(artifacts.stages.idea.title).toBe("身体都是租的")
    // 状态已原子持久化
    expect(files.get(`${PROJECT}/.novel/director-pipeline.json`)).toContain("\"currentPhase\": \"world\"")
  })

  it("world 阶段走既有蓝图派生（不调四阶段生成器）", async () => {
    const counter = { calls: 0 }
    const generated = new Set<string>()
    const state = { ...createDirectorPipeline(), currentPhase: "world" as const }
    const outcome = await advanceDirectorAutomatically(
      PROJECT,
      state,
      { title: "身体都是租的", genre: "都市异能", coreConflict: "赎身" },
      deps(generated, counter),
    )
    expect(counter.calls).toBe(0)
    expect(outcome.stage).toBeUndefined()
    expect(outcome.advanced).toBe(true)
    expect(outcome.state.currentPhase).toBe("character")
  })

  it("chapters 阶段：生成计划 + 首章草稿，门未过时留恢复游标（Draft-first 不放宽）", async () => {
    const counter = { calls: 0 }
    const generated = new Set<string>(["idea", "world", "character", "outline"])
    const state = { ...createDirectorPipeline(), currentPhase: "chapters" as const }
    const outcome = await advanceDirectorAutomatically(
      PROJECT,
      state,
      { title: "身体都是租的", genre: "都市异能", coreConflict: "赎身" },
      deps(generated, counter),
    )
    // 生成器写草稿 → 测试桩把 chapters 标记为就绪时才会推进；这里模拟「接受后才算就绪」
    expect(outcome.generated).toBe(true)
    expect(outcome.drafts).toEqual([{ id: "draft_test_1", chapterName: "第一章 租约", chars: PROSE.length }])
    expect(outcome.advanced).toBe(true)
    expect(outcome.completed).toBe(true)
  })

  it("首章正文过短判失败，不写草稿", async () => {
    const counter = { calls: 0 }
    const generated = new Set<string>(["idea", "world", "character", "outline"])
    const writeFirstChapterDraft = vi.fn()
    const state = { ...createDirectorPipeline(), currentPhase: "chapters" as const }
    const outcome = await advanceDirectorAutomatically(
      PROJECT,
      state,
      { title: "身体都是租的", genre: "都市异能", coreConflict: "赎身" },
      deps(generated, counter, undefined, { completeProse: async () => "太短了", writeFirstChapterDraft }),
    )
    expect(outcome.advanced).toBe(false)
    expect(outcome.error).toContain("首章正文过短")
    expect(writeFirstChapterDraft).not.toHaveBeenCalled()
    expect(outcome.state.statuses.chapters).toBe("failed")
  })
})

describe("开书导演自动推进 · 生成失败 → failed + 可重试", () => {
  it("结构校验失败：状态 failed + retryCount 1 + lastError，且未落产物存档", async () => {
    const counter = { calls: 0 }
    const generated = new Set<string>()
    const state = createDirectorPipeline()
    const outcome = await advanceDirectorAutomatically(
      PROJECT,
      state,
      { title: "x", genre: "y", coreConflict: "z" },
      deps(generated, counter, undefined, {
        complete: async () => JSON.stringify({ title: "只有书名" }),
      }),
    )
    expect(outcome.advanced).toBe(false)
    expect(outcome.error).toContain("idea 阶段产物结构不合格")
    expect(outcome.findings?.length).toBeGreaterThan(0)
    expect(outcome.state.statuses.idea).toBe("failed")
    expect(outcome.state.retryCount.idea).toBe(1)
    expect(outcome.state.lastError).toContain("结构不合格")
    expect(outcome.recovery).toMatchObject({ phase: "idea", retryCount: 1 })
    expect(files.has(`${PROJECT}/.novel/director-stage-artifacts.json`)).toBe(false)
    // 状态也已落盘（面板重启后仍能看到失败与重试次数）
    expect(files.get(`${PROJECT}/.novel/director-pipeline.json`)).toContain("\"failed\"")
  })

  it("重试会再次生成，成功后清空 lastError 并推进", async () => {
    const counter = { calls: 0 }
    const generated = new Set<string>()
    let attempt = 0
    const complete = async (messages: Array<{ role: string; content: string }>) => {
      attempt += 1
      counter.calls += 1
      const prompt = messages[1]?.content ?? ""
      if (attempt === 1) return "不是 JSON"
      if (prompt.includes("character 阶段")) return CHARACTER_JSON
      if (prompt.includes("outline 阶段")) return OUTLINE_JSON
      if (prompt.includes("chapters 阶段")) return CHAPTERS_JSON
      return IDEA_JSON
    }
    const state = createDirectorPipeline()
    const first = await advanceDirectorAutomatically(
      PROJECT,
      state,
      { title: "x", genre: "y", coreConflict: "z" },
      deps(generated, counter, undefined, { complete }),
    )
    expect(first.state.statuses.idea).toBe("failed")

    const { retryDirectorPhase } = await import("./director-pipeline")
    const retried = retryDirectorPhase(first.state)
    const second = await advanceDirectorAutomatically(
      PROJECT,
      retried,
      { title: "x", genre: "y", coreConflict: "z" },
      deps(generated, counter, undefined, { complete }),
    )
    expect(second.advanced).toBe(true)
    expect(second.state.statuses.idea).toBe("done")
    expect(second.state.lastError).toBeUndefined()
    expect(counter.calls).toBe(2)
  })

  it("落盘失败也按失败处理（不假装推进）", async () => {
    const counter = { calls: 0 }
    const generated = new Set<string>()
    const outcome = await advanceDirectorAutomatically(
      PROJECT,
      createDirectorPipeline(),
      { title: "a", genre: "b", coreConflict: "c" },
      deps(generated, counter, undefined, {
        persistArtifacts: async () => {
          throw new Error("磁盘只读")
        },
      }),
    )
    expect(outcome.advanced).toBe(false)
    expect(outcome.error).toContain("磁盘只读")
    expect(outcome.state.statuses.idea).toBe("failed")
  })
})

describe("开书导演自动推进 · journal 命中不重复生成", () => {
  it("同指令二次推进：命中 journal（cached=true，LLM 只调 1 次）", async () => {
    const counter = { calls: 0 }
    const journal = memoryJournal()
    const generated = new Set<string>()

    const firstState = createDirectorPipeline()
    const first = await advanceDirectorAutomatically(
      PROJECT,
      firstState,
      { title: "身体都是租的", genre: "都市异能", coreConflict: "赎身" },
      deps(generated, counter, journal.runtime),
    )
    expect(first.cached).toBe(false)
    expect(counter.calls).toBe(1)

    // 回退到同一阶段再跑一次（模拟失败重试/重入），应命中 journal
    const replay = await advanceDirectorAutomatically(
      PROJECT,
      firstState,
      { title: "身体都是租的", genre: "都市异能", coreConflict: "赎身" },
      deps(generated, counter, journal.runtime),
    )
    expect(replay.cached).toBe(true)
    expect(counter.calls).toBe(1)
    expect(replay.advanced).toBe(true)
  })
})

describe("开书导演自动推进 · 状态不可逆", () => {
  it("done 阶段不允许回退", () => {
    const done = { ...createDirectorPipeline(), statuses: { ...createDirectorPipeline().statuses, idea: "done" as const } }
    const reverted = { ...done, statuses: { ...done.statuses, idea: "pending" as const } }
    expect(() => assertIrreversible(done, reverted)).toThrow(/不可逆/)
  })

  it("currentPhase 不允许后移", () => {
    const forward = { ...createDirectorPipeline(), currentPhase: "outline" as const }
    const backward = { ...forward, currentPhase: "character" as const }
    expect(() => assertIrreversible(forward, backward)).toThrow(/不可逆/)
  })

  it("已完成管线不再生成也不再推进", async () => {
    const completed = {
      ...createDirectorPipeline(),
      currentPhase: "chapters" as const,
      statuses: Object.fromEntries(DIRECTOR_PHASES.map((p) => [p, "done"]) ) as Record<string, "done">,
    }
    const counter = { calls: 0 }
    const generated = new Set<string>()
    const outcome = await advanceDirectorAutomatically(
      PROJECT,
      completed as unknown as ReturnType<typeof createDirectorPipeline>,
      { title: "a", genre: "b", coreConflict: "c" },
      deps(generated, counter),
    )
    expect(isPipelineCompleted(completed as never)).toBe(true)
    expect(outcome.advanced).toBe(false)
    expect(outcome.completed).toBe(true)
    expect(outcome.generated).toBe(false)
    expect(counter.calls).toBe(0)
  })

  it("门未过时只置 failed，不跳到下一阶段", async () => {
    const counter = { calls: 0 }
    const emptyGate = async (_p: string, idea: DirectorSnapshot["idea"]) => ({
      idea,
      worldComplete: false,
      protagonistNamed: false,
      antagonistNamed: false,
      frameworkChosen: false,
      volumesPlanned: false,
      firstChapterReady: false,
    })
    const state = { ...createDirectorPipeline(), currentPhase: "world" as const }
    const outcome = await advanceDirectorAutomatically(
      PROJECT,
      state,
      { title: "a", genre: "b", coreConflict: "c" },
      deps(new Set<string>(), counter, undefined, { collectSnapshot: emptyGate, deriveWorld: async () => {} }),
    )
    expect(outcome.advanced).toBe(false)
    expect(outcome.blockedReason).toContain("世界骨架未完备")
    expect(outcome.state.currentPhase).toBe("world")
    expect(outcome.state.statuses.world).toBe("failed")
    expect(recoveryCursor(outcome.state)).toMatchObject({ phase: "world", retryCount: 1 })
  })
})

describe("开书导演自动推进 · 连续推进到停滞", () => {
  it("从全新管线一路推进到 chapters 草稿完成（五阶段串联）", async () => {
    const counter = { calls: 0 }
    const generated = new Set<string>()
    const journal = memoryJournal()
    const run = await advanceDirectorToStall(
      PROJECT,
      { title: "身体都是租的", genre: "都市异能", coreConflict: "赎身" },
      deps(generated, counter, journal.runtime),
    )
    expect(run.steps.map((s) => s.state.currentPhase)).toEqual(["world", "character", "outline", "chapters", "chapters"])
    expect(run.state.statuses.idea).toBe("done")
    expect(run.state.statuses.character).toBe("done")
    expect(run.state.statuses.outline).toBe("done")
    expect(isPipelineCompleted(run.state)).toBe(true)
    expect(run.steps[run.steps.length - 1]?.drafts?.[0].id).toBe("draft_test_1")
    // idea/character/outline/chapters 各调 1 次（world 走蓝图派生）
    expect(counter.calls).toBe(4)
  })
})

describe("开书导演自动推进 · 门过之后的状态推进仍走既有纯函数", () => {
  it("advanceDirectorPhase 与自动推进结果一致（同一门输入）", async () => {
    const generated = new Set<string>()
    const counter = { calls: 0 }
    const state = createDirectorPipeline()
    const outcome = await advanceDirectorAutomatically(
      PROJECT,
      state,
      { title: "t", genre: "g", coreConflict: "c" },
      deps(generated, counter),
    )
    const manual = advanceDirectorPhase(state, {
      idea: { title: "身体都是租的", genre: "都市异能", coreConflict: "主角要赎身，房东要收回他的身体" },
      worldComplete: false,
      protagonistNamed: false,
      antagonistNamed: false,
      frameworkChosen: false,
      volumesPlanned: false,
      firstChapterReady: false,
    })
    expect(outcome.state.currentPhase).toBe(manual.state.currentPhase)
    expect(outcome.state.statuses).toEqual(manual.state.statuses)
  })
})
