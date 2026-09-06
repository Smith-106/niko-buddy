import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  advanceTranslationStatus,
  buildTranslationPrompt,
  checkGlossaryConsistency,
  createEmptyTranslationGlossary,
  createEmptyTranslationProgress,
  glossaryToPromptFragment,
  loadTranslationGlossary,
  resetTranslationStatus,
  runTranslationProject,
  runTranslationSegment,
  saveTranslationGlossary,
  translationProgressSummary,
  upsertGlossaryEntry,
  type TranslationLlmPort,
  type TranslationProject,
} from "./translation-workbench"
import { createBudgetRun } from "./budget-resume"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(async () => {}),
  writeFileAtomic: vi.fn(async (_p: string, _content: string) => {}),
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("ENOENT")
  }),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  writeFileAtomic: fsMocks.writeFileAtomic,
  readFile: fsMocks.readFile,
}))

describe("translation-workbench（吸收自 inkos translation 术语一致性模式）", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.readFile.mockImplementation(async () => {
      throw new Error("ENOENT")
    })
  })

  it("upsertGlossaryEntry 按 source 唯一键覆盖", () => {
    let g = createEmptyTranslationGlossary()
    g = upsertGlossaryEntry(g, {
      source: "林澈",
      target: "Lin Che",
      kind: "name",
    })
    g = upsertGlossaryEntry(g, {
      source: "林澈",
      target: "Lin-Che",
      kind: "name",
    })
    expect(g.entries).toHaveLength(1)
    expect(g.entries[0].target).toBe("Lin-Che")
  })

  it("glossaryToPromptFragment 空表返回空串，非空渲染 allowDirectUse 标注", () => {
    expect(glossaryToPromptFragment(createEmptyTranslationGlossary())).toBe("")
    let g = createEmptyTranslationGlossary()
    g = upsertGlossaryEntry(g, { source: "林澈", target: "Lin Che", kind: "name" })
    g = upsertGlossaryEntry(g, {
      source: "咒语名",
      target: "Spellname",
      kind: "term",
      allowDirectUse: true,
    })
    const frag = glossaryToPromptFragment(g)
    expect(frag).toContain("林澈 → Lin Che")
    expect(frag).toContain("咒语名 → Spellname（允许保留原文）")
  })

  it("checkGlossaryConsistency：漏译 warn + 允许直用 info", () => {
    let g = createEmptyTranslationGlossary()
    g = upsertGlossaryEntry(g, { source: "林澈", target: "Lin Che", kind: "name" })
    g = upsertGlossaryEntry(g, {
      source: "星辰剑",
      target: "Star Sword",
      kind: "item" as never,
    })
    g = upsertGlossaryEntry(g, {
      source: "九霄诀",
      target: "Nine Skies Art",
      kind: "term",
      allowDirectUse: true,
    })
    const violations = checkGlossaryConsistency(
      g,
      "Lin Che drew the 星辰剑 and recited 九霄诀.",
    )
    const starSword = violations.find((v) => v.source === "星辰剑")
    const nineSkies = violations.find((v) => v.source === "九霄诀")
    expect(starSword?.severity).toBe("warn")
    expect(starSword?.message).toContain("Star Sword")
    expect(nineSkies?.severity).toBe("info")
  })

  it("checkGlossaryConsistency：干净译文零 warn（info 也不产生当无术语出现）", () => {
    let g = createEmptyTranslationGlossary()
    g = upsertGlossaryEntry(g, { source: "林澈", target: "Lin Che", kind: "name" })
    expect(checkGlossaryConsistency(g, "Lin Che walked home.")).toEqual([])
  })

  it("状态机：单向前进合法，回退拒绝（返回 null）", () => {
    let p = createEmptyTranslationProgress()
    p = advanceTranslationStatus(p, 1, "drafted")!
    p = advanceTranslationStatus(p, 1, "reviewed")!
    p = advanceTranslationStatus(p, 1, "finalized")!
    expect(advanceTranslationStatus(p, 1, "drafted")).toBeNull()
    expect(advanceTranslationStatus(p, 1, "pending")).toBeNull()
    // 未登记章默认 pending，可直达 finalized（跳级合法）
    expect(advanceTranslationStatus(p, 2, "finalized")!.chapterStatuses[2]).toBe(
      "finalized",
    )
  })

  it("resetTranslationStatus 回到 pending；进度摘要统计正确", () => {
    let p = createEmptyTranslationProgress()
    p = advanceTranslationStatus(p, 1, "finalized")!
    p = advanceTranslationStatus(p, 2, "drafted")!
    p = advanceTranslationStatus(p, 3, "reviewed")!
    expect(translationProgressSummary(p)).toEqual({
      pending: 0,
      drafted: 1,
      reviewed: 1,
      finalized: 1,
    })
    p = resetTranslationStatus(p, 1)
    expect(translationProgressSummary(p)).toEqual({
      pending: 0,
      drafted: 1,
      reviewed: 1,
      finalized: 0,
    })
  })

  it("持久化往返：glossary save/load", async () => {
    let captured: string | null = null
    fsMocks.writeFileAtomic.mockImplementation(
      async (_p: string, content: string) => {
        captured = content
      },
    )
    const g = upsertGlossaryEntry(createEmptyTranslationGlossary(), {
      source: "林澈",
      target: "Lin Che",
      kind: "name",
    })
    await saveTranslationGlossary("/proj", g)
    expect(captured).not.toBeNull()
    fsMocks.readFile.mockImplementation(async () => captured as string)
    const loaded = await loadTranslationGlossary("/proj")
    expect(loaded.entries[0].source).toBe("林澈")
  })
})

describe("translation-runner (64 号实施：P0-4 LLM 翻译 runner)", () => {
  const glossary = createEmptyTranslationGlossary()
  const project = (overrides: Partial<TranslationProject> = {}): TranslationProject => ({
    version: 1,
    sourceLang: "中文",
    targetLang: "英文",
    chapterNumbers: [1, 2],
    glossary,
    progress: createEmptyTranslationProgress(),
    budgetRunId: "tr-1",
    ...overrides,
  })

  it("buildTranslationPrompt：含术语表与原文；系统指令限定语言", () => {
    const g = upsertGlossaryEntry(createEmptyTranslationGlossary(), {
      source: "青云山",
      target: "Azure Cloud Mountain",
      kind: "place",
    })
    const { system, user } = buildTranslationPrompt(g, "他登上青云山。", { source: "中文", target: "英文" })
    expect(system).toContain("中文")
    expect(system).toContain("英文")
    expect(user).toContain("青云山 → Azure Cloud Mountain")
    expect(user).toContain("他登上青云山。")
  })

  it("runTranslationSegment：fake port 一章 → drafted + 残留检测", async () => {
    const port: TranslationLlmPort = { translate: async () => "He climbed Azure Cloud Mountain." }
    const artifact = await runTranslationSegment(port, project(), {
      chapter: 1,
      sourceText: "他登上青云山。",
      digest: "d1",
    })
    expect(artifact.status).toBe("drafted")
    expect(artifact.targetText).toContain("Azure Cloud")
  })

  it("runTranslationProject：预算足够跑完 → done + 状态 drafted", async () => {
    const port: TranslationLlmPort = { translate: async () => "OK." }
    const p = project()
    const budget = createBudgetRun("b1", [
      { taskId: "translate-1", cost: 5 },
      { taskId: "translate-2", cost: 5 },
    ], 100)
    const result = await runTranslationProject(port, p, async () => "src", budget)
    expect(result.stopped).toBe("done")
    expect(result.artifacts).toHaveLength(2)
    expect(result.project.progress.chapterStatuses[1]).toBe("drafted")
  })

  it("runTranslationProject：预算不足 → suspended 保留已完成", async () => {
    const port: TranslationLlmPort = { translate: async () => "OK." }
    const p = project()
    const budget = createBudgetRun("b1", [
      { taskId: "translate-1", cost: 5 },
      { taskId: "translate-2", cost: 5 },
    ], 6)
    const result = await runTranslationProject(port, p, async () => "src", budget)
    expect(result.stopped).toBe("suspended")
    expect(result.artifacts).toHaveLength(1)
    expect(result.budget.completedTaskIds).toEqual(["translate-1"])
  })

  it("runTranslationProject：已完成段跳过（续跑幂等）", async () => {
    const port: TranslationLlmPort = { translate: async () => "OK." }
    const p = project()
    let budget = createBudgetRun("b1", [
      { taskId: "translate-1", cost: 5 },
      { taskId: "translate-2", cost: 5 },
    ], 100)
    budget = { ...budget, completedTaskIds: ["translate-1"], remainingBudget: 95 }
    const result = await runTranslationProject(port, p, async () => "src", budget)
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].chapter).toBe(2)
  })

  it("runTranslationProject：abort 信号 → aborted 保留已完成", async () => {
    const port: TranslationLlmPort = { translate: async () => "OK." }
    const controller = new AbortController()
    controller.abort()
    const p = project()
    const budget = createBudgetRun("b1", [{ taskId: "translate-1", cost: 5 }], 100)
    const result = await runTranslationProject(port, p, async () => "src", budget, controller.signal)
    expect(result.stopped).toBe("aborted")
    expect(result.artifacts).toHaveLength(0)
  })
})
