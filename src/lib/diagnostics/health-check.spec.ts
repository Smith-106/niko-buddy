// @vitest-environment node
/**
 * health-check.spec.ts — J15 统一健康聚合的错误面契约。
 *
 * 建文件理由：diagnostics.spec.ts 只走全健康路径，各检测器 catch（读失败→
 * unknown/unavailable）与索引恢复动作 run() 从未被执行（11 行缺口）。
 * 本文件在模块边界 mock，直接命中每条 catch 与恢复执行体。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, fileExists: vi.fn(async () => true) }
})

vi.mock("@/lib/novel/novel-session-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/novel-session-status")>()
  return { ...actual, loadNovelSessionStatus: vi.fn(async () => null) }
})

vi.mock("@/lib/export/export-history-view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export/export-history-view")>()
  return { ...actual, loadExportHistoryView: vi.fn(async () => []) }
})

vi.mock("@/lib/novel/fts-index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/fts-index")>()
  return {
    ...actual,
    loadFtsIndex: vi.fn(async () => ({ docs: {}, builtAt: "2026-01-01T00:00:00.000Z" })),
    rebuildWikiFtsIndex: vi.fn(async () => ({ indexed: 5, errors: [] as string[] })),
  }
})

vi.mock("@/lib/platform", () => ({ isTauri: vi.fn(() => false) }))

vi.mock("@/lib/quality/golden-baseline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quality/golden-baseline")>()
  return { ...actual, structuralFingerprint: vi.fn((...args: []) => actual.structuralFingerprint(...args)) }
})

import { fileExists } from "@/commands/fs"
import { loadNovelSessionStatus } from "@/lib/novel/novel-session-status"
import { loadExportHistoryView } from "@/lib/export/export-history-view"
import { loadFtsIndex, rebuildWikiFtsIndex } from "@/lib/novel/fts-index"
import { isTauri } from "@/lib/platform"
import { structuralFingerprint } from "@/lib/quality/golden-baseline"
import { collectHealthReport } from "./health-check"

const itemOf = (report: Awaited<ReturnType<typeof collectHealthReport>>, id: string) =>
  report.items.find((i) => i.id === id)!

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fileExists).mockResolvedValue(true)
  vi.mocked(loadNovelSessionStatus).mockResolvedValue(null)
  vi.mocked(loadExportHistoryView).mockResolvedValue([])
  vi.mocked(loadFtsIndex).mockResolvedValue({ docs: {}, builtAt: "2026-01-01T00:00:00.000Z" } as never)
  vi.mocked(rebuildWikiFtsIndex).mockResolvedValue({ indexed: 5, errors: [] })
  vi.mocked(isTauri).mockReturnValue(false)
  vi.mocked(structuralFingerprint).mockImplementation(() => '["Consistency(P0)","Anti-AI(P1)","Quality(P2)"]')
})

describe("collectHealthReport 全健康基线", () => {
  it("七项齐全、run 空会话诚实 healthy（llm 未配置 → overall 随最差项为 degraded）", async () => {
    const report = await collectHealthReport({ projectPath: "/p/book", llmCfg: null })
    expect(report.items.map((i) => i.id)).toEqual(
      expect.arrayContaining(["llm", "run", "history", "search_index", "project_fs", "version", "runtime"]),
    )
    // worst 聚合：llm 未配置=degraded 拉低 overall（门禁：最差项决定）
    expect(itemOf(report, "llm").status).toBe("degraded")
    expect(report.overall).toBe("degraded")
    expect(itemOf(report, "run").status).toBe("healthy")
    expect(itemOf(report, "version").status).toBe("healthy")
  })
})

describe("各检测器读失败 → unknown/unavailable（门禁4）", () => {
  it("status.json 读取抛错 → run=unknown(RUN_STATUS_UNREADABLE)，version 内层同步 attention", async () => {
    vi.mocked(loadNovelSessionStatus).mockRejectedValue(new Error("status corrupt"))
    const report = await collectHealthReport({ projectPath: "/p/book", llmCfg: null })
    const run = itemOf(report, "run")
    expect(run.status).toBe("unknown")
    expect(run.errorCode).toBe("RUN_STATUS_UNREADABLE")
    expect(run.userImpact).toContain("无法读取写作会话状态")
    // 同一故障同步命中 version 内层 catch：schemaOk=false → attention_required
    const version = itemOf(report, "version")
    expect(version.status).toBe("attention_required")
    expect(version.errorCode).toBe("SCHEMA_VERSION_MISMATCH")
  })

  it("导出历史读取抛错 → history=unknown(HISTORY_UNREADABLE)", async () => {
    vi.mocked(loadExportHistoryView).mockRejectedValue(new Error("history gone"))
    const report = await collectHealthReport({ projectPath: "/p/book", llmCfg: null })
    const history = itemOf(report, "history")
    expect(history.status).toBe("unknown")
    expect(history.errorCode).toBe("HISTORY_UNREADABLE")
  })

  it("索引读取抛错 → search_index=unknown(INDEX_CHECK_FAILED)，恢复动作可执行", async () => {
    vi.mocked(loadFtsIndex).mockRejectedValue(new Error("fts corrupt"))
    const report = await collectHealthReport({ projectPath: "/p/book", llmCfg: null })
    const index = itemOf(report, "search_index")
    expect(index.status).toBe("unknown")
    expect(index.errorCode).toBe("INDEX_CHECK_FAILED")
    expect(index.autoRecoverable).toBe(true)
    const recovery = index.recoveries.find((r) => r.id === "rebuild-fts")!
    expect(recovery.level).toBe("auto")
    expect(recovery.idempotent).toBe(true)
    const result = await recovery.run!()
    expect(result).toEqual({ ok: true, detail: "indexed=5" })
    expect(rebuildWikiFtsIndex).toHaveBeenCalledWith("/p/book")
  })

  it("重建索引失败 → 恢复返回 ok=false 计数（errors 非零）", async () => {
    vi.mocked(loadFtsIndex).mockRejectedValue(new Error("fts corrupt"))
    vi.mocked(rebuildWikiFtsIndex).mockResolvedValue({ indexed: 2, errors: ["shard-3"] })
    const report = await collectHealthReport({ projectPath: "/p/book", llmCfg: null })
    const result = await itemOf(report, "search_index").recoveries[0]!.run!()
    expect(result).toEqual({ ok: false, detail: "indexed=2" })
  })

  it("目录探测抛错 → project_fs=unavailable(PROJECT_UNREACHABLE)", async () => {
    vi.mocked(fileExists).mockImplementation(() => {
      throw new Error("EACCES")
    })
    const report = await collectHealthReport({ projectPath: "/p/book", llmCfg: null })
    const fs = itemOf(report, "project_fs")
    expect(fs.status).toBe("unavailable")
    expect(fs.errorCode).toBe("PROJECT_UNREACHABLE")
    expect(report.overall).toBe("unavailable")
  })

  it("指纹计算抛错 → version=unknown(VERSION_CHECK_FAILED)", async () => {
    vi.mocked(structuralFingerprint).mockImplementation(() => {
      throw new Error("fingerprint down")
    })
    const report = await collectHealthReport({ projectPath: "/p/book", llmCfg: null })
    const version = itemOf(report, "version")
    expect(version.status).toBe("unknown")
    expect(version.errorCode).toBe("VERSION_CHECK_FAILED")
  })

  it("Tauri 探测同步抛错 → runtime=unavailable(RUNTIME_PROBE_FAILED)", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(fileExists).mockImplementation(() => {
      throw new Error("ipc down")
    })
    const report = await collectHealthReport({ projectPath: "/p/book", llmCfg: null })
    const runtime = itemOf(report, "runtime")
    expect(runtime.status).toBe("unavailable")
    expect(runtime.errorCode).toBe("RUNTIME_PROBE_FAILED")
  })
})
