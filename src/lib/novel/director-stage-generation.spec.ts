import { beforeEach, describe, expect, it, vi } from "vitest"
import { streamChat } from "@/lib/llm-client"
import {
  buildStagePrompt,
  DirectorStageGenerationError,
  directorStageJournalKey,
  generateDirectorStage,
  generateDirectorStages,
  parseStageJson,
  validateStageOutput,
  type DirectorStageGenerationDeps,
} from "./director-stage-generation"
import {
  buildStageRecord,
  computeInstructionDigest,
  serializeRecord,
} from "./stage-output-journal"
import type { StageJournalDeps, StageJournalRuntime } from "./stage-output-journal"
import type { LlmConfig } from "@/stores/wiki-store"

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
}))

const mockStreamChat = vi.mocked(streamChat)

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

describe("开书导演阶段生成器 · 默认 streamChat 链路（无 complete 注入）", () => {
  const instruction = { idea: { title: "身体都是租的", genre: "都市异能", coreConflict: "活下去" } }

  beforeEach(() => {
    mockStreamChat.mockReset()
  })

  it("多 token 累积成完整 JSON 后解析校验（system+user 两条消息）", async () => {
    mockStreamChat.mockImplementation(async (_config, _messages, callbacks) => {
      const mid = Math.floor(IDEA_JSON.length / 2)
      callbacks.onToken(IDEA_JSON.slice(0, mid))
      callbacks.onToken(IDEA_JSON.slice(mid))
      callbacks.onDone()
    })
    const result = await generateDirectorStage("idea", instruction, { llmConfig: LLM })
    expect(result.cached).toBe(false)
    expect(result.digest).toBe("")
    expect(result.output.title).toBe("身体都是租的")
    expect(result.output.hooks).toHaveLength(3)
    expect(mockStreamChat).toHaveBeenCalledTimes(1)
    const [config, messages, , signal] = mockStreamChat.mock.calls[0]
    expect(config).toBe(LLM)
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("system")
    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toContain("idea 阶段")
    expect(signal).toBeUndefined()
  })

  it("streamChat onError → 原错上抛（不吞错、不伪造产物）", async () => {
    const failure = new Error("net down")
    mockStreamChat.mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken('{"title": "x"')
      callbacks.onError(failure)
    })
    await expect(generateDirectorStage("idea", instruction, { llmConfig: LLM })).rejects.toBe(failure)
  })

  it("signal 透传给 streamChat（可中断）", async () => {
    const controller = new AbortController()
    mockStreamChat.mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(IDEA_JSON)
      callbacks.onDone()
    })
    const result = await generateDirectorStage("idea", instruction, { llmConfig: LLM, signal: controller.signal })
    expect(result.output.title).toBe("身体都是租的")
    expect(mockStreamChat.mock.calls[0][3]).toBe(controller.signal)
  })

  it("默认链路产出结构不合格 → 抛 DirectorStageGenerationError", async () => {
    mockStreamChat.mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(JSON.stringify({ characters: [] }))
      callbacks.onDone()
    })
    await expect(generateDirectorStage("character", instruction, { llmConfig: LLM })).rejects.toBeInstanceOf(
      DirectorStageGenerationError,
    )
  })
})

describe("开书导演阶段生成器 · 校验分支补齐", () => {
  it("idea 缺字段逐项报缺口，空白标题与非数组钩子亦不合格", () => {
    const missing = validateStageOutput("idea", { title: "只有标题" })
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.findings.map((f) => f.path)).toEqual(
        expect.arrayContaining(["genre", "coreConflict", "logline", "hooks"]),
      )
    }

    const blankTitle = validateStageOutput("idea", {
      title: "   ",
      genre: "题材",
      coreConflict: "冲突",
      logline: "故事",
      hooks: ["钩子"],
    })
    expect(blankTitle.ok).toBe(false)
    if (!blankTitle.ok) {
      expect(blankTitle.findings.some((f) => f.path === "title")).toBe(true)
    }

    const badHooks = validateStageOutput("idea", {
      title: "标题",
      genre: "题材",
      coreConflict: "冲突",
      logline: "故事",
      hooks: "不是数组",
    })
    expect(badHooks.ok).toBe(false)
    if (!badHooks.ok) {
      expect(badHooks.findings.some((f) => f.path === "hooks")).toBe(true)
    }
  })

  it("character 非法条目逐项报缺口", () => {
    const notObject = validateStageOutput("character", null)
    expect(notObject.ok).toBe(false)
    if (!notObject.ok) {
      expect(notObject.findings.some((f) => f.path === "$.characters")).toBe(true)
    }

    const badEntries = validateStageOutput("character", {
      characters: [
        "字符串条目",
        { name: "", role: "cameo", desire: "", flaw: "" },
      ],
    })
    expect(badEntries.ok).toBe(false)
    if (!badEntries.ok) {
      const paths = badEntries.findings.map((f) => f.path)
      expect(paths).toEqual(expect.arrayContaining([
        "characters[1].name",
        "characters[1].role",
        "characters[1].desire",
        "characters[1].flaw",
      ]))
    }
  })

  it("character 配角与对手齐备时校验通过", () => {
    const result = validateStageOutput("character", {
      characters: [
        { name: "陈默", role: "protagonist", desire: "赎回身体", flaw: "撒谎" },
        { name: "房东", role: "antagonist", desire: "榨干租客", flaw: "赌瘾" },
        { name: "阿婆", role: "supporting", desire: "守住老街", flaw: "心软" },
      ],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.characters).toHaveLength(3)
    }
  })

  it("outline 缺框架与非法分卷逐项报缺口", () => {
    const notObject = validateStageOutput("outline", null)
    expect(notObject.ok).toBe(false)
    if (!notObject.ok) {
      expect(notObject.findings.some((f) => f.path === "framework")).toBe(true)
    }

    const badVolumes = validateStageOutput("outline", {
      framework: "三幕",
      volumes: [
        null,
        { title: "", arc: "", chapterCount: 0 },
      ],
    })
    expect(badVolumes.ok).toBe(false)
    if (!badVolumes.ok) {
      const paths = badVolumes.findings.map((f) => f.path)
      expect(paths).toEqual(expect.arrayContaining([
        "volumes[1].title",
        "volumes[1].arc",
        "volumes[1].chapterCount",
      ]))
    }
  })

  it("chapters 缺首章计划与字段逐项报缺口", () => {
    const notObject = validateStageOutput("chapters", null)
    expect(notObject.ok).toBe(false)
    if (!notObject.ok) {
      expect(notObject.findings.some((f) => f.path === "$.firstChapter")).toBe(true)
    }

    const nonObjectChapter = validateStageOutput("chapters", { firstChapter: "字符串" })
    expect(nonObjectChapter.ok).toBe(false)
    if (!nonObjectChapter.ok) {
      expect(nonObjectChapter.findings.map((f) => f.path)).toEqual(
        expect.arrayContaining(["firstChapter.title", "firstChapter.beats", "firstChapter.hook"]),
      )
    }

    const missingTitle = validateStageOutput("chapters", {
      firstChapter: { beats: ["节拍"], hook: "钩子" },
    })
    expect(missingTitle.ok).toBe(false)
    if (!missingTitle.ok) {
      expect(missingTitle.findings.some((f) => f.path === "firstChapter.title")).toBe(true)
    }

    const missingHook = validateStageOutput("chapters", {
      firstChapter: { title: "首章", beats: ["节拍"] },
    })
    expect(missingHook.ok).toBe(false)
    if (!missingHook.ok) {
      expect(missingHook.findings.some((f) => f.path === "firstChapter.hook")).toBe(true)
    }
  })

  it("prompt 对缺失设定回退待定占位", () => {
    const prompt = buildStagePrompt("outline", { idea: { title: "", genre: "", coreConflict: "" } })
    expect(prompt).toContain("书名：\uff08待定\uff09")
    expect(prompt).toContain("题材：\uff08待定\uff09")
    expect(prompt).toContain("核心冲突：\uff08待定\uff09")
  })

  it("journal 命中旧 schema 记录时重新生成并覆盖", async () => {
    const instruction = { idea: { title: "身体都是租的", genre: "都市异能", coreConflict: "活下去" } }
    const prompt = buildStagePrompt("outline", instruction)
    const digest = await computeInstructionDigest({ stage: "outline", prompt, instruction })
    const journalKey = directorStageJournalKey("outline")
    const stale = serializeRecord(buildStageRecord(digest, journalKey, { framework: "old" }, 1, 60_000))

    let reads = 0
    let written = ""
    const deps: StageJournalDeps = {
      read: async () => {
        reads += 1
        return reads === 1 ? stale : written
      },
      writeFile: async (_path, contents) => {
        written = contents
      },
      createDirectory: async () => {},
    }
    const journal: StageJournalRuntime = { projectId: "proj", deps, now: () => 1_000, ttlMs: 60_000 }
    let calls = 0
    const complete = async () => {
      calls += 1
      return OUTLINE_JSON
    }

    const result = await generateDirectorStage("outline", instruction, { llmConfig: LLM, journal, complete })
    expect(result.cached).toBe(false)
    expect(result.digest).toBe(digest)
    expect(result.output.volumes).toHaveLength(2)
    expect(calls).toBe(1)
    expect(written).toContain(digest)
    expect(written).toContain("第二卷 违约")
  })
})
