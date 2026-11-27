// @vitest-environment node
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { ProjectionStatusLedger } from "./projection-status-ledger"
import {
  MAIN_CONTROL_MCP_TOOL_NAMES,
  MAX_MAIN_CONTROL_MCP_OUTPUT_CHARS,
  createMainControlMcpTools,
  formatMainControlMcpOutput,
} from "./main-control-mcp-tools"

const PROJECT = "/proj/demo"

function toolByName(tools: ReturnType<typeof createMainControlMcpTools>, name: string) {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`missing tool: ${name}`)
  return tool
}

describe("main-control-mcp-tools（8 个零 LLM 只读 MCP 本地门面）", () => {
  it("导出固定 8 个只读工具且全部声明 category=read / permission=auto", () => {
    expect(MAIN_CONTROL_MCP_TOOL_NAMES).toEqual([
      "gate_check_mechanical",
      "audit_longform_health",
      "canon_query",
      "foreshadowing_list",
      "character_read",
      "workflow_next",
      "skills_list",
      "skills_get",
    ])

    const tools = createMainControlMcpTools(PROJECT)
    expect(tools.map((t) => t.name)).toEqual([...MAIN_CONTROL_MCP_TOOL_NAMES])
    for (const tool of tools) {
      expect(tool.category).toBe("read")
      expect(tool.permission).toBe("auto")
    }
  })

  it("WARN-01 防环守卫：顶层零静态值导入 @/lib/mcp/*（仅 import type + 动态 await import）", () => {
    const source = readFileSync(
      resolve(__dirname, "main-control-mcp-tools.ts"),
      "utf8",
    )
    // 禁止任何顶层非 type-only 的 `@/lib/mcp/...` 静态 import
    const staticMcpValueImport = /^import\s+(?!type\b)[^;\n]*from\s+["']@\/lib\/mcp\//m
    expect(source).not.toMatch(staticMcpValueImport)
    // 确认使用懒加载动态 import
    expect(source).toContain('await import("@/lib/mcp/mechanical-gate")')
    expect(source).toContain('await import("@/lib/mcp/phase3-read-tools")')
    expect(source).toContain('await import("@/lib/mcp/atomic-read-tools")')
    expect(source).toContain('await import("@/lib/mcp/workflow-draft-tools")')
    expect(source).toContain('await import("@/lib/mcp/skills-read-tools")')
  })

  it("gate_check_mechanical：默认 compact 模式调用门控并在缺 text 时返回中文错误", async () => {
    const runMechanicalGateForMcp = vi.fn(async () => ({
      verdict: "mechanical_passed_pending_semantic",
      summary: { p0Errors: 0, p1Errors: 0 },
    }) as any)
    const tools = createMainControlMcpTools(PROJECT, { runMechanicalGateForMcp })
    const tool = toolByName(tools, "gate_check_mechanical")

    expect(await tool.execute({ text: "   " })).toContain("需要非空的 text 参数")
    expect(runMechanicalGateForMcp).not.toHaveBeenCalled()

    const out = await tool.execute({
      text: "第一章正文内容",
      chapterNumber: 3,
      genre: "悬疑",
      targetChars: 3000,
    })
    expect(runMechanicalGateForMcp).toHaveBeenCalledWith({
      projectPath: PROJECT,
      text: "第一章正文内容",
      detailLevel: "compact",
      chapterNumber: 3,
      genre: "悬疑",
      targetChars: 3000,
    })
    expect(JSON.parse(out)).toMatchObject({ verdict: "mechanical_passed_pending_semantic" })
  })

  it("audit_longform_health / foreshadowing_list / character_read / workflow_next 严格白名单透传参数", async () => {
    const runAuditLongformHealth = vi.fn(async () => ({ overallStatus: "healthy" }) as any)
    const runForeshadowingList = vi.fn(async () => ({ total: 2, items: [] }) as any)
    const runCharacterRead = vi.fn(async () => ({ total: 1, characters: [] }) as any)
    const runWorkflowNext = vi.fn(async () => ({ action: "draft_chapter" }) as any)

    const tools = createMainControlMcpTools(PROJECT, {
      runAuditLongformHealth,
      runForeshadowingList,
      runCharacterRead,
      runWorkflowNext,
    })

    const auditOut = await toolByName(tools, "audit_longform_health").execute({
      currentChapter: 12,
      sections: ["foreshadowing", "emotion"],
      topK: 5,
      unknownExtraKey: "drop-me",
    })
    expect(runAuditLongformHealth).toHaveBeenCalledWith(PROJECT, {
      currentChapter: 12,
      sections: ["foreshadowing", "emotion"],
      topK: 5,
    })
    expect(JSON.parse(auditOut)).toEqual({ overallStatus: "healthy" })

    const fsOut = await toolByName(tools, "foreshadowing_list").execute({
      status: "overdue",
      character: "苏砚",
      rogueField: 123,
    })
    expect(runForeshadowingList).toHaveBeenCalledWith(PROJECT, {
      status: "overdue",
      character: "苏砚",
    })
    expect(JSON.parse(fsOut)).toEqual({ total: 2, items: [] })

    const charOut = await toolByName(tools, "character_read").execute({
      name: "苏砚",
      includeAura: true,
      rogueField: true,
    })
    expect(runCharacterRead).toHaveBeenCalledWith(PROJECT, {
      name: "苏砚",
      includeAura: true,
    })
    expect(JSON.parse(charOut)).toEqual({ total: 1, characters: [] })

    const wfOut = await toolByName(tools, "workflow_next").execute({
      targetChapter: 4,
      draftId: "draft_4",
      extra: "ignored",
    })
    expect(runWorkflowNext).toHaveBeenCalledWith(PROJECT, {
      targetChapter: 4,
      draftId: "draft_4",
    })
    expect(JSON.parse(wfOut)).toEqual({ action: "draft_chapter" })
  })

  it("REV1-005：pickDefinedParams 过滤显式 null 可选参数，防止 LLM 传 null 触发下游校验异常", async () => {
    const runAuditLongformHealth = vi.fn(async () => ({ overallStatus: "healthy" }) as any)
    const runForeshadowingList = vi.fn(async () => ({ total: 0, items: [] }) as any)
    const runCharacterRead = vi.fn(async () => ({ total: 0, characters: [] }) as any)
    const runWorkflowNext = vi.fn(async () => ({ action: "review" }) as any)

    const tools = createMainControlMcpTools(PROJECT, {
      runAuditLongformHealth,
      runForeshadowingList,
      runCharacterRead,
      runWorkflowNext,
    })

    await toolByName(tools, "audit_longform_health").execute({
      currentChapter: null,
      sections: null,
      topK: 5,
      includeDetails: undefined,
    })
    expect(runAuditLongformHealth).toHaveBeenCalledWith(PROJECT, { topK: 5 })

    await toolByName(tools, "foreshadowing_list").execute({
      status: null,
      character: "苏砚",
      debtLevel: null,
    })
    expect(runForeshadowingList).toHaveBeenCalledWith(PROJECT, { character: "苏砚" })

    await toolByName(tools, "character_read").execute({
      name: null,
      query: null,
      includeAura: true,
    })
    expect(runCharacterRead).toHaveBeenCalledWith(PROJECT, { includeAura: true })

    await toolByName(tools, "workflow_next").execute({
      targetChapter: null,
      draftId: null,
    })
    expect(runWorkflowNext).toHaveBeenCalledWith(PROJECT, {})
  })

  it("canon_query：Canon 图命中时直接返回 canon_graph 结果", async () => {
    const queryCanonEdges = vi.fn(async () => [
      {
        id: "edge-1",
        sourceId: "苏砚",
        targetId: "古玉",
        predicate: "持有",
        edgeKind: "world_fact" as const,
        validAt: 1,
        invalidAt: null,
        archived: false,
      },
    ])
    const loadAllSnapshots = vi.fn(async () => [])
    const tools = createMainControlMcpTools(PROJECT, { queryCanonEdges, loadAllSnapshots })

    const out = await toolByName(tools, "canon_query").execute({
      subject: "苏砚",
      validAtChapter: 3,
      predicate: "持有",
    })
    const parsed = JSON.parse(out)
    expect(parsed.source).toBe("canon_graph")
    expect(parsed.facts).toHaveLength(1)
    expect(parsed.facts[0]).toMatchObject({ sourceId: "苏砚", predicate: "持有", targetId: "古玉" })
    expect(loadAllSnapshots).not.toHaveBeenCalled()
  })

  it("canon_query：Canon 图为空或异常时确定性回退 committed snapshots（factsFromCommittedSnapshots + queryFactsAt）", async () => {
    const queryCanonEdges = vi.fn(async () => {
      throw new Error("Tauri IPC unavailable")
    })
    const snapshots: ChapterSnapshot[] = [
      {
        chapterNumber: 1,
        summary: "第1章",
        charactersPresent: ["苏砚"],
        newCanonFacts: ["苏砚：持有觉醒芯片", "陆沉舟：位于白塔"],
        foreshadowingUpdates: [],
        characterStateDeltas: [],
        timestamp: "2026-01-01T00:00:00Z",
      } as unknown as ChapterSnapshot,
      {
        chapterNumber: 4,
        summary: "第4章",
        charactersPresent: ["苏砚"],
        newCanonFacts: ["苏砚：位于沉降区"],
        foreshadowingUpdates: [],
        characterStateDeltas: [],
        timestamp: "2026-01-02T00:00:00Z",
      } as unknown as ChapterSnapshot,
      {
        chapterNumber: 2,
        summary: "失败快照",
        charactersPresent: ["苏砚"],
        newCanonFacts: ["苏砚：持有伪造物品"],
        foreshadowingUpdates: [],
        characterStateDeltas: [],
        timestamp: "2026-01-01T12:00:00Z",
      } as unknown as ChapterSnapshot,
    ]
    const ledger = {
      chapters: {
        "1": { snapshot: { status: "committed" } },
        "2": { snapshot: { status: "failed" } },
        "4": { snapshot: { status: "committed" } },
      },
    } as unknown as ProjectionStatusLedger

    const tools = createMainControlMcpTools(PROJECT, {
      queryCanonEdges,
      loadAllSnapshots: async () => snapshots,
      loadProjectionStatusLedger: async () => ledger,
    })

    const out = await toolByName(tools, "canon_query").execute({
      subject: "苏砚",
      validAtChapter: 3,
      edgeKinds: ["world_fact"],
    })
    const parsed = JSON.parse(out)
    expect(parsed.source).toBe("committed_snapshots_fallback")
    expect(parsed.canonGraphError).toContain("Tauri IPC unavailable")
    expect(parsed.notes).toEqual(expect.arrayContaining([expect.stringContaining("edgeKinds")]))
    // validAtChapter=3 过滤掉第 4 章未来事实，且 ledger 过滤掉 failed 的第 2 章快照
    expect(parsed.total).toBe(1)
    expect(parsed.facts[0]).toMatchObject({
      subject: "苏砚",
      object: "持有觉醒芯片",
      validFrom: 1,
      source: "chapter-1",
    })
    expect(parsed.meta).toEqual({ readOnly: true, llmCalls: 0, diskWrites: 0 })

    // 自由句快照事实（无冒号分隔符）也可在同一时态窗口内被安全召回
    const freeFormTools = createMainControlMcpTools(PROJECT, {
      queryCanonEdges: async () => [],
      loadAllSnapshots: async () => [
        {
          chapterNumber: 1,
          summary: "第1章",
          charactersPresent: ["苏砚"],
          newCanonFacts: ["苏砚在旧城黑市修复芯片"],
          foreshadowingUpdates: [],
          characterStateDeltas: [],
          timestamp: "2026-01-01T00:00:00Z",
        } as unknown as ChapterSnapshot,
      ],
      loadProjectionStatusLedger: async () => undefined,
    })
    const freeOut = await toolByName(freeFormTools, "canon_query").execute({
      subject: "苏砚",
      validAtChapter: 2,
    })
    const freeParsed = JSON.parse(freeOut)
    expect(freeParsed.source).toBe("committed_snapshots_fallback")
    expect(freeParsed.total).toBe(1)
    expect(freeParsed.facts[0].subject).toContain("苏砚")
  })

  it("REV1-004：canon_query 指定 knownBy 时严格 POV 隔离 — 图空返回 canon_graph 空集，图异常返回 canon_graph_unavailable，均绝不回退全知快照", async () => {
    const secretSnapshots: ChapterSnapshot[] = [
      {
        chapterNumber: 1,
        summary: "第1章",
        charactersPresent: ["苏砚"],
        newCanonFacts: ["苏砚：持有绝密芯片"],
        foreshadowingUpdates: [],
        characterStateDeltas: [],
        timestamp: "2026-01-01T00:00:00Z",
      } as unknown as ChapterSnapshot,
    ]

    // 1. Canon 图查询成功但该 POV 角色知晓事实为空 -> 直接返回 source: "canon_graph", facts: []
    const loadSnapshotsEmptyCase = vi.fn(async () => secretSnapshots)
    const emptyGraphTools = createMainControlMcpTools(PROJECT, {
      queryCanonEdges: vi.fn(async () => []),
      loadAllSnapshots: loadSnapshotsEmptyCase,
    })
    const emptyOut = await toolByName(emptyGraphTools, "canon_query").execute({
      subject: "苏砚",
      validAtChapter: 2,
      knownBy: "沈知微",
    })
    const emptyParsed = JSON.parse(emptyOut)
    expect(emptyParsed.source).toBe("canon_graph")
    expect(emptyParsed.facts).toEqual([])
    expect(emptyParsed.total).toBe(0)
    expect(emptyParsed.returned).toBe(0)
    expect(emptyParsed.meta).toEqual({ readOnly: true, llmCalls: 0, diskWrites: 0 })
    expect(loadSnapshotsEmptyCase).not.toHaveBeenCalled()

    // 2. Canon 图查询异常 -> 返回 source: "canon_graph_unavailable", facts: []，绝不泄漏全知快照
    const loadSnapshotsErrorCase = vi.fn(async () => secretSnapshots)
    const errorGraphTools = createMainControlMcpTools(PROJECT, {
      queryCanonEdges: vi.fn(async () => {
        throw new Error("Tauri IPC unavailable")
      }),
      loadAllSnapshots: loadSnapshotsErrorCase,
    })
    const errOut = await toolByName(errorGraphTools, "canon_query").execute({
      subject: "苏砚",
      validAtChapter: 2,
      knownBy: "沈知微",
    })
    const errParsed = JSON.parse(errOut)
    expect(errParsed.source).toBe("canon_graph_unavailable")
    expect(errParsed.facts).toEqual([])
    expect(errParsed.total).toBe(0)
    expect(errParsed.returned).toBe(0)
    expect(errParsed.canonGraphError).toContain("Tauri IPC unavailable")
    expect(errParsed.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("POV isolation"), expect.stringContaining("knownBy")]),
    )
    expect(errParsed.meta).toEqual({ readOnly: true, llmCalls: 0, diskWrites: 0 })
    expect(loadSnapshotsErrorCase).not.toHaveBeenCalled()
  })

  it("输出超过 12000 字符时安全截断到 <= 12000 并附显式截断提示", async () => {
    const huge = { payload: "甲".repeat(20_000) }
    const formatted = formatMainControlMcpOutput(huge)
    expect(formatted.length).toBeLessThanOrEqual(MAX_MAIN_CONTROL_MCP_OUTPUT_CHARS)
    expect(formatted).toContain("输出已截断")

    const runWorkflowNext = vi.fn(async () => huge as any)
    const tools = createMainControlMcpTools(PROJECT, { runWorkflowNext })
    const out = await toolByName(tools, "workflow_next").execute({})
    expect(out.length).toBeLessThanOrEqual(MAX_MAIN_CONTROL_MCP_OUTPUT_CHARS)
    expect(out).toContain("输出已截断")
  })

  it("底层工具抛错时返回中文错误串而不是 reject", async () => {
    const runForeshadowingList = vi.fn(async () => {
      throw new Error("disk unreadable")
    })
    const tools = createMainControlMcpTools(PROJECT, { runForeshadowingList })
    await expect(toolByName(tools, "foreshadowing_list").execute({})).resolves.toBe(
      "错误：foreshadowing_list 执行失败 - disk unreadable",
    )
  })

  it("skills_list / skills_get：严格白名单透传、显式 null 剥离与错误处理", async () => {
    const runSkillsList = vi.fn(async () => ({
      total: 2,
      returned: 2,
      items: [{ id: "skill:1", name: "测试技能", contentChars: 120 }],
    }) as any)
    const runSkillsGet = vi.fn(async () => ({
      returned: 1,
      skills: [{ id: "skill:1", name: "测试技能", content: "正文" }],
    }) as any)

    const tools = createMainControlMcpTools(PROJECT, { runSkillsList, runSkillsGet })

    const listOut = await toolByName(tools, "skills_list").execute({
      stage: "outline",
      kind: "writing",
      query: null,
      enabledOnly: true,
      limit: null,
      rogueExtra: "drop-me",
    })
    expect(runSkillsList).toHaveBeenCalledWith(PROJECT, {
      stage: "outline",
      kind: "writing",
      enabledOnly: true,
    })
    expect(JSON.parse(listOut)).toMatchObject({ total: 2, returned: 2 })

    const getOut = await toolByName(tools, "skills_get").execute({
      ids: ["skill:1"],
      names: null,
      stage: null,
      stripFrontmatter: true,
      maxCharsPerSkill: 2000,
      unknownField: 42,
    })
    expect(runSkillsGet).toHaveBeenCalledWith(PROJECT, {
      ids: ["skill:1"],
      stripFrontmatter: true,
      maxCharsPerSkill: 2000,
    })
    expect(JSON.parse(getOut)).toMatchObject({ returned: 1 })

    // 错误捕获为中文错误串
    const errTools = createMainControlMcpTools(PROJECT, {
      runSkillsList: vi.fn(async () => {
        throw new Error("list failed")
      }),
      runSkillsGet: vi.fn(async () => {
        throw new Error("skills.get 至少需要提供 ids、names 或 stage 之一")
      }),
    })
    await expect(toolByName(errTools, "skills_list").execute({})).resolves.toBe(
      "错误：skills_list 执行失败 - list failed",
    )
    await expect(toolByName(errTools, "skills_get").execute({})).resolves.toBe(
      "错误：skills_get 执行失败 - skills.get 至少需要提供 ids、names 或 stage 之一",
    )
  })
})
