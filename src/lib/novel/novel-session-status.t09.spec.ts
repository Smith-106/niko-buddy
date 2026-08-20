import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildNextStatus,
  loadNovelSessionStatus,
  novelSessionStatusPath,
  startDeepChapterSession,
  validateAndBackfillNovelSessionStatus,
  type AntiAiMode,
  type CanonMigrationMode,
  type NovelSessionStatus,
  type RouteShellMode,
} from "./novel-session-status"

const fsState = vi.hoisted(() => {
  const fileMap = new Map<string, string>()
  const createdDirs = new Set<string>()
  return {
    fileMap,
    createdDirs,
    createDirectory: vi.fn<typeof import("@/commands/fs").createDirectory>(async (path) => {
      createdDirs.add(path)
    }),
    readFile: vi.fn<typeof import("@/commands/fs").readFile>(async (path) => {
      const content = fileMap.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    }),
    writeFileAtomic: vi.fn<typeof import("@/commands/fs").writeFileAtomic>(async (path, content) => {
      fileMap.set(path, content)
    }),
  }
})

vi.mock("@/commands/fs", () => ({
  createDirectory: fsState.createDirectory,
  readFile: fsState.readFile,
  writeFileAtomic: fsState.writeFileAtomic,
}))

function readJson(path: string): Record<string, unknown> {
  const raw = fsState.fileMap.get(path)
  if (!raw) throw new Error(`Missing file: ${path}`)
  return JSON.parse(raw) as Record<string, unknown>
}

const projectPath = "E:\\Novel"
const statusPath = novelSessionStatusPath(projectPath)

function minimalStatus(): Record<string, unknown> {
  return {
    schema_version: "1",
    session_id: "sess-t09",
    source: "deep_chapter_generation",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    status: "running",
    active_step_index: 3,
    current_task: {
      task_id: "t",
      conversation_id: "conv-t09",
      user_request: "generate chapter 3",
      chapter_number: 3,
      checkpoint_stage: "started",
      status: "running",
    },
    draft: {
      draft_id: "conv-t09",
      file_path: `${projectPath}/.novel/drafts/conv-t09.json`,
      draft_status: "pending",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    decision_gates: {
      consistency: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
      anti_ai: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
      quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
      overall: "pending",
    },
    resume_checkpoint: undefined,
    evidence_refs: [],
  }
}

describe("T09: zod passthrough 加载边界护栏 validateAndBackfillNovelSessionStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsState.fileMap.clear()
    fsState.createdDirs.clear()
  })

  it("校验通过: 核心字段 + 4 additive 开关缺省回填 undefined + 保留未知键", () => {
    const raw = minimalStatus()
    // 注入一个未来 additive 未知键 + 一个派生键, 验证 .passthrough() 保留
    raw.future_additive_key = "should-be-preserved"
    raw.derived_view = { synced: true }

    const result = validateAndBackfillNovelSessionStatus(raw)
    expect(result).not.toBeNull()
    // 核心字段原样保留
    expect(result!.session_id).toBe("sess-t09")
    expect(result!.status).toBe("running")
    expect(result!.active_step_index).toBe(3)
    // 4 additive 开关缺省回填为 undefined（默认值回填）
    expect(result!.step_digest).toBeUndefined()
    expect(result!.route_shell_mode).toBeUndefined()
    expect(result!.canon_migration).toBeUndefined()
    expect(result!.anti_ai_mode).toBeUndefined()
    // 保留未知键（passthrough）
    const asRec = result as unknown as Record<string, unknown>
    expect(asRec.future_additive_key).toBe("should-be-preserved")
    expect(asRec.derived_view).toEqual({ synced: true })
    // decision_gates 经 cloneDecisionGates 重建
    expect(result!.decision_gates.overall).toBe("pending")
  })

  it("校验通过: 4 开关带值时保留, 且类型落已知字面量/自定义扩展位", () => {
    const raw = minimalStatus()
    raw.step_digest = "step-abc-123"
    raw.route_shell_mode = "route"
    raw.canon_migration = "dual"
    raw.anti_ai_mode = "block"

    const result = validateAndBackfillNovelSessionStatus(raw)
    expect(result).not.toBeNull()
    expect(result!.step_digest).toBe("step-abc-123")
    expect(result!.route_shell_mode).toBe("route")
    expect(result!.canon_migration).toBe("dual")
    expect(result!.anti_ai_mode).toBe("block")
    // 自定义扩展位（非蓝图预定义字面量）也接受
    const custom = validateAndBackfillNovelSessionStatus({
      ...minimalStatus(),
      route_shell_mode: "custom-experimental",
      canon_migration: "canary",
      anti_ai_mode: "audit",
    })
    expect(custom!.route_shell_mode).toBe("custom-experimental")
    expect(custom!.canon_migration).toBe("canary")
    expect(custom!.anti_ai_mode).toBe("audit")
  })

  it("校验失败: schema_version 非 '1' → null", () => {
    const raw = minimalStatus()
    raw.schema_version = "2"
    expect(validateAndBackfillNovelSessionStatus(raw)).toBeNull()
  })

  it("校验失败: status 枚举越界 → null (与 CORR-008 手动校验等价)", () => {
    const raw = minimalStatus()
    raw.status = "foo"
    expect(validateAndBackfillNovelSessionStatus(raw)).toBeNull()
    const badDraft = minimalStatus()
    ;(badDraft.draft as Record<string, unknown>).draft_status = "bar"
    expect(validateAndBackfillNovelSessionStatus(badDraft)).toBeNull()
    const badCurrent = minimalStatus()
    ;(badCurrent.current_task as Record<string, unknown>).status = "baz"
    expect(validateAndBackfillNovelSessionStatus(badCurrent)).toBeNull()
  })

  it("校验失败: 缺失必填字段 → null", () => {
    const raw = minimalStatus()
    delete raw.session_id
    expect(validateAndBackfillNovelSessionStatus(raw)).toBeNull()
    const noDraft = minimalStatus()
    delete (noDraft.draft as Record<string, unknown>).draft_id
    expect(validateAndBackfillNovelSessionStatus(noDraft)).toBeNull()
  })

  it("active_step_index: null 或 number 通过, 非数字 → null", () => {
    const nullOk = validateAndBackfillNovelSessionStatus({ ...minimalStatus(), active_step_index: null })
    expect(nullOk).not.toBeNull()
    const bad = validateAndBackfillNovelSessionStatus({ ...minimalStatus(), active_step_index: "x" })
    expect(bad).toBeNull()
  })
})

describe("T09: 4 additive 字段经 buildNextStatus 线穿 (ADR-31 delta-only)", () => {
  const base: NovelSessionStatus = {
    schema_version: "1",
    session_id: "s",
    source: "deep_chapter_generation",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    status: "running",
    active_step_index: 1,
    current_task: { task_id: "t", conversation_id: "c", user_request: "r", checkpoint_stage: "started", status: "running" },
    draft: { draft_id: "d", file_path: "p", draft_status: "pending", updated_at: "2026-01-01T00:00:00.000Z" },
    decision_gates: {
      consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
      anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
      quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
      overall: "pass",
    },
    evidence_refs: [],
  }

  it("base 无开关 → 缺省 undefined; 传入 → 线穿; 显式 undefined → 清除", () => {
    // base 无开关 → 默认 undefined
    const inherited = buildNextStatus(base, { updated_at: "2026-01-02T00:00:00.000Z", status: "running" })
    expect(inherited.step_digest).toBeUndefined()
    expect(inherited.route_shell_mode).toBeUndefined()
    expect(inherited.canon_migration).toBeUndefined()
    expect(inherited.anti_ai_mode).toBeUndefined()

    // 传入 → 线穿
    const withSwitches = buildNextStatus(base, {
      updated_at: "2026-01-02T00:00:00.000Z",
      status: "running",
      step_digest: "digest-x",
      route_shell_mode: "route" as RouteShellMode,
      canon_migration: "dual" as CanonMigrationMode,
      anti_ai_mode: "block" as AntiAiMode,
    })
    expect(withSwitches.step_digest).toBe("digest-x")
    expect(withSwitches.route_shell_mode).toBe("route")
    expect(withSwitches.canon_migration).toBe("dual")
    expect(withSwitches.anti_ai_mode).toBe("block")

    // 显式 undefined → 清除（delta-only 语义: key in overrides 即覆盖 base）
    const cleared = buildNextStatus(withSwitches, {
      updated_at: "2026-01-02T00:00:00.000Z",
      status: "running",
      route_shell_mode: undefined,
      canon_migration: undefined,
      anti_ai_mode: undefined,
      step_digest: undefined,
    })
    expect(cleared.step_digest).toBeUndefined()
    expect(cleared.route_shell_mode).toBeUndefined()
    expect(cleared.canon_migration).toBeUndefined()
    expect(cleared.anti_ai_mode).toBeUndefined()
  })

  it("base 已带开关 → 省略 override 时继承 base (项目级开关跨 lifecycle 转移持久)", () => {
    const baseWithSwitches: NovelSessionStatus = {
      ...base,
      step_digest: "base-digest",
      route_shell_mode: "route",
      canon_migration: "dual",
      anti_ai_mode: "warn",
    }
    // 只改 status, 不动开关 → 继承 base 值
    const next = buildNextStatus(baseWithSwitches, {
      updated_at: "2026-01-02T00:00:00.000Z",
      status: "paused",
    })
    expect(next.step_digest).toBe("base-digest")
    expect(next.route_shell_mode).toBe("route")
    expect(next.canon_migration).toBe("dual")
    expect(next.anti_ai_mode).toBe("warn")
  })
})

describe("T09: 三开关按 projectId 项目级隔离单测", () => {
  const projectA = "E:\\ProjA"
  const projectB = "E:\\ProjB"
  const statusPathA = novelSessionStatusPath(projectA)

  beforeEach(() => {
    vi.clearAllMocks()
    fsState.fileMap.clear()
    fsState.createdDirs.clear()
  })

  it("两项目各自 status.json 持有独立开关值, 互不串扰; 缺省 → undefined", async () => {
    // 项目 A: 开启 route / dual / block, 带 step_digest
    await startDeepChapterSession({
      projectPath: projectA,
      conversationId: "conv-a",
      userRequest: "generate chapter 1",
      chapterNumber: 1,
    })
    const rawA = readJson(statusPathA)
    rawA.route_shell_mode = "route"
    rawA.canon_migration = "dual"
    rawA.anti_ai_mode = "block"
    rawA.step_digest = "digest-a"
    fsState.fileMap.set(statusPathA, JSON.stringify(rawA))

    // 项目 B: 保持默认（不写任何开关字段）
    await startDeepChapterSession({
      projectPath: projectB,
      conversationId: "conv-b",
      userRequest: "generate chapter 1",
      chapterNumber: 1,
    })

    const loadedA = await loadNovelSessionStatus(projectA)
    const loadedB = await loadNovelSessionStatus(projectB)

    // 项目 A 开关值独立保持
    expect(loadedA?.route_shell_mode).toBe("route")
    expect(loadedA?.canon_migration).toBe("dual")
    expect(loadedA?.anti_ai_mode).toBe("block")
    expect(loadedA?.step_digest).toBe("digest-a")

    // 项目 B 开关值独立为 undefined（与 A 隔离, 不串扰）
    expect(loadedB?.route_shell_mode).toBeUndefined()
    expect(loadedB?.canon_migration).toBeUndefined()
    expect(loadedB?.anti_ai_mode).toBeUndefined()
    expect(loadedB?.step_digest).toBeUndefined()

    // 跨项目断言: B 不是 A 的值
    expect(loadedB?.route_shell_mode).not.toBe(loadedA?.route_shell_mode)
  })

  it("旧 status.json 无 4 字段仍可加载 (additive 兼容), 且写回后仍不含开关字段", async () => {
    // 模拟旧版 status.json: 手工构造不含 4 开关字段的对象
    const legacy = minimalStatus()
    delete legacy.decision_gates // 进一步贴近极简旧文件
    fsState.fileMap.set(statusPath, JSON.stringify(legacy))

    const loaded = await loadNovelSessionStatus(projectPath)
    expect(loaded).not.toBeNull()
    expect(loaded!.schema_version).toBe("1")
    expect(loaded!.step_digest).toBeUndefined()
    expect(loaded!.route_shell_mode).toBeUndefined()
    expect(loaded!.canon_migration).toBeUndefined()
    expect(loaded!.anti_ai_mode).toBeUndefined()
    // 未知键经 passthrough 保留
    expect((loaded as unknown as Record<string, unknown>).source).toBe("deep_chapter_generation")
  })
})
