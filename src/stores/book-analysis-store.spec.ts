import { beforeEach, describe, expect, it, vi } from "vitest"
import { useBookAnalysisStore } from "./book-analysis-store"
import type { RecognizedCharacter, ExtractedCharacter, CharacterSkill, BookStyleProfile, BookAnalysisResult } from "@/lib/novel/book-analysis/types"

describe("book analysis store", () => {
  beforeEach(() => {
    useBookAnalysisStore.setState({
      tasks: [],
      currentTaskId: null,
      selectedResultPath: null,
      currentResult: null,
      showResultViewer: false,
      // 角色识别状态也重置（feature/character-recognition-and-simple-mode）
      recognitionStatus: "idle",
      recognizedCharacters: [],
      selectedCharacterIds: [],
    })
  })

  it("updates book id and chapters without mutating a task object outside zustand", () => {
    const taskId = useBookAnalysisStore.getState().startTask("E:/Novel", {
      sourceType: "file",
      sourcePath: "E:/Books/long.txt",
      selectedChapters: [],
    })

    useBookAnalysisStore.getState().updateTaskBookData(taskId, "book-123", [
      {
        id: "ch-0001",
        title: "第一章 风起",
        order: 1,
        wordCount: 3200,
        path: "E:/Novel/book-analysis/book-123/chapters/ch-0001.md",
      },
    ])

    const task = useBookAnalysisStore.getState().getTask(taskId)
    expect(task?.bookId).toBe("book-123")
    expect(task?.chapters).toHaveLength(1)
    expect(task?.chapters?.[0].title).toBe("第一章 风起")
  })
})

describe("book analysis store 任务生命周期", () => {
  const baseConfig = { sourceType: "file" as const, sourcePath: "E:/Books/long.txt", selectedChapters: [] }

  beforeEach(() => {
    useBookAnalysisStore.setState({
      tasks: [],
      currentTaskId: null,
      selectedResultPath: null,
      currentResult: null,
      showResultViewer: false,
      selectedLibraryBookId: null,
      sidebarRefreshCounter: 0,
      recognitionStatus: "idle",
      recognizedCharacters: [],
      selectedCharacterIds: [],
      recognitionError: undefined,
      pendingRecognitionTaskId: null,
    })
  })

  it("startTask 归一化路径、生成唯一 id、设置 running 状态并置顶", () => {
    const id1 = useBookAnalysisStore.getState().startTask("E:\\Novel\\子目录", baseConfig)
    const id2 = useBookAnalysisStore.getState().startTask("E:/Novel/子目录", baseConfig)
    const tasks = useBookAnalysisStore.getState().tasks
    expect(tasks).toHaveLength(2)
    expect(tasks[0]!.id).toBe(id2) // 最新在前
    expect(id1).toMatch(/^book-analysis-\d+-\d+$/)
    expect(id1).not.toBe(id2)
    // 反斜杠被归一化
    expect(tasks[1]!.projectPath).toBe("E:/Novel/子目录")
    expect(tasks[0]!.status).toBe("running")
    expect(tasks[0]!.progress.stage).toBe("reading_file")
    expect(tasks[0]!.progress.percentage).toBe(0)
    expect(tasks[0]!.bookId).toMatch(/^book-\d+$/)
    expect(tasks[0]!.chapters).toEqual([])
    expect(tasks[0]!.skills).toEqual([])
    expect(useBookAnalysisStore.getState().currentTaskId).toBe(id2)
  })

  it("startTask 可携带 abortController", () => {
    const controller = new AbortController()
    const id = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig, controller)
    expect(useBookAnalysisStore.getState().getTask(id)?.abortController).toBe(controller)
  })

  it("updateTaskBookData 带 bookPath 时写入 bookPath", () => {
    const id = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig)
    useBookAnalysisStore.getState().updateTaskBookData(id, "book-9", [], "E:/Novel/book-analysis/book-9")
    const task = useBookAnalysisStore.getState().getTask(id)!
    expect(task.bookPath).toBe("E:/Novel/book-analysis/book-9")
    expect(task.bookId).toBe("book-9")
    expect(task.chapters).toEqual([])
  })

  it("updateTaskProgress 合并 progress 补丁并刷新 updatedAt", async () => {
    const id = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig)
    const before = useBookAnalysisStore.getState().getTask(id)!.updatedAt
    await new Promise((r) => setTimeout(r, 2))
    useBookAnalysisStore.getState().updateTaskProgress(id, { stage: "extracting_characters", completed: 30, total: 100 })
    const task = useBookAnalysisStore.getState().getTask(id)!
    expect(task.progress.stage).toBe("extracting_characters")
    expect(task.progress.completed).toBe(30)
    expect(task.progress.percentage).toBe(0) // 未提供的字段保留
    expect(task.updatedAt).toBeGreaterThanOrEqual(before)
  })

  it("updateTaskMetadata / updateTaskCharacters / updateTaskSkills / updateTaskStyleProfile 写入对应字段", () => {
    const id = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig)
    const metadata = { title: "长夜书", totalChapters: 10, totalWords: 32000, sourceType: "file" as const, createdAt: 1, updatedAt: 2 }
    const chars: ExtractedCharacter[] = [{ id: "c1", name: "许七安", aliases: [], importance: 90, category: "protagonist", firstAppearance: 0, lastAppearance: 9, appearanceCount: 10, description: "d", personality: "p", speechStyle: "s", relationships: [], keyEvents: [] }]
    const skills: CharacterSkill[] = [{ id: "sk1", characterId: "c1", characterName: "许七安", skillContent: "推理", sourceBook: "长夜书", chapterRange: ["1"], createdAt: 1 }]
    const styleProfile: BookStyleProfile = { schemaVersion: 1, generatedAt: 1, sampledChapterIds: [], narrativeDensity: "高", descriptionWeight: "中", emotionRendering: "低", sentenceStyle: "短句", rhetoricDensity: "低", transitionStyle: "快", narrativeVoice: "第三人称", dialogueStyle: "简洁", thematicHabits: "成长" }

    useBookAnalysisStore.getState().updateTaskMetadata(id, metadata)
    useBookAnalysisStore.getState().updateTaskCharacters(id, chars)
    useBookAnalysisStore.getState().updateTaskSkills(id, skills)
    useBookAnalysisStore.getState().updateTaskStyleProfile(id, styleProfile)

    const task = useBookAnalysisStore.getState().getTask(id)!
    expect(task.metadata?.title).toBe("长夜书")
    expect(task.characters).toHaveLength(1)
    expect(task.skills?.[0]!.skillContent).toBe("推理")
    expect(task.styleProfile?.narrativeDensity).toBe("高")
  })

  it("patchTask 未命中时保持原任务（多任务场景的 else 分支）", () => {
    const id1 = useBookAnalysisStore.getState().startTask("E:/A", baseConfig)
    const id2 = useBookAnalysisStore.getState().startTask("E:/B", baseConfig)
    useBookAnalysisStore.getState().updateTaskMetadata(id1, { title: "T", totalChapters: 1, totalWords: 1, sourceType: "file", createdAt: 1, updatedAt: 1 })
    const t2 = useBookAnalysisStore.getState().getTask(id2)!
    expect(t2.metadata).toBeUndefined() // 未命中不写入
    const t1 = useBookAnalysisStore.getState().getTask(id1)!
    expect(t1.metadata?.title).toBe("T")
  })

  it("pauseTask / resumeTask 切换状态并设置 currentTaskId", () => {
    const id = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig)
    useBookAnalysisStore.getState().pauseTask(id)
    expect(useBookAnalysisStore.getState().getTask(id)!.status).toBe("paused")
    useBookAnalysisStore.getState().resumeTask(id)
    expect(useBookAnalysisStore.getState().getTask(id)!.status).toBe("running")
    expect(useBookAnalysisStore.getState().currentTaskId).toBe(id)
  })

  it("cancelTask 中止 abortController、标记 error 并清空 currentTaskId", () => {
    const controller = new AbortController()
    const abortSpy = vi.spyOn(controller, "abort")
    const id = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig, controller)
    useBookAnalysisStore.getState().cancelTask(id)
    expect(abortSpy).toHaveBeenCalledTimes(1)
    const task = useBookAnalysisStore.getState().getTask(id)!
    expect(task.status).toBe("error")
    expect(task.error).toBe("用户取消分析")
    expect(useBookAnalysisStore.getState().currentTaskId).toBeNull()
  })

  it("cancelTask 无 abortController 的任务不抛错", () => {
    const id = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig)
    expect(() => useBookAnalysisStore.getState().cancelTask(id)).not.toThrow()
    expect(useBookAnalysisStore.getState().getTask(id)!.status).toBe("error")
  })

  it("cancelTask 存在其他任务时仅标记目标任务（map else 分支）", () => {
    const other = useBookAnalysisStore.getState().startTask("E:/Other", baseConfig)
    const target = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig)
    useBookAnalysisStore.getState().cancelTask(target)
    const tasks = useBookAnalysisStore.getState().tasks
    expect(tasks.find((t) => t.id === target)!.status).toBe("error")
    expect(tasks.find((t) => t.id === other)!.status).toBe("running")
  })

  it("completeTask 标记完成、progress 100%、写入 completedAt 并清空 currentTaskId", () => {
    const id = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig)
    useBookAnalysisStore.getState().completeTask(id)
    const task = useBookAnalysisStore.getState().getTask(id)!
    expect(task.status).toBe("completed")
    expect(task.progress.stage).toBe("completed")
    expect(task.progress.percentage).toBe(100)
    expect(task.completedAt).toBeGreaterThan(0)
    expect(useBookAnalysisStore.getState().currentTaskId).toBeNull()
  })

  it("completeTask 存在其他任务时仅更新目标任务（map else 分支）", () => {
    const other = useBookAnalysisStore.getState().startTask("E:/Other", baseConfig)
    const target = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig)
    useBookAnalysisStore.getState().completeTask(target)
    const tasks = useBookAnalysisStore.getState().tasks
    expect(tasks.find((t) => t.id === target)!.status).toBe("completed")
    expect(tasks.find((t) => t.id === other)!.status).toBe("running")
  })

  it("errorTask 标记 error + progress stage=error 并清空 currentTaskId", () => {
    const id = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig)
    useBookAnalysisStore.getState().errorTask(id, "读取失败")
    const task = useBookAnalysisStore.getState().getTask(id)!
    expect(task.status).toBe("error")
    expect(task.error).toBe("读取失败")
    expect(task.progress.stage).toBe("error")
    expect(useBookAnalysisStore.getState().currentTaskId).toBeNull()
  })

  it("errorTask 存在其他任务时仅标记目标任务（map else 分支）", () => {
    const other = useBookAnalysisStore.getState().startTask("E:/Other", baseConfig)
    const target = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig)
    useBookAnalysisStore.getState().errorTask(target, "boom")
    const tasks = useBookAnalysisStore.getState().tasks
    expect(tasks.find((t) => t.id === target)!.status).toBe("error")
    expect(tasks.find((t) => t.id === other)!.status).toBe("running")
  })

  it("removeTask 移除任务并清空 currentTaskId（当移除的是当前任务）", () => {
    const id1 = useBookAnalysisStore.getState().startTask("E:/A", baseConfig)
    const id2 = useBookAnalysisStore.getState().startTask("E:/B", baseConfig)
    useBookAnalysisStore.getState().removeTask(id2) // 移除 current
    const s = useBookAnalysisStore.getState()
    expect(s.tasks).toHaveLength(1)
    expect(s.tasks[0]!.id).toBe(id1)
    expect(s.currentTaskId).toBeNull()
  })

  it("removeTask 移除非当前任务时 currentTaskId 不变", () => {
    const id1 = useBookAnalysisStore.getState().startTask("E:/A", baseConfig)
    useBookAnalysisStore.getState().startTask("E:/B", baseConfig) // current = id2
    useBookAnalysisStore.getState().removeTask(id1)
    const s = useBookAnalysisStore.getState()
    expect(s.currentTaskId).not.toBe(id1)
    expect(s.tasks).toHaveLength(1)
  })

  it("setSelectedResult 归一化路径 / null 清空", () => {
    useBookAnalysisStore.getState().setSelectedResult("E:\\Result\\out.json")
    expect(useBookAnalysisStore.getState().selectedResultPath).toBe("E:/Result/out.json")
    useBookAnalysisStore.getState().setSelectedResult(null)
    expect(useBookAnalysisStore.getState().selectedResultPath).toBeNull()
  })

  it("setCurrentResult / setShowResultViewer", () => {
    const result: BookAnalysisResult = { metadata: { title: "T", totalChapters: 1, totalWords: 1, sourceType: "file", createdAt: 1, updatedAt: 1 }, characters: [], skills: [] }
    useBookAnalysisStore.getState().setCurrentResult(result)
    expect(useBookAnalysisStore.getState().currentResult?.metadata.title).toBe("T")
    useBookAnalysisStore.getState().setCurrentResult(null)
    expect(useBookAnalysisStore.getState().currentResult).toBeNull()
    useBookAnalysisStore.getState().setShowResultViewer(true)
    expect(useBookAnalysisStore.getState().showResultViewer).toBe(true)
  })

  it("setSelectedLibraryBookId / triggerSidebarRefresh 自增", () => {
    useBookAnalysisStore.getState().setSelectedLibraryBookId("book-1")
    expect(useBookAnalysisStore.getState().selectedLibraryBookId).toBe("book-1")
    useBookAnalysisStore.getState().triggerSidebarRefresh()
    useBookAnalysisStore.getState().triggerSidebarRefresh()
    expect(useBookAnalysisStore.getState().sidebarRefreshCounter).toBe(2)
  })

  it("requestReopenChapterSelection / consumeReopenRequest 一次性消费", () => {
    expect(useBookAnalysisStore.getState().consumeReopenRequest()).toBeNull()
    useBookAnalysisStore.getState().requestReopenChapterSelection("task-x")
    expect(useBookAnalysisStore.getState().pendingRecognitionTaskId).toBe("task-x")
    expect(useBookAnalysisStore.getState().consumeReopenRequest()).toBe("task-x")
    // 消费后清空
    expect(useBookAnalysisStore.getState().pendingRecognitionTaskId).toBeNull()
    expect(useBookAnalysisStore.getState().consumeReopenRequest()).toBeNull()
  })

  it("getTaskByProject 按 updatedAt 降序返回同项目最新任务，无匹配返回 null", async () => {
    const oldTask = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig)
    const newTask = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig)
    await new Promise((r) => setTimeout(r, 2))
    useBookAnalysisStore.getState().updateTaskMetadata(oldTask, { title: "older", totalChapters: 1, totalWords: 1, sourceType: "file", createdAt: 1, updatedAt: 1 })
    useBookAnalysisStore.getState().updateTaskProgress(newTask, { completed: 1 })
    const latest = useBookAnalysisStore.getState().getTaskByProject("E:/Novel")
    expect(latest?.id).toBe(newTask)
    // 路径归一化一致
    useBookAnalysisStore.getState().startTask("E:/Other", baseConfig)
    expect(useBookAnalysisStore.getState().getTaskByProject("E:/NotExist")).toBeNull()
    expect(useBookAnalysisStore.getState().getTaskByProject("E:\\Novel")).not.toBeNull()
  })

  it("getTask 未命中返回 null；getCurrentTask 覆盖有/无 currentTaskId", () => {
    const id = useBookAnalysisStore.getState().startTask("E:/Novel", baseConfig)
    expect(useBookAnalysisStore.getState().getTask("missing")).toBeNull()
    expect(useBookAnalysisStore.getState().getCurrentTask()?.id).toBe(id)
    // currentTaskId 指向已删除任务 → find 未命中 ?? null
    useBookAnalysisStore.getState().removeTask(id)
    expect(useBookAnalysisStore.getState().getCurrentTask()).toBeNull()
    // 无 currentTaskId → 三元 false 分支
    expect(useBookAnalysisStore.getState().getCurrentTask()).toBeNull()
  })

  it("getCurrentTask 在 currentTaskId 指向不存在任务时返回 null（?? 分支）", () => {
    useBookAnalysisStore.setState({ currentTaskId: "ghost" })
    expect(useBookAnalysisStore.getState().getCurrentTask()).toBeNull()
  })

  it("setRecognitionError 写入 / clearRecognition 重置识别状态含 error", () => {
    useBookAnalysisStore.getState().setRecognitionStatus("llm_recognizing")
    useBookAnalysisStore.getState().setRecognitionError("LLM 超时")
    expect(useBookAnalysisStore.getState().recognitionError).toBe("LLM 超时")
    useBookAnalysisStore.getState().clearRecognition()
    const s = useBookAnalysisStore.getState()
    expect(s.recognitionStatus).toBe("idle")
    expect(s.recognizedCharacters).toEqual([])
    expect(s.selectedCharacterIds).toEqual([])
    expect(s.recognitionError).toBeUndefined()
  })

  it("setRecognitionStatus 覆盖 done 值", () => {
    useBookAnalysisStore.getState().setRecognitionStatus("done")
    expect(useBookAnalysisStore.getState().recognitionStatus).toBe("done")
  })
})

describe("book analysis store 角色识别 actions (feature/character-recognition-and-simple-mode)", () => {
  const sampleCharacters: RecognizedCharacter[] = [
    { id: "1", name: "许七安", aliases: [], appearances: 3, chapterIndices: [0, 1, 2], importanceScore: 95, category: "主角", sourceBook: "长夜书" },
    { id: "2", name: "临安公主", aliases: [], appearances: 2, chapterIndices: [0, 1], importanceScore: 60, category: "配角", sourceBook: "长夜书" },
  ]

  beforeEach(() => {
    useBookAnalysisStore.setState({
      recognitionStatus: "idle",
      recognizedCharacters: [],
      selectedCharacterIds: [],
    })
  })

  it("setRecognitionStatus 改 status", () => {
    const { setRecognitionStatus } = useBookAnalysisStore.getState()
    setRecognitionStatus("heuristic")
    expect(useBookAnalysisStore.getState().recognitionStatus).toBe("heuristic")
    setRecognitionStatus("llm_scoring")
    expect(useBookAnalysisStore.getState().recognitionStatus).toBe("llm_scoring")
    setRecognitionStatus("error")
    expect(useBookAnalysisStore.getState().recognitionStatus).toBe("error")
  })

  it("setRecognizedCharacters 同时改 status 为 done + 写入列表", () => {
    const { setRecognizedCharacters, setRecognitionStatus } = useBookAnalysisStore.getState()
    setRecognitionStatus("llm_scoring")  // 先改成 llm_scoring
    expect(useBookAnalysisStore.getState().recognitionStatus).toBe("llm_scoring")
    setRecognizedCharacters(sampleCharacters)
    expect(useBookAnalysisStore.getState().recognizedCharacters).toEqual(sampleCharacters)
    // 关键：写入时自动切到 done
    expect(useBookAnalysisStore.getState().recognitionStatus).toBe("done")
  })

  it("setSelectedCharacterIds 改 ids", () => {
    const { setSelectedCharacterIds } = useBookAnalysisStore.getState()
    setSelectedCharacterIds(["1", "2"])
    expect(useBookAnalysisStore.getState().selectedCharacterIds).toEqual(["1", "2"])
    setSelectedCharacterIds([])
    expect(useBookAnalysisStore.getState().selectedCharacterIds).toEqual([])
  })

  it("clearRecognition 重置所有识别状态", () => {
    const { setRecognitionStatus, setRecognizedCharacters, setSelectedCharacterIds, clearRecognition } = useBookAnalysisStore.getState()
    setRecognitionStatus("done")
    setRecognizedCharacters(sampleCharacters)
    setSelectedCharacterIds(["1"])
    expect(useBookAnalysisStore.getState().recognitionStatus).toBe("done")
    expect(useBookAnalysisStore.getState().recognizedCharacters).toHaveLength(2)
    expect(useBookAnalysisStore.getState().selectedCharacterIds).toHaveLength(1)

    clearRecognition()
    expect(useBookAnalysisStore.getState().recognitionStatus).toBe("idle")
    expect(useBookAnalysisStore.getState().recognizedCharacters).toEqual([])
    expect(useBookAnalysisStore.getState().selectedCharacterIds).toEqual([])
  })
})
