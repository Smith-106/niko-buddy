import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"

/**
 * Full-surface spec for outline-generation.ts.
 * Mock conventions follow outline-import.spec.ts: vi.hoisted mocks + thin
 * vi.mock factories delegating to them, with beforeEach defaults.
 */

const mocks = vi.hoisted(() => {
  const outlineStore = {
    tasks: [] as Array<Record<string, unknown>>,
    seq: 0,
    createTask: (input: Record<string, unknown>) => {
      const id = `outline-task-${++outlineStore.seq}`
      outlineStore.tasks.unshift({ id, ...input })
      return id
    },
    updateTask: (taskId: string, patch: Record<string, unknown>) => {
      const task = outlineStore.tasks.find((t) => t.id === taskId)
      if (task) Object.assign(task, patch)
    },
  }
  const progress = {
    startTask: vi.fn(),
    finishTask: vi.fn(),
  }
  const wiki = {
    setActiveView: vi.fn(),
    setSelectedFile: vi.fn(),
    setFileContent: vi.fn(),
  }
  return {
    outlineStore,
    progress,
    wiki,
    streamChat: vi.fn(),
    buildContextPack: vi.fn(),
    ingestOutline: vi.fn(),
    getOutputLanguage: vi.fn(),
    createDirectory: vi.fn(),
    fileExists: vi.fn(),
    listDirectory: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    refreshProjectState: vi.fn(),
    i18nT: vi.fn(),
    getUniqueOutlinePath: vi.fn(),
    getFileName: vi.fn(),
    normalizePath: vi.fn(),
    outlineGenerationPrompt: vi.fn(),
  }
})

vi.mock("@/commands/fs", () => ({
  createDirectory: (...args: unknown[]) => mocks.createDirectory(...args),
  fileExists: (...args: unknown[]) => mocks.fileExists(...args),
  listDirectory: (...args: unknown[]) => mocks.listDirectory(...args),
  readFile: (...args: unknown[]) => mocks.readFile(...args),
  writeFile: (...args: unknown[]) => mocks.writeFile(...args),
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: (...args: unknown[]) => mocks.streamChat(...args),
  combineAbortSignals: (a?: AbortSignal, b?: AbortSignal) => a ?? b,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 1000,
}))

vi.mock("@/lib/output-language", () => ({
  getOutputLanguage: (...args: unknown[]) => mocks.getOutputLanguage(...args),
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: (...args: unknown[]) => mocks.normalizePath(...args),
  getFileName: (...args: unknown[]) => mocks.getFileName(...args),
  getUniqueOutlinePath: (...args: unknown[]) => mocks.getUniqueOutlinePath(...args),
}))

vi.mock("@/lib/project-refresh", () => ({
  refreshProjectState: (...args: unknown[]) => mocks.refreshProjectState(...args),
}))

vi.mock("@/i18n", () => ({
  default: { t: (...args: unknown[]) => mocks.i18nT(...args) },
}))

vi.mock("@/lib/novel/prompt-templates", () => ({
  PROMPTS: { outlineGeneration: (...args: unknown[]) => mocks.outlineGenerationPrompt(...args) },
}))

vi.mock("@/stores/outline-generation-store", () => ({
  useOutlineGenerationStore: { getState: () => mocks.outlineStore },
}))

vi.mock("@/stores/import-progress-store", () => ({
  useImportProgressStore: { getState: () => mocks.progress },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => mocks.wiki },
}))

vi.mock("./chapter-ingest", () => ({
  ingestOutline: (...args: unknown[]) => mocks.ingestOutline(...args),
}))

vi.mock("./context-engine", () => ({
  buildContextPack: (...args: unknown[]) => mocks.buildContextPack(...args),
}))

import {
  addOutlineFileToSourceList,
  addOutlineTaskToSourceList,
  buildOutlineGenerationPrompt,
  buildOutlineRefinementContext,
  createOutlineIngestTask,
  generateOutlineFile,
  generateOutlineRefinementFiles,
  generateOutlineRefinementSectionFile,
  hasOutlineForRefinement,
  openGeneratedOutline,
  runBulkOutlineIngest,
  runOutlineGenerationTask,
  runOutlineIngestTask,
  runOutlineRefinementTask,
  startOutlineIngestTask,
  type OutlineSectionGenerationKey,
} from "./outline-generation"

const llmConfig = {
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "https://example.test/v1",
  maxContextSize: 120000,
  reasoning: { mode: "high" },
} satisfies LlmConfig

beforeEach(() => {
  mocks.outlineStore.tasks.length = 0
  mocks.outlineStore.seq = 0
  mocks.progress.startTask.mockReset().mockReturnValue("import-progress-1")
  mocks.progress.finishTask.mockReset()
  mocks.wiki.setActiveView.mockReset()
  mocks.wiki.setSelectedFile.mockReset()
  mocks.wiki.setFileContent.mockReset()
  mocks.streamChat.mockReset()
  mocks.buildContextPack.mockReset()
  mocks.ingestOutline.mockReset()
  mocks.getOutputLanguage.mockReset().mockReturnValue("Chinese")
  mocks.createDirectory.mockReset().mockResolvedValue(undefined)
  mocks.fileExists.mockReset().mockResolvedValue(false)
  mocks.listDirectory.mockReset()
  mocks.readFile.mockReset()
  mocks.writeFile.mockReset().mockResolvedValue(undefined)
  mocks.refreshProjectState.mockReset().mockResolvedValue(undefined)
  mocks.i18nT.mockReset().mockImplementation((key: string) => key)
  mocks.getUniqueOutlinePath.mockReset().mockImplementation(async (dir: string, name: string) => `${dir}/${name}`)
  mocks.getFileName.mockReset().mockImplementation((p: string) => p.split("/").pop() ?? "")
  mocks.normalizePath.mockReset().mockImplementation((p: string) => p.replace(/\\/g, "/"))
  mocks.outlineGenerationPrompt.mockReset().mockImplementation(
    (genre: string, scale: string, premise: string, context: string) =>
      `请为以下小说生成大纲：\n类型=${genre} 规模=${scale} 核心设定=${premise}\n${context}`,
  )
})

/** A ContextPack whose refinement/generation sections are all non-empty. */
function fullPack() {
  return {
    task: "细化",
    chapterGoal: "",
    outline: "现有大纲",
    recentSummaries: ["摘要一", "", "摘要二"],
    previousChapterEnding: "",
    characterStates: "人物状态变化",
    soulDoc: "灵魂文档",
    characterAuras: "",
    cognitionStates: "角色认知",
    foreshadowingStates: "伏笔状态",
    timeline: "时间线",
    relatedSettings: "相关设定",
    canonRules: "正史规则",
    writingStyle: "",
    searchResults: "检索结果",
    graphSearchResults: "图谱结果",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
  }
}

/** Streams a single token then completes. */
function streamOnce(content: string) {
  mocks.streamChat.mockImplementation(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
    callbacks.onToken(content)
    callbacks.onDone()
  })
}

describe("outline-generation context prompt builders", () => {
  it("builds a generation prompt with the formatted context pack", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())

    const prompt = await buildOutlineGenerationPrompt("E:/Novel", "通用", "短篇", "测试")

    expect(prompt).toContain("请为以下小说生成大纲")
    expect(prompt).toContain("类型=通用 规模=短篇 核心设定=测试")
    expect(prompt).toContain("已有故事记忆与项目资料")
    expect(prompt).toContain("图谱关联")
  })

  it("still builds a generation prompt when context loading fails", async () => {
    mocks.buildContextPack.mockRejectedValueOnce(new Error("context failed"))

    const prompt = await buildOutlineGenerationPrompt("E:/Novel", "通用", "短篇", "测试")

    expect(prompt).toContain("测试")
    expect(prompt).toContain("请为以下小说生成大纲")
  })

  it("falls back to genre when premise is empty", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())

    await buildOutlineGenerationPrompt("E:/Novel", "悬疑", "中篇", "")

    expect(mocks.buildContextPack).toHaveBeenCalledWith("E:/Novel", "?????悬疑")
  })

  it("returns refinement context sections when the pack has content", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())

    const result = await buildOutlineRefinementContext("E:/Novel", "细化章节")

    expect(result.hasOutline).toBe(true)
    expect(result.context).toContain("## 已有大纲\n现有大纲")
    expect(result.context).toContain("## 最近剧情摘要\n摘要一\n摘要二")
    expect(result.context).toContain("## 角色认知\n角色认知")
    expect(result.context).toContain("## 图谱关联检索\n图谱结果")
  })

  it("returns an empty refinement context when context loading fails", async () => {
    mocks.buildContextPack.mockRejectedValueOnce(new Error("context failed"))

    const result = await buildOutlineRefinementContext("E:/Novel", "测试")

    expect(result).toEqual({
      context: "",
      hasOutline: false,
    })
  })
})

describe("hasOutlineForRefinement", () => {
  it("is true when the outlines tree contains markdown files", async () => {
    mocks.listDirectory.mockResolvedValue([
      { path: "E:/N/wiki/outlines/总大纲.md", name: "总大纲.md", is_dir: false },
      {
        path: "E:/N/wiki/outlines/sub",
        name: "sub",
        is_dir: true,
        children: [{ path: "E:/N/wiki/outlines/sub/卷一.md", name: "卷一.md", is_dir: false }],
      },
      { path: "E:/N/wiki/outlines/readme.txt", name: "readme.txt", is_dir: false },
    ])

    expect(await hasOutlineForRefinement("E:/N")).toBe(true)
  })

  it("is false when no markdown files exist", async () => {
    mocks.listDirectory.mockResolvedValue([
      { path: "E:/N/wiki/outlines/readme.txt", name: "readme.txt", is_dir: false },
    ])

    expect(await hasOutlineForRefinement("E:/N")).toBe(false)
  })

  it("is false when listing the outlines tree fails", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("no project"))

    expect(await hasOutlineForRefinement("E:/N")).toBe(false)
  })
})

describe("generateOutlineFile", () => {
  it("writes a Chinese story outline page and returns the raw content", async () => {
    mocks.streamChat.mockImplementation(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callbacks.onToken("第一章 序章")
      callbacks.onToken("\n\n正文")
      callbacks.onDone()
    })

    const result = await generateOutlineFile("E:/Novel", llmConfig, "生成总纲")

    expect(result.outlinePath).toBe("E:/Novel/wiki/outlines/总大纲.md")
    expect(result.content).toBe("第一章 序章\n\n正文")
    expect(mocks.createDirectory).toHaveBeenCalledWith("E:/Novel/wiki/outlines")
    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain("type: outline")
    expect(content).toContain('title: "总大纲"')
    expect(content).toContain("# 总大纲")
  })

  it("writes an English story outline when the output language is English", async () => {
    mocks.getOutputLanguage.mockReturnValue("English")
    streamOnce("body")

    const result = await generateOutlineFile("E:/Novel", llmConfig, "gen")

    expect(result.outlinePath).toBe("E:/Novel/wiki/outlines/story-outline.md")
    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain('title: "Story Outline"')
    expect(content).toContain("# Story Outline")
  })

  it("throws the stream error surfaced by onError", async () => {
    mocks.streamChat.mockImplementation(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callbacks.onError(new Error("upstream exploded"))
      callbacks.onDone()
    })

    await expect(generateOutlineFile("E:/Novel", llmConfig, "gen")).rejects.toThrow("upstream exploded")
  })
})

describe("generateOutlineRefinementSectionFile", () => {
  it("throws for an unknown section key", async () => {
    await expect(
      generateOutlineRefinementSectionFile("E:/N", llmConfig, "x", "bogus" as OutlineSectionGenerationKey),
    ).rejects.toThrow("未知的大纲生成类型")
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("throws refineMissingOutline when no outline exists", async () => {
    mocks.buildContextPack.mockResolvedValue({ ...fullPack(), outline: "" })

    await expect(
      generateOutlineRefinementSectionFile("E:/N", llmConfig, "x", "chapterOutlines"),
    ).rejects.toThrow("novel.outlineGenerator.refineMissingOutline")
  })

  it("streams a section, writes the Chinese outline page and returns its path", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())
    streamOnce("细纲正文")

    const path = await generateOutlineRefinementSectionFile("E:/N", llmConfig, "细化前两卷", "chapterOutlines")

    expect(path).toBe("E:/N/wiki/outlines/章节细纲.md")
    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain("type: outline")
    expect(content).toContain("# 章节细纲")
  })

  it("uses English titles and file names when the output language is English", async () => {
    mocks.getOutputLanguage.mockReturnValue("English")
    mocks.buildContextPack.mockResolvedValue(fullPack())
    streamOnce("body")

    const path = await generateOutlineRefinementSectionFile("E:/N", llmConfig, "x", "chapterOutlines")

    expect(path).toBe("E:/N/wiki/outlines/chapter-outlines.md")
    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain("# Chapter Outlines")
  })

  it("falls back to a default note and section hint when userRequest is blank", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())
    let prompt = ""
    mocks.streamChat.mockImplementation(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      prompt = String(messages[0]?.content ?? "")
      callbacks.onToken("内容")
      callbacks.onDone()
    })

    await generateOutlineRefinementSectionFile("E:/N", llmConfig, "   ", "chapterOutlines")

    expect(prompt).toContain("未额外指定")
    expect(prompt).toContain("本次只生成：章节细纲")
    expect(prompt).toContain("章节推进需要")
  })

  it("throws the stream error surfaced by onError", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())
    mocks.streamChat.mockImplementation(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callbacks.onError(new Error("stream fail"))
      callbacks.onDone()
    })

    await expect(
      generateOutlineRefinementSectionFile("E:/N", llmConfig, "x", "chapterOutlines"),
    ).rejects.toThrow("stream fail")
  })

  it("throws refineEmpty when the section content is empty", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())
    streamOnce("")

    await expect(
      generateOutlineRefinementSectionFile("E:/N", llmConfig, "x", "chapterOutlines"),
    ).rejects.toThrow("novel.outlineGenerator.refineEmpty")
  })

  it("appends into the existing outline file in appendCurrent mode", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())
    streamOnce("补充内容")
    mocks.readFile.mockResolvedValue("旧大纲")

    const path = await generateOutlineRefinementSectionFile(
      "E:/N",
      llmConfig,
      "补充",
      "chapterOutlines",
      { mode: "appendCurrent", targetPath: "E:/N/wiki/outlines/现有.md" },
    )

    expect(path).toBe("E:/N/wiki/outlines/现有.md")
    const [target, content] = mocks.writeFile.mock.calls[0] as [string, string]
    expect(target).toBe("E:/N/wiki/outlines/现有.md")
    expect(content).toContain("## 章节细纲")
    expect(content).toContain("补充内容")
  })

  it("appends with empty existing content when the target file is unreadable", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())
    streamOnce("补充内容")
    mocks.readFile.mockRejectedValue(new Error("gone"))

    await generateOutlineRefinementSectionFile(
      "E:/N",
      llmConfig,
      "补充",
      "chapterOutlines",
      { mode: "appendCurrent", targetPath: "E:/N/wiki/outlines/现有.md" },
    )

    const [, content] = mocks.writeFile.mock.calls[0] as [string, string]
    // empty existing content is filtered out, so the appended block starts fresh
    expect(content.startsWith("\n---\n")).toBe(true)
  })

  it("falls back to the default write when appendCurrent has no target path", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())
    streamOnce("内容")

    const path = await generateOutlineRefinementSectionFile(
      "E:/N",
      llmConfig,
      "x",
      "chapterOutlines",
      { mode: "appendCurrent", targetPath: null },
    )

    expect(path).toBe("E:/N/wiki/outlines/章节细纲.md")
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "E:/N/wiki/outlines/章节细纲.md",
      expect.stringContaining("# 章节细纲"),
    )
  })

  it("writes a new unique file and adds it to the source list in newFileAndAddToList mode", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())
    streamOnce("能力体系内容")
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockResolvedValue("能力体系内容")

    const path = await generateOutlineRefinementSectionFile(
      "E:/N",
      llmConfig,
      "x",
      "powerSystem",
      { mode: "newFileAndAddToList" },
    )

    expect(path).toBe("E:/N/wiki/outlines/金手指与能力体系.md")
    expect(mocks.getUniqueOutlinePath).toHaveBeenCalledWith("E:/N/wiki/outlines", "金手指与能力体系.md")
    expect(mocks.writeFile).toHaveBeenCalledWith("E:/N/raw/sources/金手指与能力体系.md", "能力体系内容")
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("E:/N")
  })
})

describe("generateOutlineRefinementFiles", () => {
  it("throws refineMissingOutline when no outline exists", async () => {
    mocks.buildContextPack.mockResolvedValue({ ...fullPack(), outline: "" })

    await expect(generateOutlineRefinementFiles("E:/N", llmConfig, "x")).rejects.toThrow(
      "novel.outlineGenerator.refineMissingOutline",
    )
  })

  it("throws when the signal is already aborted", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())
    const ac = new AbortController()
    ac.abort()

    await expect(generateOutlineRefinementFiles("E:/N", llmConfig, "x", {}, ac.signal)).rejects.toThrow(
      "细化生成已取消",
    )
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("generates all six sections and picks chapterOutlines as the primary path", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())
    streamOnce("各段内容")

    const result = await generateOutlineRefinementFiles("E:/N", llmConfig, "细化")

    expect(result.writtenPaths).toHaveLength(6)
    expect(result.primaryPath).toBe("E:/N/wiki/outlines/章节细纲.md")
    expect(result.sections.chapterOutlines).toBe("各段内容")
    expect(result.sections.locationsOutline).toBe("各段内容")
  })

  it("falls back to the first written section when chapterOutlines is empty", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())
    mocks.streamChat.mockImplementation(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = String(messages[0]?.content ?? "")
      callbacks.onToken(prompt.includes("本次只生成：章节细纲") ? "" : "内容")
      callbacks.onDone()
    })

    const result = await generateOutlineRefinementFiles("E:/N", llmConfig, "细化")

    expect(result.sections.chapterOutlines).toBe("")
    expect(result.writtenPaths).toHaveLength(5)
    expect(result.primaryPath).toBe("E:/N/wiki/outlines/人物小传.md")
  })

  it("throws refineEmpty when every section is empty", async () => {
    mocks.buildContextPack.mockResolvedValue(fullPack())
    streamOnce("")

    await expect(generateOutlineRefinementFiles("E:/N", llmConfig, "x")).rejects.toThrow(
      "novel.outlineGenerator.refineEmpty",
    )
  })
})

describe("runOutlineGenerationTask", () => {
  it("does nothing when the task is missing", async () => {
    await runOutlineGenerationTask("nope", llmConfig)
    expect(mocks.progress.startTask).not.toHaveBeenCalled()
  })

  it("generates, refreshes project state and marks the task done", async () => {
    mocks.outlineStore.tasks.push({ id: "t1", projectPath: "E:/N", prompt: "生成大纲", kind: "outline" })
    streamOnce("大纲")

    await runOutlineGenerationTask("t1", llmConfig)

    expect(mocks.progress.startTask).toHaveBeenCalledWith(expect.objectContaining({ kind: "outline_generation", total: 100 }))
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("E:/N")
    const task = mocks.outlineStore.tasks.find((t) => t.id === "t1")!
    expect(task.status).toBe("generated")
    expect(task.outlinePath).toBe("E:/N/wiki/outlines/总大纲.md")
    expect(mocks.progress.finishTask).toHaveBeenCalledWith("import-progress-1", "done", expect.objectContaining({ completed: 100 }))
  })

  it("marks the task error and finishes with error on failure", async () => {
    mocks.outlineStore.tasks.push({ id: "t1", projectPath: "E:/N", prompt: "生成大纲", kind: "outline" })
    mocks.streamChat.mockImplementation(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callbacks.onError("boom-string" as unknown as Error)
      callbacks.onDone()
    })

    await runOutlineGenerationTask("t1", llmConfig)

    const task = mocks.outlineStore.tasks.find((t) => t.id === "t1")!
    expect(task.status).toBe("error")
    expect(task.error).toBe("boom-string")
    expect(mocks.progress.finishTask).toHaveBeenCalledWith("import-progress-1", "error", expect.anything())
  })

  it("records Error-instance failures via err.message", async () => {
    mocks.outlineStore.tasks.push({ id: "t1", projectPath: "E:/N", prompt: "生成大纲", kind: "outline" })
    mocks.streamChat.mockImplementation(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callbacks.onError(new Error("boom"))
      callbacks.onDone()
    })

    await runOutlineGenerationTask("t1", llmConfig)

    const task = mocks.outlineStore.tasks.find((t) => t.id === "t1")!
    expect(task.status).toBe("error")
    expect(task.error).toBe("boom")
    expect(mocks.progress.finishTask).toHaveBeenCalledWith("import-progress-1", "error", expect.anything())
  })
})

describe("runOutlineRefinementTask", () => {
  it("does nothing when the task is missing", async () => {
    await runOutlineRefinementTask("nope", llmConfig)
    expect(mocks.progress.startTask).not.toHaveBeenCalled()
  })

  it("writes a single section when selectedSectionKey is set", async () => {
    mocks.outlineStore.tasks.push({
      id: "t1",
      projectPath: "E:/N",
      userRequest: "细化人物",
      selectedSectionKey: "characterBriefs",
      displayTitle: "人物小传",
      writeMode: null,
      targetPath: null,
    })
    mocks.buildContextPack.mockResolvedValue(fullPack())
    streamOnce("人物正文")

    await runOutlineRefinementTask("t1", llmConfig)

    const task = mocks.outlineStore.tasks.find((t) => t.id === "t1")!
    expect(task.status).toBe("generated")
    expect(task.outlinePath).toBe("E:/N/wiki/outlines/人物小传.md")
    expect(mocks.progress.finishTask).toHaveBeenCalledWith(
      "import-progress-1",
      "done",
      expect.objectContaining({ message: expect.stringContaining("人物小传") }),
    )
  })

  it("writes all sections and uses the primary path when no section key is set", async () => {
    mocks.outlineStore.tasks.push({
      id: "t1",
      projectPath: "E:/N",
      userRequest: "细化",
      selectedSectionKey: null,
      displayTitle: null,
      writeMode: null,
      targetPath: null,
    })
    mocks.buildContextPack.mockResolvedValue(fullPack())
    streamOnce("内容")

    await runOutlineRefinementTask("t1", llmConfig)

    const task = mocks.outlineStore.tasks.find((t) => t.id === "t1")!
    expect(task.status).toBe("generated")
    expect(task.outlinePath).toBe("E:/N/wiki/outlines/章节细纲.md")
    expect(mocks.progress.finishTask).toHaveBeenCalledWith(
      "import-progress-1",
      "done",
      expect.objectContaining({ message: "细化生成完成" }),
    )
  })

  it("marks the task error when generation fails", async () => {
    mocks.outlineStore.tasks.push({
      id: "t1",
      projectPath: "E:/N",
      userRequest: "细化",
      selectedSectionKey: null,
      displayTitle: null,
      writeMode: null,
      targetPath: null,
    })
    mocks.buildContextPack.mockResolvedValue(fullPack())
    mocks.streamChat.mockImplementation(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callbacks.onError(new Error("boom"))
      callbacks.onDone()
    })

    await runOutlineRefinementTask("t1", llmConfig)

    const task = mocks.outlineStore.tasks.find((t) => t.id === "t1")!
    expect(task.status).toBe("error")
    expect(task.error).toBe("boom")
    expect(mocks.progress.finishTask).toHaveBeenCalledWith("import-progress-1", "error", expect.anything())
  })

  it("stringifies non-Error failures in runOutlineRefinementTask", async () => {
    mocks.outlineStore.tasks.push({
      id: "t1",
      projectPath: "E:/N",
      userRequest: "细化",
      selectedSectionKey: null,
      displayTitle: null,
      writeMode: null,
      targetPath: null,
    })
    mocks.buildContextPack.mockResolvedValue(fullPack())
    mocks.streamChat.mockImplementation(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
      callbacks.onError("boom-string" as unknown as Error)
      callbacks.onDone()
    })

    await runOutlineRefinementTask("t1", llmConfig)

    const task = mocks.outlineStore.tasks.find((t) => t.id === "t1")!
    expect(task.status).toBe("error")
    expect(task.error).toBe("boom-string")
  })
})

describe("openGeneratedOutline", () => {
  it("does nothing when the task is missing", async () => {
    await openGeneratedOutline("nope")
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("does nothing when the task has no outline path", async () => {
    mocks.outlineStore.tasks.push({ id: "t1", outlinePath: null })
    await openGeneratedOutline("t1")
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("uses injected nav actions and marks the task opened", async () => {
    mocks.outlineStore.tasks.push({ id: "t1", outlinePath: "E:/N/wiki/outlines/总大纲.md" })
    mocks.readFile.mockResolvedValue("大纲内容")
    const navActions = {
      setActiveView: vi.fn(),
      setSelectedFile: vi.fn(),
      setFileContent: vi.fn(),
    } as Parameters<typeof openGeneratedOutline>[1]

    await openGeneratedOutline("t1", navActions)

    expect(mocks.readFile).toHaveBeenCalledWith("E:/N/wiki/outlines/总大纲.md")
    expect(navActions.setActiveView).toHaveBeenCalledWith("sources")
    expect(navActions.setSelectedFile).toHaveBeenCalledWith("E:/N/wiki/outlines/总大纲.md")
    expect(navActions.setFileContent).toHaveBeenCalledWith("大纲内容")
    const task = mocks.outlineStore.tasks.find((t) => t.id === "t1")!
    expect(task.status).toBe("generated")
  })

  it("falls back to the wiki store when no nav actions are injected", async () => {
    mocks.outlineStore.tasks.push({ id: "t1", outlinePath: "E:/N/wiki/outlines/总大纲.md" })
    mocks.readFile.mockResolvedValue("内容")

    await openGeneratedOutline("t1")

    expect(mocks.wiki.setActiveView).toHaveBeenCalledWith("sources")
    expect(mocks.wiki.setSelectedFile).toHaveBeenCalledWith("E:/N/wiki/outlines/总大纲.md")
    expect(mocks.wiki.setFileContent).toHaveBeenCalledWith("内容")
  })
})

describe("addOutlineFileToSourceList", () => {
  it("copies the outline into raw sources and refreshes project state", async () => {
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockResolvedValue("大纲内容")

    const target = await addOutlineFileToSourceList("E:/N", "E:/N/wiki/outlines/总大纲.md")

    expect(target).toBe("E:/N/raw/sources/总大纲.md")
    expect(mocks.createDirectory).toHaveBeenCalledWith("E:/N/raw/sources")
    expect(mocks.writeFile).toHaveBeenCalledWith("E:/N/raw/sources/总大纲.md", "大纲内容")
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("E:/N")
  })

  it("uses a numbered candidate when the first source path is taken", async () => {
    mocks.fileExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    mocks.readFile.mockResolvedValue("内容")

    const target = await addOutlineFileToSourceList("E:/N", "E:/N/wiki/outlines/总大纲.md")

    expect(target).toBe("E:/N/raw/sources/总大纲-2.md")
  })

  it("falls back to a Date.now suffix when all 99 candidates exist", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue("内容")

    const target = await addOutlineFileToSourceList("E:/N", "E:/N/wiki/outlines/总大纲.md")

    expect(target).toMatch(/^E:\/N\/raw\/sources\/总大纲-\d{13}\.md$/)
  })

  it("handles source names without an extension", async () => {
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockResolvedValue("内容")

    const target = await addOutlineFileToSourceList("E:/N", "E:/N/wiki/outlines/总大纲")

    expect(target).toBe("E:/N/raw/sources/总大纲")
  })

  it("handles collisions for source names without an extension", async () => {
    mocks.fileExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    mocks.readFile.mockResolvedValue("内容")

    const target = await addOutlineFileToSourceList("E:/N", "E:/N/wiki/outlines/总大纲")

    expect(target).toBe("E:/N/raw/sources/总大纲-2")
  })
})

describe("addOutlineTaskToSourceList", () => {
  it("returns null when the task is missing", async () => {
    expect(await addOutlineTaskToSourceList("nope")).toBeNull()
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("delegates to addOutlineFileToSourceList using the task outline path", async () => {
    mocks.outlineStore.tasks.push({ id: "t1", projectPath: "E:/N", outlinePath: "E:/N/wiki/outlines/总大纲.md" })
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockResolvedValue("内容")

    expect(await addOutlineTaskToSourceList("t1")).toBe("E:/N/raw/sources/总大纲.md")
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("E:/N")
  })
})

describe("outline ingest task helpers", () => {
  it("createOutlineIngestTask registers an ingesting task", () => {
    const id = createOutlineIngestTask("E:\\N", "E:/N/wiki/outlines/总大纲.md")

    expect(id).toMatch(/^outline-task-\d+$/)
    const task = mocks.outlineStore.tasks.find((t) => t.id === id)!
    expect(task).toMatchObject({
      projectPath: "E:/N",
      kind: "ingest",
      outlinePath: "E:/N/wiki/outlines/总大纲.md",
      status: "ingesting",
    })
  })

  it("startOutlineIngestTask kicks the ingest task and completes it", async () => {
    mocks.ingestOutline.mockResolvedValue({ id: "snap" })

    const id = startOutlineIngestTask("E:/N", "E:/N/wiki/outlines/总大纲.md")
    await new Promise((r) => setTimeout(r, 0))

    expect(mocks.outlineStore.tasks.find((t) => t.id === id)!.status).toBe("done")
    expect(mocks.progress.finishTask).toHaveBeenCalledWith("import-progress-1", "done", expect.anything())
  })

  it("runOutlineIngestTask does nothing when the task is missing", async () => {
    await runOutlineIngestTask("nope")
    expect(mocks.progress.startTask).not.toHaveBeenCalled()
  })

  it("runOutlineIngestTask does nothing when the task has no outline path", async () => {
    mocks.outlineStore.tasks.push({ id: "t1", projectPath: "E:/N", outlinePath: null })
    await runOutlineIngestTask("t1")
    expect(mocks.progress.startTask).not.toHaveBeenCalled()
  })

  it("runOutlineIngestTask marks done and refreshes when a snapshot is returned", async () => {
    mocks.outlineStore.tasks.push({ id: "t1", projectPath: "E:/N", outlinePath: "E:/N/wiki/outlines/卷二.md" })
    mocks.ingestOutline.mockResolvedValue({ id: "snap" })

    await runOutlineIngestTask("t1")

    const task = mocks.outlineStore.tasks.find((t) => t.id === "t1")!
    expect(task.status).toBe("done")
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("E:/N")
    expect(mocks.progress.startTask).toHaveBeenCalledWith(expect.objectContaining({ kind: "outline", currentTitle: "卷二" }))
  })

  it("runOutlineIngestTask marks error when no snapshot is returned", async () => {
    mocks.outlineStore.tasks.push({ id: "t1", projectPath: "E:/N", outlinePath: "E:/N/wiki/outlines/卷二.md" })
    mocks.ingestOutline.mockResolvedValue(null)

    await runOutlineIngestTask("t1")

    const task = mocks.outlineStore.tasks.find((t) => t.id === "t1")!
    expect(task.status).toBe("error")
    expect(mocks.progress.finishTask).toHaveBeenCalledWith("import-progress-1", "error", expect.anything())
  })

  it("runOutlineIngestTask falls back to the 大纲 title and records failures", async () => {
    mocks.outlineStore.tasks.push({ id: "t1", projectPath: "E:/N", outlinePath: "E:/N/wiki/outlines/" })
    mocks.ingestOutline.mockRejectedValue(new Error("boom"))

    await runOutlineIngestTask("t1")

    const task = mocks.outlineStore.tasks.find((t) => t.id === "t1")!
    expect(task.status).toBe("error")
    expect(task.error).toBe("boom")
    expect(mocks.progress.startTask).toHaveBeenCalledWith(expect.objectContaining({ currentTitle: "大纲" }))
  })

  it("stringifies non-Error ingest failures", async () => {
    mocks.outlineStore.tasks.push({ id: "t1", projectPath: "E:/N", outlinePath: "E:/N/wiki/outlines/卷二.md" })
    mocks.ingestOutline.mockRejectedValue("boom-string")

    await runOutlineIngestTask("t1")

    const task = mocks.outlineStore.tasks.find((t) => t.id === "t1")!
    expect(task.status).toBe("error")
    expect(task.error).toBe("boom-string")
  })
})

describe("runBulkOutlineIngest", () => {
  it("ingests every markdown outline recursively and reports counts", async () => {
    mocks.listDirectory.mockResolvedValue([
      { path: "E:/N/wiki/outlines/总大纲.md", name: "总大纲.md", is_dir: false },
      {
        path: "E:/N/wiki/outlines/sub",
        name: "sub",
        is_dir: true,
        children: [{ path: "E:/N/wiki/outlines/sub/卷二.md", name: "卷二.md", is_dir: false }],
      },
      { path: "E:/N/wiki/outlines/notes.txt", name: "notes.txt", is_dir: false },
    ])
    mocks.ingestOutline.mockResolvedValue({ id: "snap" })

    const result = await runBulkOutlineIngest("E:/N")

    expect(result).toEqual({ total: 2, succeeded: 2, failed: 0 })
  })

  it("counts failures when ingest returns no snapshot", async () => {
    mocks.listDirectory.mockResolvedValue([
      { path: "E:/N/wiki/outlines/总大纲.md", name: "总大纲.md", is_dir: false },
    ])
    mocks.ingestOutline.mockResolvedValue(null)

    const result = await runBulkOutlineIngest("E:/N")

    expect(result).toEqual({ total: 1, succeeded: 0, failed: 1 })
  })

  it("returns zeros when listing the outlines tree fails", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("no tree"))

    const result = await runBulkOutlineIngest("E:/N")

    expect(result).toEqual({ total: 0, succeeded: 0, failed: 0 })
  })
})
