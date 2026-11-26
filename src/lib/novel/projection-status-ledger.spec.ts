import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  AUDIT_TRAIL_MAX_ENTRIES,
  EXTERNAL_DATA_CLASSES,
  EXTERNAL_DATA_CLASS_ATTRIBUTES,
  LEDGER_SAVE_MAX_RETRIES,
  LEDGER_SCHEMA_VERSION,
  PROJECTION_CATEGORIES,
  appendProjectionAuditEntry,
  assertProjectionRegistryComplete,
  emptyLedger,
  isAutoRebuildableProjection,
  isExternalDataClass,
  isFoldReplayExcluded,
  loadProjectionStatusLedger,
  mergeProjectionLedgerDelta,
  recordProjectionAudit,
  recordProjectionStatus,
  registerProjections,
  removeChapterFromProjectionLedger,
  resettleInterruptedCommunitySummaries,
  resolveExternalDataClass,
  saveProjectionStatusLedger,
  shouldRetryLedgerSave,
  syncDirectWriteProjectionIds,
  trimAuditTrail,
  type ProjectionAuditEntry,
  type ProjectionRegistryEntry,
  type ProjectionStatusLedger,
} from "./projection-status-ledger"
import { supersedeFact } from "./graph-adapter"
import { computeCheckpointDigest } from "./checkpoint-digest"

// F-002 持久化读路径 (loadProjectionStatusLedger) 需要 @/commands/fs mock;
// graph-adapter 的 supersedeFact 测试只用字符串处理, 不受 mock 影响。
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("ENOENT")
  }),
  // Typed params so mock.calls tuples + implementations typecheck strictly.
  writeFileAtomic: vi.fn<(path: string, content: string) => Promise<void>>(async () => {}),
  createDirectory: vi.fn<(path: string) => Promise<void>>(async () => {}),
  fileExists: vi.fn<(path: string) => Promise<boolean>>(async () => false),
  readFileAsBase64: vi.fn<(path: string) => Promise<{ base64: string }>>(async () => {
    throw new Error("ENOENT")
  }),
  copyFile: vi.fn<(src: string, dst: string, options?: { exclusive?: boolean }) => Promise<void>>(async () => {}),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: fsMocks.readFile,
      writeFileAtomic: fsMocks.writeFileAtomic,
      createDirectory: fsMocks.createDirectory,
      fileExists: fsMocks.fileExists,
      readFileAsBase64: fsMocks.readFileAsBase64,
      copyFile: fsMocks.copyFile,
    
  }
})

beforeEach(() => {
  fsMocks.readFile.mockReset()
  fsMocks.readFile.mockImplementation(async () => {
    throw new Error("ENOENT")
  })
})

describe("F-002 ProjectionStatusLedger (C-002 mixed_per_projection)", () => {
  it("defines all 3 C-002 categories across the 9 projections", () => {
    const cats = PROJECTION_CATEGORIES
    // single_snapshot_idempotent
    expect(cats.vector).toBe("single_snapshot_idempotent")
    expect(cats.snapshot).toBe("single_snapshot_idempotent")
    expect(cats.chapter_ingest_output).toBe("single_snapshot_idempotent")
    // fold_rebuildable
    expect(cats.cognition).toBe("fold_rebuildable")
    expect(cats.character).toBe("fold_rebuildable")
    expect(cats.foreshadow).toBe("fold_rebuildable")
    expect(cats.summary_structured_memory).toBe("fold_rebuildable")
    // P2-IMP-02：过程库三投影 + subplot_board 补登 fold_rebuildable
    expect(cats.emotional_arc).toBe("fold_rebuildable")
    expect(cats.resource_ledger).toBe("fold_rebuildable")
    expect(cats.subplot_board).toBe("fold_rebuildable")
    expect(cats.encounter_matrix).toBe("fold_rebuildable")
    expect(cats.chapter_summaries).toBe("fold_rebuildable")
    expect(cats.particle_ledger).toBe("fold_rebuildable")
    // mutates_existing_non_rebuildable
    expect(cats.graph_entity_pages).toBe("mutates_existing_non_rebuildable")
    expect(cats.graph_entity_patch_fields).toBe("mutates_existing_non_rebuildable")
    expect(cats.community_summary).toBe("mutates_existing_non_rebuildable")

    // Exactly 3 distinct categories present.
    const distinct = new Set(Object.values(cats))
    expect(distinct.size).toBe(3)
    expect(distinct.has("single_snapshot_idempotent")).toBe(true)
    expect(distinct.has("fold_rebuildable")).toBe(true)
    expect(distinct.has("mutates_existing_non_rebuildable")).toBe(true)
  })

  it("emptyLedger seeds the canonical category mapping", () => {
    const ledger = emptyLedger()
    expect(ledger.projections.vector).toBe("single_snapshot_idempotent")
    expect(ledger.projections.graph_entity_pages).toBe("mutates_existing_non_rebuildable")
    expect(ledger.chapters).toEqual({})
  })

  it("subplot_board is fold_rebuildable (P2-IMP-02：applySubplotChangesToStore 从 snapshot 解析 targetResolutionChapter/abandoned)", () => {
    expect(PROJECTION_CATEGORIES.subplot_board).toBe("fold_rebuildable")
  })

  it("P2-IMP-02：PROJECTION_CATEGORIES 键集 ⊇ chapter-ingest runProjection 全部 projectionId", () => {
    const runProjectionIds = [
      "vector", "graph_entity_pages", "graph_entity_patch_fields",
      "cognition", "character", "foreshadow",
      "emotional_arc", "resource_ledger", "subplot_board",
      "encounter_matrix", "chapter_summaries", "particle_ledger",
      "summary_structured_memory", "sync_snapshot_to_memory",
      "snapshot", "chapter_ingest_output",
    ]
    const catKeys = new Set(Object.keys(PROJECTION_CATEGORIES))
    for (const id of runProjectionIds) {
      expect(catKeys.has(id)).toBe(true)
    }
  })

  it("recordProjectionStatus records a committed projection additively (failure is VISIBLE, not silent)", () => {
    // The core F-002 invariant: a projection failure is recorded to the ledger
    // so it is detectable — replacing the prior 8-segment silent console.warn.
    let ledger: ProjectionStatusLedger = emptyLedger()
    ledger = recordProjectionStatus(ledger, 5, "cognition", "committed")
    ledger = recordProjectionStatus(ledger, 5, "graph_entity_pages", "failed", "write failed: EACCES")
    ledger = recordProjectionStatus(ledger, 5, "character", "committed")

    const ch5 = ledger.chapters["5"]
    expect(ch5.cognition.status).toBe("committed")
    expect(ch5.cognition.category).toBe("fold_rebuildable")
    expect(ch5.character.status).toBe("committed")
    // The FAILED projection is recorded with its error — visible, not swallowed.
    expect(ch5.graph_entity_pages.status).toBe("failed")
    expect(ch5.graph_entity_pages.last_error).toContain("EACCES")
    expect(ch5.graph_entity_pages.category).toBe("mutates_existing_non_rebuildable")
  })

  it("recordProjectionStatus preserves other chapters' entries (additive, per-cell update)", () => {
    let ledger: ProjectionStatusLedger = emptyLedger()
    ledger = recordProjectionStatus(ledger, 1, "cognition", "committed")
    ledger = recordProjectionStatus(ledger, 2, "character", "failed", "boom")
    // Recording chapter 3 must not clobber chapters 1 and 2.
    ledger = recordProjectionStatus(ledger, 3, "foreshadow", "committed")
    expect(ledger.chapters["1"].cognition.status).toBe("committed")
    expect(ledger.chapters["2"].character.status).toBe("failed")
    expect(ledger.chapters["3"].foreshadow.status).toBe("committed")
  })
})

describe("F-002 loadProjectionStatusLedger 持久化读路径", () => {
  it("merges a partial file's projections with the canonical categories", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        projections: { vector: "single_snapshot_idempotent", community_summary: "mutates_existing_non_rebuildable" },
        chapters: {
          "3": {
            cognition: { projection: "cognition", category: "fold_rebuildable", status: "committed", updated_at: "2026-07-10T00:00:00Z", last_error: "" },
          },
        },
      }),
    )
    const ledger = await loadProjectionStatusLedger("E:/Novel")
    // 文件里的覆盖值 + 规范化 categories 合并 (旧版本账本也能反映新 projection)
    expect(ledger.projections.vector).toBe("single_snapshot_idempotent")
    expect(ledger.projections.community_summary).toBe("mutates_existing_non_rebuildable")
    expect(ledger.projections.character).toBe("fold_rebuildable")
    expect(ledger.projections.subplot_board).toBe("fold_rebuildable")
    expect(ledger.chapters["3"].cognition.status).toBe("committed")
  })

  it("uses {} when a legacy file has no projections field", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ version: 1, chapters: {} }))
    const ledger = await loadProjectionStatusLedger("E:/Novel")
    // parsed.projections undefined → ?? {} 臂 → 只有规范化 categories
    expect(ledger.projections.vector).toBe("single_snapshot_idempotent")
    expect(Object.keys(ledger.projections)).toEqual(Object.keys(PROJECTION_CATEGORIES))
    expect(ledger.chapters).toEqual({})
  })

  it("rejects non-object payloads but still loads chapters-less legacy docs", async () => {
    fsMocks.readFile.mockResolvedValue("null") // 非 record 臂：拒绝，不静默降级
    await expect(loadProjectionStatusLedger("E:/Novel")).rejects.toThrow("[projection-status-ledger] invalid ledger document")

    fsMocks.readFile.mockResolvedValue("[]") // JSON array 同样非法
    await expect(loadProjectionStatusLedger("E:/Novel")).rejects.toThrow("[projection-status-ledger] invalid ledger document")

    fsMocks.readFile.mockResolvedValue(JSON.stringify({ version: 1 })) // 无 chapters 的 legacy 文档仍可加载
    expect(await loadProjectionStatusLedger("E:/Novel")).toEqual(emptyLedger())
  })

  it("rejects malformed chapter maps and non-record metadata", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ chapters: { "3": "not-a-record" } }))
    await expect(loadProjectionStatusLedger("E:/Novel")).rejects.toThrow("[projection-status-ledger] invalid ledger document")

    fsMocks.readFile.mockResolvedValue(JSON.stringify({ chapters: { "3": { cognition: "not-a-record" } } }))
    await expect(loadProjectionStatusLedger("E:/Novel")).rejects.toThrow("[projection-status-ledger] invalid ledger document")

    fsMocks.readFile.mockResolvedValue(JSON.stringify({ chapters: "not-a-map" }))
    await expect(loadProjectionStatusLedger("E:/Novel")).rejects.toThrow("[projection-status-ledger] invalid ledger document")

    fsMocks.readFile.mockResolvedValue(JSON.stringify({ auditTrail: "not-an-array" }))
    await expect(loadProjectionStatusLedger("E:/Novel")).rejects.toThrow("[projection-status-ledger] invalid ledger document")
  })

  it("v1 legacy ledger lazy-migrates to schemaVersion \"2\" on load（#4 清偿）", async () => {
    // v1 文件：无 schemaVersion 字段（旧结构，缺 6 类新投影）
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        projections: { vector: "single_snapshot_idempotent", snapshot: "single_snapshot_idempotent", cognition: "fold_rebuildable" },
        chapters: {
          "3": { cognition: { projection: "cognition", category: "fold_rebuildable", status: "committed", updated_at: "2026-07-10T00:00:00Z", last_error: "" } },
        },
      }),
    )
    const ledger = await loadProjectionStatusLedger("E:/Novel")
    // lazy 迁移：load 恒产 v2 结构（下次 save 写回盘上）
    expect(ledger.schemaVersion).toBe("2")
    // v1 缺的新投影由注册表键集补全（emotional_arc/resource_ledger/subplot_board 等）
    expect(ledger.projections.emotional_arc).toBe("fold_rebuildable")
    expect(ledger.projections.resource_ledger).toBe("fold_rebuildable")
    expect(ledger.projections.subplot_board).toBe("fold_rebuildable")
    expect(ledger.projections.character).toBe("fold_rebuildable")
    // 旧 chapter 数据直通保留
    expect(ledger.chapters["3"].cognition.status).toBe("committed")
    // 空 auditTrail 语义保持（v1 无该字段）
    expect(ledger.auditTrail).toEqual([])
  })

  it("v2 ledger keeps its own versions and merges new projections（#4 清偿）", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        schemaVersion: "2",
        projections: { vector: "single_snapshot_idempotent" },
        chapters: {},
        auditTrail: [{ ts: "2026-09-07T00:00:00Z", id: "x", projection: "cognition", status: "ok", message: "" }],
      }),
    )
    const ledger = await loadProjectionStatusLedger("E:/Novel")
    expect(ledger.schemaVersion).toBe("2")
    expect(ledger.auditTrail).toHaveLength(1)
    expect(ledger.projections.character).toBe("fold_rebuildable")
  })

  it("rejects unknown newer schema versions fail-loud（拒绝静默降级）", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ schemaVersion: "3", projections: {}, chapters: {} }))
    await expect(loadProjectionStatusLedger("E:/Novel")).rejects.toThrow(/unsupported ledger schemaVersion "3"/)
  })

  it("v1→v2 迁移写回往返：load(no version)→save→磁盘含 v2→reload 稳定（数据语义证据）", async () => {
    // 步骤1：盘上是 v1 文件（无 schemaVersion，旧投影键集）
    const v1Payload = {
      projections: { vector: "single_snapshot_idempotent", cognition: "fold_rebuildable" },
      chapters: {
        "3": { cognition: { projection: "cognition", category: "fold_rebuildable", status: "committed", updated_at: "2026-07-10T00:00:00Z", last_error: "" } },
      },
      auditTrail: [{ ts: "2026-09-01T00:00:00Z", id: "legacy-1", projection: "character", status: "ok", message: "" }],
    }
    fsMocks.readFile.mockResolvedValue(JSON.stringify(v1Payload))
    const loaded = await loadProjectionStatusLedger("E:/Novel")
    expect(loaded.schemaVersion).toBe("2") // lazy 迁移

    // 步骤2：save 写回 → 磁盘内容必须含 schemaVersion "2"（迁移持久化）
    await saveProjectionStatusLedger("E:/Novel", loaded)
    const writtenRaw = fsMocks.writeFileAtomic.mock.calls[fsMocks.writeFileAtomic.mock.calls.length - 1]?.[1] ?? ""
    const written = JSON.parse(writtenRaw)
    expect(written.schemaVersion).toBe("2")
    // 旧 chapter 数据与 auditTrail 写回后保持（无丢失）
    expect(written.chapters["3"].cognition.status).toBe("committed")
    expect(written.auditTrail).toHaveLength(1)

    // 步骤3：二次 load——schemaVersion/键集/chapters/auditTrail 全部稳定（迁移幂等）
    fsMocks.readFile.mockResolvedValue(writtenRaw)
    const reloaded = await loadProjectionStatusLedger("E:/Novel")
    expect(reloaded.schemaVersion).toBe("2")
    expect(reloaded.projections.character).toBe("fold_rebuildable")
    expect(reloaded.projections.emotional_arc).toBe("fold_rebuildable")
    expect(reloaded.chapters["3"].cognition.status).toBe("committed")
    expect(reloaded.auditTrail).toHaveLength(1)
    expect(reloaded.chapters).toEqual(loaded.chapters)
  })

  it("recordProjectionStatus falls back to fold_rebuildable for unknown projections", () => {
    const ledger = recordProjectionStatus(emptyLedger(), 1, "unknown_projection", "failed", "boom")
    expect(ledger.chapters["1"].unknown_projection.category).toBe("fold_rebuildable")
  })

  it("returns the empty ledger when the ledger file is missing or unreadable", async () => {
    // beforeEach 默认 readFile 抛 ENOENT → catch → emptyLedger; 无 raw 内容,
    // 所以不应产生 .corrupt-* 副本
    fsMocks.writeFileAtomic.mockClear()
    expect(await loadProjectionStatusLedger("E:/Novel")).toEqual(emptyLedger())
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("corrupt ledger rejects load without touching the original bytes", async () => {
    fsMocks.writeFileAtomic.mockClear()
    const corruptRaw = "{{{not-valid-json"
    fsMocks.readFile.mockResolvedValue(corruptRaw)

    await expect(loadProjectionStatusLedger("E:/Novel")).rejects.toThrow("[projection-status-ledger] corrupt JSON; original ledger left unchanged")
    // 读侧零写入：不写备份、不改原文。
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("saveProjectionStatusLedger writes atomic json under .novel", async () => {
    await saveProjectionStatusLedger("E:/Novel", emptyLedger())
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("E:/Novel/.novel")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "E:/Novel/.novel/projection-status.json",
      expect.any(String),
    )
  })
})

describe("F-005 append-only auditTrail (projection-status.json additive)", () => {
  // 顶层 beforeEach 已重置读取桩；这里也重置写入实现，避免前例的文件夹具串用。
  beforeEach(() => {
    fsMocks.writeFileAtomic.mockReset()
    fsMocks.createDirectory.mockReset()
    fsMocks.copyFile.mockReset()
    fsMocks.readFileAsBase64.mockReset()
    fsMocks.fileExists.mockReset()
  })

  const projectPath = "E:/Novel"
  const ledgerFile = `${projectPath}/.novel/projection-status.json`

  function installLedgerFile(raw: string | Buffer, extras: Map<string, string | Buffer> = new Map()) {
    const files = new Map<string, string | Buffer>([[ledgerFile, raw], ...extras])
    fsMocks.readFile.mockImplementation(async (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error("ENOENT")
      if (Buffer.isBuffer(content)) throw new Error(`INVALID_UTF8: '${path}'`)
      return content
    })
    fsMocks.writeFileAtomic.mockImplementation(async (path, content) => {
      files.set(path, content)
    })
    fsMocks.fileExists.mockImplementation(async (path) => files.has(path))
    fsMocks.readFileAsBase64.mockImplementation(async (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error("ENOENT")
      return { base64: Buffer.isBuffer(content) ? content.toString("base64") : Buffer.from(content, "utf8").toString("base64") }
    })
    fsMocks.copyFile.mockImplementation(async (src, dst, options) => {
      const content = files.get(src)
      if (content === undefined) throw new Error("ENOENT")
      // 与原生 exclusive 语义一致：目标已存在的普通文件 = 成功 no-op，绝不覆写。
      if (options?.exclusive && files.has(dst)) return
      files.set(dst, content)
    })
    return files
  }

  const audit = (overrides: Partial<ProjectionAuditEntry> = {}): ProjectionAuditEntry => ({
    projection: "cognition",
    chapter: 7,
    status: "committed",
    durationMs: 12,
    timestamp: "2026-08-21T00:00:00.000Z",
    ...overrides,
  })

  it("空初始态：emptyLedger seeds auditTrail: [] and a legacy trail-less file loads as []", async () => {
    expect(emptyLedger().auditTrail).toEqual([])
    // Legacy pre-F-005 file without an auditTrail field.
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ version: 1, chapters: {} }))
    const ledger = await loadProjectionStatusLedger("E:/Novel")
    expect(ledger.auditTrail).toEqual([])
  })

  it("单条追加：appends one entry into a legacy file WITHOUT dropping projections/chapters", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        projections: { cognition: "fold_rebuildable" },
        chapters: { "7": { cognition: { projection: "cognition", category: "fold_rebuildable", status: "committed", updated_at: "t", last_error: "" } } },
      }),
    )
    await appendProjectionAuditEntry("E:/Novel", audit())
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("E:/Novel/.novel")
    const [path, payload] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(String(path)).toBe("E:/Novel/.novel/projection-status.json")
    const doc = JSON.parse(payload as string)
    // Strictly additive — every pre-existing top-level field survives.
    expect(doc.version).toBe(1)
    expect(doc).not.toHaveProperty("schemaVersion")
    expect(doc.projections.cognition).toBe("fold_rebuildable")
    expect(doc.chapters["7"].cognition.status).toBe("committed")
    expect(doc.auditTrail).toHaveLength(1)
    expect(doc.auditTrail[0]).toMatchObject({ projection: "cognition", chapter: 7, status: "committed", durationMs: 12 })
  })

  it("多条累积：sequential appends accumulate across reads/writes in order", async () => {
    const files = installLedgerFile("{}")
    await appendProjectionAuditEntry("E:/Novel", audit())
    await appendProjectionAuditEntry("E:/Novel", audit({ projection: "vector", chapter: 8 }))
    await appendProjectionAuditEntry("E:/Novel", audit({ projection: "graph_entity_pages", chapter: 8 }))
    const { auditTrail: trail } = JSON.parse(files.get(ledgerFile)! as string) as { auditTrail: ProjectionAuditEntry[] }
    expect(trail).toHaveLength(3)
    expect(trail.map((e) => e.projection)).toEqual(["cognition", "vector", "graph_entity_pages"])
  })

  it("merges independent chapter deltas and a concurrent append without losing audit or legacy fields", async () => {
    const legacy = { marker: "keep" }
    const files = installLedgerFile(JSON.stringify({ chapters: {}, legacy }))
    const first = recordProjectionStatus(emptyLedger(), 7, "cognition", "committed")
    const second = recordProjectionStatus(emptyLedger(), 8, "vector", "failed", "vector failure")
    const entry = audit({ chapter: 9 })

    const [firstApplied, , secondApplied] = await Promise.all([
      mergeProjectionLedgerDelta(projectPath, first),
      appendProjectionAuditEntry(projectPath, entry),
      mergeProjectionLedgerDelta(projectPath, second),
    ])

    const doc = JSON.parse(files.get(ledgerFile)! as string)
    expect(doc.chapters).toEqual({ ...first.chapters, ...second.chapters })
    expect(doc.auditTrail).toEqual([entry])
    expect(doc.legacy).toEqual(legacy)
    expect(firstApplied.has(first.chapters["7"].cognition)).toBe(true)
    expect(secondApplied.has(second.chapters["8"].vector)).toBe(true)
  })

  it("does not mark a newer failure healed when the expected cell changed", async () => {
    const old = recordProjectionStatus(emptyLedger(), 7, "cognition", "failed", "old failure")
    const newer = { ...old.chapters["7"].cognition, last_error: "new failure" }
    const files = installLedgerFile(JSON.stringify({
      ...old,
      chapters: { "7": { cognition: newer } },
    }))
    const delta = recordProjectionStatus(emptyLedger(), 7, "cognition", "committed")

    const applied = await mergeProjectionLedgerDelta(projectPath, delta, old.chapters)

    expect(applied.size).toBe(0)
    expect(JSON.parse(files.get(ledgerFile)! as string).chapters["7"].cognition).toEqual(newer)
  })

  it("stale pending attempt does not overwrite newer pending; terminal audit withheld on CAS miss", async () => {
    // 两次 deferred 在同一毫秒生成 pending：attemptId 区分先后，旧 attempt 的终态
    // 写不得覆盖已落盘的较新 pending（CAS miss），其 terminal 审计也不追加——
    // 未生效的终态事件进 log 会误导重建核对。
    const ts = "2026-10-01T00:00:00.000Z"
    const stalePending = { ...recordProjectionStatus(emptyLedger(), 7, "community_summary", "pending").chapters["7"].community_summary, updated_at: ts, attemptId: "attempt-old" }
    const newerPending = { ...stalePending, attemptId: "attempt-new" }
    const files = installLedgerFile(JSON.stringify({ chapters: { "7": { community_summary: newerPending } } }))
    const delta = recordProjectionStatus(emptyLedger(), 7, "community_summary", "committed")
    delta.chapters["7"].community_summary.updated_at = ts
    const event = audit({ projection: "community_summary", chapter: 7, status: "rebuild" })
    delta.auditTrail = [event]

    const applied = await mergeProjectionLedgerDelta(projectPath, delta, { "7": { community_summary: stalePending } })

    const doc = JSON.parse(files.get(ledgerFile)! as string) as {
      chapters: Record<string, Record<string, { status?: string; attemptId?: string }>>
      auditTrail?: Array<{ projection?: string; status?: string }>
    }
    // 较新的 pending cell 原样保留（status/attemptId 均不被回写）。
    expect(doc.chapters["7"].community_summary.status).toBe("pending")
    expect(doc.chapters["7"].community_summary.attemptId).toBe("attempt-new")
    expect(applied.size).toBe(0)
    // CAS miss → 终态审计不追加（未生效事件不进 log）。
    const terminal = (doc.auditTrail ?? []).filter((e) => e.projection === "community_summary")
    expect(terminal).toHaveLength(0)
  })

  it("terminal audit is retained when the CAS cell applies", async () => {
    const ts = "2026-10-01T00:00:00.000Z"
    const pending = { ...recordProjectionStatus(emptyLedger(), 7, "community_summary", "pending").chapters["7"].community_summary, updated_at: ts, attemptId: "attempt-live" }
    const files = installLedgerFile(JSON.stringify({ chapters: { "7": { community_summary: pending } } }))
    const delta = recordProjectionStatus(emptyLedger(), 7, "community_summary", "committed")
    delta.chapters["7"].community_summary.updated_at = ts
    const event = audit({ projection: "community_summary", chapter: 7, status: "rebuild" })
    delta.auditTrail = [event]

    const applied = await mergeProjectionLedgerDelta(projectPath, delta, { "7": { community_summary: pending } })

    const doc = JSON.parse(files.get(ledgerFile)! as string) as {
      chapters: Record<string, Record<string, { status?: string }>>
      auditTrail?: Array<{ projection?: string; status?: string }>
    }
    expect(applied.size).toBe(1)
    expect(doc.chapters["7"].community_summary.status).toBe("committed")
    const terminal = (doc.auditTrail ?? []).filter((e) => e.projection === "community_summary")
    expect(terminal).toHaveLength(1)
    expect(terminal[0]?.status).toBe("rebuild")
  })

  it.each([undefined, LEDGER_SCHEMA_VERSION])("settles only abandoned community summaries without rewriting schema %s", async (schemaVersion) => {
    const legacy = recordProjectionStatus(emptyLedger(), 7, "community_summary", "pending").chapters["7"].community_summary
    const old = { ...legacy, attemptId: "old-attempt", vendorCell: { keep: true } }
    const active = { ...legacy, attemptId: "active-attempt" }
    const committed = { ...legacy, status: "committed", attemptId: "committed-attempt" }
    const otherPending = recordProjectionStatus(emptyLedger(), 7, "vector", "pending").chapters["7"].vector
    const trail = Array.from({ length: AUDIT_TRAIL_MAX_ENTRIES }, (_, index) => audit({ chapter: index + 1 }))
    const files = installLedgerFile(JSON.stringify({
      schemaVersion,
      vendor: { carry: "unchanged" },
      chapters: {
        "7": { community_summary: legacy, vector: otherPending },
        "8": { community_summary: old },
        "9": { community_summary: active },
        "10": { community_summary: committed },
      },
      auditTrail: trail,
    }))

    const activeIds = new Set(["active-attempt"])
    await Promise.all([
      resettleInterruptedCommunitySummaries(projectPath, activeIds),
      resettleInterruptedCommunitySummaries(projectPath, activeIds),
    ])
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const saved = files.get(ledgerFile)
    const doc = JSON.parse(String(saved)) as ProjectionStatusLedger & { vendor: unknown }
    expect(doc.schemaVersion).toBe(schemaVersion)
    expect(doc.vendor).toEqual({ carry: "unchanged" })
    expect(doc.chapters["7"].vector).toEqual(otherPending)
    expect(doc.chapters["9"].community_summary).toEqual(active)
    expect(doc.chapters["10"].community_summary).toEqual(committed)
    expect(doc.chapters["7"].community_summary).toMatchObject({
      status: "failed", last_error: expect.stringMatching(/interrupted.*retry budget exhausted/),
    })
    expect(doc.chapters["7"].community_summary).not.toHaveProperty("attemptId")
    expect(doc.chapters["8"].community_summary).toMatchObject({
      status: "failed", attemptId: "old-attempt", vendorCell: { keep: true },
    })
    expect(doc.auditTrail).toHaveLength(AUDIT_TRAIL_MAX_ENTRIES)
    expect(doc.auditTrail?.slice(0, -2)).toEqual(trail.slice(2))
    expect(doc.auditTrail?.slice(-2)).toEqual([7, 8].map(chapter => ({
      projection: "community_summary", chapter, status: "failed", durationMs: 0,
      error: doc.chapters[String(chapter)].community_summary.last_error,
      timestamp: doc.chapters[String(chapter)].community_summary.updated_at,
    })))

    await resettleInterruptedCommunitySummaries(projectPath, activeIds)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(files.get(ledgerFile)).toBe(saved)
  })

  it("rejects append and merge without writes when ledger read fails with EACCES", async () => {
    const error = new Error("EACCES: permission denied")
    fsMocks.readFile.mockRejectedValue(error)

    await expect(appendProjectionAuditEntry(projectPath, audit())).rejects.toBe(error)
    await expect(mergeProjectionLedgerDelta(projectPath, emptyLedger())).rejects.toBe(error)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsMocks.createDirectory).not.toHaveBeenCalled()
  })

  it("rejects append and merge without writes for an unsupported schemaVersion", async () => {
    const raw = JSON.stringify({ ...emptyLedger(), schemaVersion: "3" })
    const files = installLedgerFile(raw)

    await expect(appendProjectionAuditEntry(projectPath, audit())).rejects.toThrow(/unsupported ledger schemaVersion "3"/)
    await expect(mergeProjectionLedgerDelta(projectPath, emptyLedger())).rejects.toThrow(/unsupported ledger schemaVersion "3"/)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsMocks.createDirectory).not.toHaveBeenCalled()
    expect(files.get(ledgerFile)).toBe(raw)
  })

  it("失败条目含 error：a failed event persists its error message verbatim", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    await appendProjectionAuditEntry(
      "E:/Novel",
      audit({ status: "failed", durationMs: 3400, error: "write failed: EACCES" }),
    )
    const payload = fsMocks.writeFileAtomic.mock.calls[0][1] as string
    const entry = JSON.parse(payload).auditTrail[0]
    expect(entry.status).toBe("failed")
    expect(entry.error).toBe("write failed: EACCES")
  })

  it("corrupt ledger rejects append/merge/save, bytes unchanged, one byte backup across attempts", async () => {
    const raw = "{{{not-json"
    const files = installLedgerFile(raw)
    const entry = audit()

    await expect(appendProjectionAuditEntry(projectPath, entry)).rejects.toThrow("corrupt JSON")
    await expect(mergeProjectionLedgerDelta(projectPath, emptyLedger())).rejects.toThrow("corrupt JSON")
    await expect(saveProjectionStatusLedger(projectPath, emptyLedger())).rejects.toThrow("corrupt JSON")

    // 每次都调用 exclusive copy（已存在时 no-op），但备份只写一次。
    expect(fsMocks.copyFile).toHaveBeenCalledTimes(3)
    const backups = [...files.keys()].filter(k => k.includes(".corrupt-"))
    expect(backups).toHaveLength(1)
    // 原文件与备份字节一致，活动账本未被写。
    expect(files.get(ledgerFile)).toBe(raw)
    expect(files.get(backups[0])).toBe(raw)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("corrupt backup failure blocks the live write entirely", async () => {
    installLedgerFile("{bad json")
    fsMocks.copyFile.mockRejectedValueOnce(new Error("disk full"))
    await expect(appendProjectionAuditEntry(projectPath, audit())).rejects.toThrow()
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("strict read-only path never copies bytes", async () => {
    installLedgerFile("{bad json")
    await expect(loadProjectionStatusLedger("E:/Novel")).rejects.toThrow("corrupt JSON")
    expect(fsMocks.copyFile).not.toHaveBeenCalled()
  })

  it("INVALID_UTF8 read on mutation path backs up raw bytes then rejects", async () => {
    const badBytes = Buffer.from([0xff, 0x0a])
    const files = installLedgerFile(badBytes)
    await expect(appendProjectionAuditEntry(projectPath, audit())).rejects.toThrow("INVALID_UTF8:")
    expect(fsMocks.copyFile).toHaveBeenCalledTimes(1)
    const backups = [...files.keys()].filter(k => k.includes(".corrupt-"))
    expect(backups).toHaveLength(1)
    // 备份与原文件字节一致（base64 无损往返），活动账本未被写。
    expect(files.get(backups[0])).toBe(badBytes)
    expect(files.get(ledgerFile)).toBe(badBytes)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it.each([
    { name: "cell status", doc: { chapters: { "3": { cognition: { projection: "cognition", category: "fold_rebuildable", status: "half-done", updated_at: "t", last_error: "" } } } } },
    { name: "cell identity", doc: { chapters: { "3": { cognition: { projection: "vector", category: "fold_rebuildable", status: "committed", updated_at: "t", last_error: "" } } } } },
    { name: "audit entry", doc: { chapters: {}, auditTrail: [{ projection: "cognition", status: "committed", chapter: "three", durationMs: 1, timestamp: "t" }] } },
  ])("malformed $name: load rejects without backup; append rejects with one verified backup", async ({ doc }) => {
    const raw = JSON.stringify(doc)
    const files = installLedgerFile(raw)
    // 读侧：拒绝且零备份。
    await expect(loadProjectionStatusLedger("E:/Novel")).rejects.toThrow("invalid ledger document")
    expect(fsMocks.copyFile).not.toHaveBeenCalled()
    // 写侧：一份校验过的备份，随后拒写。
    await expect(appendProjectionAuditEntry(projectPath, audit())).rejects.toThrow("invalid ledger document")
    expect(fsMocks.copyFile).toHaveBeenCalledTimes(1)
    const backups = [...files.keys()].filter(k => k.includes(".corrupt-"))
    expect(backups).toHaveLength(1)
    expect(files.get(backups[0])).toBe(raw)
    expect(files.get(ledgerFile)).toBe(raw)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("pre-existing corrupt backup with differing bytes rejects and stays unchanged", async () => {
    const raw = "{corrupt"
    const base64 = Buffer.from(raw, "utf8").toString("base64")
    const fingerprint = await computeCheckpointDigest(base64)
    const backupFile = ledgerFile.replace(/\.json$/, `.corrupt-${fingerprint}.json`)
    const files = installLedgerFile(raw, new Map([[backupFile, "different-bytes"]]))
    await expect(appendProjectionAuditEntry(projectPath, audit())).rejects.toThrow("backup verification failed")
    expect(files.get(backupFile)).toBe("different-bytes")
    expect(files.get(ledgerFile)).toBe(raw)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("recordProjectionAudit accumulates a trail in memory", () => {
    let ledger: ProjectionStatusLedger = emptyLedger()
    ledger = recordProjectionAudit(ledger, audit())
    ledger = recordProjectionAudit(ledger, audit({ projection: "vector", status: "failed", error: "boom" }))
    expect(ledger.auditTrail).toHaveLength(2)
    expect(ledger.auditTrail?.[1].error).toBe("boom")
    // Pure — the source array is not mutated.
    expect(emptyLedger().auditTrail).toEqual([])
  })

  // ── C5 rolling window ───────────────────────────────────────────────────────
  it("C5: trimAuditTrail keeps the most recent N entries (tail-kept)", () => {
    const trail = [1, 2, 3, 4, 5].map((n) => audit({ chapter: n }))
    expect(trimAuditTrail(trail, 3)).toEqual([3, 4, 5].map((n) => audit({ chapter: n })))
    // Under-cap and undefined are returned unchanged.
    expect(trimAuditTrail(trail, 10)).toEqual(trail)
    expect(trimAuditTrail(undefined)).toEqual([])
  })

  it("C5: recordProjectionAudit trims at the cap via the shared trim", () => {
    let ledger: ProjectionStatusLedger = emptyLedger()
    for (let i = 1; i <= AUDIT_TRAIL_MAX_ENTRIES + 5; i++) {
      ledger = recordProjectionAudit(ledger, audit({ chapter: i }))
    }
    expect(ledger.auditTrail).toHaveLength(AUDIT_TRAIL_MAX_ENTRIES)
    // Tail kept: oldest dropped, newest present.
    expect(ledger.auditTrail?.[0].chapter).toBe(6)
    expect(ledger.auditTrail?.slice(-1)[0]?.chapter).toBe(AUDIT_TRAIL_MAX_ENTRIES + 5)
  })

  it("C5: appendProjectionAuditEntry trims the durable trail at the cap", async () => {
    const over = Array.from({ length: AUDIT_TRAIL_MAX_ENTRIES + 3 }, (_, i) => audit({ chapter: i + 1 }))
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({ projections: {}, chapters: {}, auditTrail: over }),
    )
    await appendProjectionAuditEntry("E:/Novel", audit({ chapter: 999 }))
    const [writtenPath, contents] = fsMocks.writeFileAtomic.mock.calls[fsMocks.writeFileAtomic.mock.calls.length - 1]!
    expect(writtenPath).toContain("projection-status.json")
    const doc = JSON.parse(contents) as { auditTrail: ProjectionAuditEntry[] }
    expect(doc.auditTrail).toHaveLength(AUDIT_TRAIL_MAX_ENTRIES)
    // Tail kept: the new entry is present, oldest dropped (503+1-500=4 dropped).
    expect(doc.auditTrail.slice(-1)[0]?.chapter).toBe(999)
    expect(doc.auditTrail[0].chapter).toBe(5)
  })

  it("C5: loadProjectionStatusLedger trims a legacy over-cap trail once on load", async () => {
    const over = Array.from({ length: AUDIT_TRAIL_MAX_ENTRIES + 20 }, (_, i) => audit({ chapter: i + 1 }))
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({ projections: {}, chapters: {}, auditTrail: over }),
    )
    const ledger = await loadProjectionStatusLedger("E:/Pro")
    expect(ledger.auditTrail).toHaveLength(AUDIT_TRAIL_MAX_ENTRIES)
    expect(ledger.auditTrail?.[0].chapter).toBe(21)
  })
})

describe("F-002 graph mergeExistingPage supersession (no destructive overwrite)", () => {
  it("supersedeFact appends a versioned fact WITHOUT removing the old value", () => {
    // ANL-010 L4: mergeExistingPage previously overwrote fact fields in place.
    // The supersession model appends the new value alongside the old so the
    // version history is recoverable for a delete+re-fold rebuild.
    const page = "---\nsnapshot_id: \"snap-1\"\n---\n\nBody text.\n"
    const superseded = supersedeFact(page, "status", "advanced")
    // The old body is preserved.
    expect(superseded).toContain("Body text.")
    // The new value is appended as a versioned line.
    expect(superseded).toContain("status_v: \"advanced\"")
  })

  it("supersedeFact leaves content without frontmatter unchanged (defensive)", () => {
    const noFm = "just body, no frontmatter here"
    expect(supersedeFact(noFm, "status", "x")).toBe(noFm)
  })
})

describe("C-010 外部数据类正交轴", () => {
  it("isExternalDataClass 只认两类字面量", () => {
    expect(isExternalDataClass("external_refetchable")).toBe(true)
    expect(isExternalDataClass("untrusted_input")).toBe(true)
    expect(isExternalDataClass("fold_rebuildable")).toBe(false)
    expect(isExternalDataClass(undefined)).toBe(false)
    expect(isExternalDataClass(42)).toBe(false)
  })

  it("resolveExternalDataClass 优先级：非外部 → null，可执行 > 时间事实", () => {
    expect(
      resolveExternalDataClass({ externalOrigin: false, timeVarying: true, executable: true }),
    ).toBeNull()
    expect(
      resolveExternalDataClass({ externalOrigin: true, timeVarying: true, executable: true }),
    ).toBe("untrusted_input")
    expect(
      resolveExternalDataClass({ externalOrigin: true, timeVarying: true, executable: false }),
    ).toBe("external_refetchable")
    expect(
      resolveExternalDataClass({ externalOrigin: true, timeVarying: false, executable: false }),
    ).toBe("untrusted_input")
  })

  it("两类均禁入 fold 重算与 self-heal，且属性表一致", () => {
    expect(isFoldReplayExcluded("external_refetchable")).toBe(true)
    expect(isFoldReplayExcluded("untrusted_input")).toBe(true)
    for (const cls of EXTERNAL_DATA_CLASSES) {
      const attrs = EXTERNAL_DATA_CLASS_ATTRIBUTES[cls]
      expect(attrs.foldRebuildable).toBe(false)
      expect(attrs.entersSelfHeal).toBe(false)
      expect(attrs.trustLevel).toBe("untrusted")
      expect(attrs.provenanceRequired).toBe(true)
    }
  })
})

describe("assertProjectionRegistryComplete 三方等值门", () => {
  it("注册表为空时 fail-loud 报缺键", () => {
    expect(() => assertProjectionRegistryComplete()).toThrow(/key-set mismatch/)
    expect(() => assertProjectionRegistryComplete()).toThrow(/missing from registry/)
  })

  it("按 PROJECTION_CATEGORIES 全量注册后通过", () => {
    const entries: Record<string, ProjectionRegistryEntry> = {}
    for (const [id, category] of Object.entries(PROJECTION_CATEGORIES)) {
      entries[id] = { category, rebuildable: false, file: null }
    }
    registerProjections(entries)
    expect(() => assertProjectionRegistryComplete()).not.toThrow()
    expect(syncDirectWriteProjectionIds()).toEqual([])
    expect(isAutoRebuildableProjection("vector")).toBe(false)
  })
})

describe("loadProjectionStatusLedger 损坏 fail-loud 路径", () => {
  it("损坏 JSON → load 拒绝且绝不写盘（bytes 原样）", async () => {
    fsMocks.readFile.mockImplementation(async () => "{corrupt-json")
    await expect(loadProjectionStatusLedger("C:/proj")).rejects.toThrow("corrupt JSON")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })
})

describe("shouldRetryLedgerSave 重试谓词", () => {
  it("仅 attempt=0 可重试（首次失败恰再试 1 次）", () => {
    expect(shouldRetryLedgerSave(0)).toBe(true)
    expect(shouldRetryLedgerSave(1)).toBe(false)
    expect(shouldRetryLedgerSave(2)).toBe(false)
    expect(shouldRetryLedgerSave(-1)).toBe(false)
    expect(shouldRetryLedgerSave(0.5)).toBe(false)
    expect(shouldRetryLedgerSave(Number.NaN)).toBe(false)
    expect(LEDGER_SAVE_MAX_RETRIES).toBe(1)
  })
})

describe("R2-M03 removeChapterFromProjectionLedger 短锁删章清理", () => {
  it("删除目标章状态并保留其他章与审计日志，缺失章零写盘，坏 JSON fail-loud 拒写", async () => {
    let ledger = emptyLedger()
    ledger = recordProjectionStatus(ledger, 1, "cognition", "committed")
    ledger = recordProjectionStatus(ledger, 2, "cognition", "failed", "boom")
    let stored = JSON.stringify(ledger, null, 2)

    fsMocks.readFile.mockImplementation(async () => stored)
    fsMocks.writeFileAtomic.mockImplementation(async (_p: string, content: string) => {
      stored = content
    })

    await expect(removeChapterFromProjectionLedger("C:/proj", 2)).resolves.toBe(true)
    const after = JSON.parse(stored) as ProjectionStatusLedger
    expect(after.chapters["2"]).toBeUndefined()
    expect(after.chapters["1"]?.cognition?.status).toBe("committed")

    // 再次删除已不存在章节 → 零写盘返回 false
    fsMocks.writeFileAtomic.mockClear()
    await expect(removeChapterFromProjectionLedger("C:/proj", 2)).resolves.toBe(false)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()

    // 坏 JSON → 备份并 fail-loud 抛错，保留原字节不覆盖
    fsMocks.readFile.mockResolvedValueOnce("{corrupt-json")
    fsMocks.readFileAsBase64.mockResolvedValue({ base64: Buffer.from("{corrupt-json").toString("base64") })
    await expect(removeChapterFromProjectionLedger("C:/proj", 1)).rejects.toThrow("corrupt JSON; original ledger left unchanged")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })
})
