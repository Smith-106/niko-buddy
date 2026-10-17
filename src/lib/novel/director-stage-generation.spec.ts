import { describe, expect, it } from "vitest"
import {
  buildStagePrompt,
  DirectorStageGenerationError,
  generateDirectorStage,
  generateDirectorStages,
  parseStageJson,
  validateStageOutput,
  type DirectorStageGenerationDeps,
} from "./director-stage-generation"
import type { StageJournalDeps, StageJournalRuntime } from "./stage-output-journal"
import type { LlmConfig } from "@/stores/wiki-store"

const LLM = {
  provider: "custom",
  apiKey: "k",
  model: "m",
  customEndpoint: "https://api.example.com/v1",
} as unknown as LlmConfig

function memoryJournal(): { runtime: StageJournalRuntime; files: Map<string, string>; writes: number } {
  const files = new Map<string, string>()
  const state = { writes: 0 }
  const deps: StageJournalDeps = {
    read: async (path) => files.get(path) ?? "",
    writeFile: async (path, contents) => {
      state.writes += 1
      files.set(path, contents)
    },
    createDirectory: async () => {},
  }
  const runtime: StageJournalRuntime = { projectId: "proj", deps, now: () => 1_000, ttlMs: 60_000 }
  return {
    runtime,
    files,
    get writes() {
      return state.writes
    },
  }
}

function deps(complete: DirectorStageGenerationDeps["complete"], journal?: StageJournalRuntime): DirectorStageGenerationDeps {
  return { llmConfig: LLM, journal, complete }
}

const IDEA_JSON = JSON.stringify({
  title: "身体都是租的",
  genre: "都市异能",
  coreConflict: "主角要活下去，房东要收回他的身体",
  logline: "一个把身体租出去换寿命的人，被迫替房东还债。",
  hooks: ["身体租赁设定", "还债倒计时", "房东身份反转"],
})

const CHARACTER_JSON = JSON.stringify({
  characters: [
    { name: "陈默", role: "protagonist", desire: "赎回自己的身体", flaw: "习惯性撒谎" },
    { name: "房东", role: "antagonist", desire: "榨干租客剩余寿命", flaw: "赌性成瘾" },
  ],
})

const OUTLINE_JSON = JSON.stringify({
  framework: "三幕",
  volumes: [
    { title: "第一卷 出租", arc: "起：签下租约", chapterCount: 30 },
    { title: "第二卷 违约", arc: "转：债务反噬", chapterCount: 32 },
  ],
})

const CHAPTERS_JSON = JSON.stringify({
  firstChapter: { title: "第一章 租约", beats: ["签合同", "第一次让渡", "发现条款陷阱"], hook: "房东用了他的脸" },
})

describe("开书导演阶段生成器 · 结构校验", () => {
  it("idea 合格产物规范化返回", () => {
    const result = validateStageOutput("idea", JSON.parse(IDEA_JSON))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.title).toBe("身体都是租的")
      expect(result.value.hooks).toHaveLength(3)
    }
  })

  it("character 缺主角时不合格，并给出可读缺口", () => {
    const result = validateStageOutput("character", {
      characters: [{ name: "房东", role: "antagonist", desire: "钱", flaw: "赌" }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.findings.map((f) => f.message)).toContain("缺主角（protagonist）")
    }
  })

  it("outline 只规划 1 卷视为未分卷", () => {
    const result = validateStageOutput("outline", {
      framework: "三幕",
      volumes: [{ title: "第一卷", arc: "起", chapterCount: 30 }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.findings[0].path).toBe("volumes")
  })

  it("chapters 节拍为空数组不合格", () => {
    const result = validateStageOutput("chapters", {
      firstChapter: { title: "第一章", beats: [], hook: "钩子" },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.findings.some((f) => f.path === "firstChapter.beats")).toBe(true)
  })

  it("非对象/非字符串字段一律判不合格", () => {
    expect(validateStageOutput("idea", "文本").ok).toBe(false)
    expect(validateStageOutput("idea", { title: 123, genre: "x", coreConflict: "y", logline: "z", hooks: ["a"] }).ok).toBe(false)
  })
})

describe("开书导演阶段生成器 · 解析", () => {
  it("剥代码围栏后解析", () => {
    const parsed = parseStageJson("idea", "```json\n" + IDEA_JSON + "\n```") as { title: string }
    expect(parsed.title).toBe("身体都是租的")
  })

  it("空输出与坏 JSON 都抛 DirectorStageGenerationError", () => {
    expect(() => parseStageJson("idea", "   ")).toThrow(DirectorStageGenerationError)
    expect(() => parseStageJson("idea", "not json")).toThrow(DirectorStageGenerationError)
  })
})

describe("开书导演阶段生成器 · 幂等", () => {
  it("同指令复跑命中 journal，不重复调 LLM", async () => {
    const journal = memoryJournal()
    let calls = 0
    const complete = async () => {
      calls += 1
      return IDEA_JSON
    }
    const instruction = { idea: { title: "身体都是租的", genre: "都市异能", coreConflict: "活下去" } }

    const first = await generateDirectorStage("idea", instruction, deps(complete, journal.runtime))
    expect(first.cached).toBe(false)
    expect(first.output.title).toBe("身体都是租的")

    const second = await generateDirectorStage("idea", instruction, deps(complete, journal.runtime))
    expect(second.cached).toBe(true)
    expect(second.output.title).toBe("身体都是租的")
    expect(calls).toBe(1)
    expect(second.digest).toBe(first.digest)
  })

  it("指令变化 → digest 变化 → 重新调 LLM", async () => {
    const journal = memoryJournal()
    let calls = 0
    const complete = async () => {
      calls += 1
      return IDEA_JSON
    }
    await generateDirectorStage("idea", { idea: { title: "A", genre: "g", coreConflict: "c" } }, deps(complete, journal.runtime))
    const changed = await generateDirectorStage(
      "idea",
      { idea: { title: "A", genre: "g", coreConflict: "c" }, brief: "更硬核" },
      deps(complete, journal.runtime),
    )
    expect(changed.cached).toBe(false)
    expect(calls).toBe(2)
  })

  it("结构校验失败不落 journal，重试仍会调 LLM", async () => {
    const journal = memoryJournal()
    const journalWritesBefore = journal.writes
    let calls = 0
    const complete = async () => {
      calls += 1
      return JSON.stringify({ characters: [] })
    }
    await expect(
      generateDirectorStage(
        "character",
        { idea: { title: "A", genre: "g", coreConflict: "c" } },
        deps(complete, journal.runtime),
      ),
    ).rejects.toBeInstanceOf(DirectorStageGenerationError)
    expect(journal.writes).toBe(journalWritesBefore)
    expect([...journal.files.keys()]).toHaveLength(0)

    await expect(
      generateDirectorStage(
        "character",
        { idea: { title: "A", genre: "g", coreConflict: "c" } },
        deps(complete, journal.runtime),
      ),
    ).rejects.toBeInstanceOf(DirectorStageGenerationError)
    expect(calls).toBe(2)
  })

  it("缓存行结构已过时（旧 schema）→ 重新生成并覆盖", async () => {
    const journal = memoryJournal()
    let calls = 0
    const complete = async () => {
      calls += 1
      return calls === 1 ? JSON.stringify({ framework: "old" }) : OUTLINE_JSON
    }
    const instruction = { idea: { title: "A", genre: "g", coreConflict: "c" } }
    await expect(generateDirectorStage("outline", instruction, deps(complete, journal.runtime))).rejects.toBeInstanceOf(
      DirectorStageGenerationError,
    )
    const retried = await generateDirectorStage("outline", instruction, deps(complete, journal.runtime))
    expect(retried.cached).toBe(false)
    expect(retried.output.volumes).toHaveLength(2)
  })
})

describe("开书导演阶段生成器 · prompt 与串联", () => {
  it("prompt 确定性且按阶段注入上游产物", () => {
    const instruction = {
      idea: { title: "身体都是租的", genre: "都市异能", coreConflict: "活下去" },
      upstream: {},
    }
    expect(buildStagePrompt("idea", instruction)).toBe(buildStagePrompt("idea", instruction))
    const ideaOnly = buildStagePrompt("character", instruction)
    expect(ideaOnly).toContain("输出格式")
    expect(ideaOnly).not.toContain("## 上游阶段产物")

    const withUpstream = buildStagePrompt("outline", {
      ...instruction,
      upstream: {
        idea: { title: "身体都是租的", genre: "都市异能", coreConflict: "活下去", logline: "l", hooks: ["h"] },
        character: { characters: [{ name: "陈默", role: "protagonist", desire: "d", flaw: "f" }] },
      },
      targetVolumes: 4,
    })
    expect(withUpstream).toContain("## 上游阶段产物")
    expect(withUpstream).toContain("陈默")
    expect(withUpstream).toContain("4 卷")
  })

  it("多阶段串联把前序产物喂给后续阶段，且各自命中 journal", async () => {
    const journal = memoryJournal()
    const seen: string[] = []
    const complete = async (messages: Array<{ role: string; content: string }>) => {
      const user = messages[1]?.content ?? ""
      seen.push(user)
      if (user.includes("character 阶段")) return CHARACTER_JSON
      if (user.includes("outline 阶段")) return OUTLINE_JSON
      if (user.includes("chapters 阶段")) return CHAPTERS_JSON
      return IDEA_JSON
    }
    const instruction = { idea: { title: "身体都是租的", genre: "都市异能", coreConflict: "活下去" } }
    const run = await generateDirectorStages(["idea", "character", "outline", "chapters"] as const, instruction, deps(complete, journal.runtime))

    expect(run.idea.output.title).toBe("身体都是租的")
    expect(run.character.output.characters).toHaveLength(2)
    expect(run.outline.output.volumes).toHaveLength(2)
    expect(run.chapters.output.firstChapter.beats).toHaveLength(3)
    // outline prompt 含 character 产物
    expect(seen[2]).toContain("陈默")
    expect(seen[3]).toContain("三幕")

    const replay = await generateDirectorStages(["idea", "character", "outline", "chapters"] as const, instruction, deps(complete, journal.runtime))
    expect(replay.idea.cached && replay.character.cached && replay.outline.cached && replay.chapters.cached).toBe(true)
    expect(seen).toHaveLength(4)
  })
})
