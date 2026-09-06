import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("ENOENT")
  }),
  listDirectory: vi.fn(async () => []),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  listDirectory: fsMocks.listDirectory,
}))

import {
  DOCTOR_CHECKS,
  formatDoctorReport,
  runDoctorDiagnostics,
  runProjectDoctor,
  type DoctorContext,
} from "./doctor"

const HEALTHY: DoctorContext = {
  statusJsonExists: true,
  canonDualWriteEnabled: true,
  ftsIndexReady: true,
  backupsPresent: true,
  budgetTasks: [{ taskId: "a" }, { taskId: "b" }],
  budgetCompleted: ["a"],
  volumeArc: { volumeNumber: 1, segment: "承", completedInVolume: 4 },
  extras: {},
}

beforeEach(() => {
  fsMocks.readFile.mockReset()
  fsMocks.readFile.mockImplementation(async () => {
    throw new Error("ENOENT")
  })
  fsMocks.listDirectory.mockReset()
  fsMocks.listDirectory.mockImplementation(async () => [])
})

describe("doctor (64 号实施：整链诊断入口)", () => {
  it("健康态 → healthy 零错误", () => {
    const report = runDoctorDiagnostics(HEALTHY)
    expect(report.verdict).toBe("healthy")
    expect(report.findings.every((f) => f.severity === "ok")).toBe(true)
  })

  it("status.json 缺失 → critical", () => {
    const report = runDoctorDiagnostics({ ...HEALTHY, statusJsonExists: false })
    expect(report.verdict).toBe("critical")
    expect(report.findings.find((f) => f.id === "status-json")?.severity).toBe("error")
  })

  it("FTS 索引缺失 → degraded（可重建）", () => {
    const report = runDoctorDiagnostics({ ...HEALTHY, ftsIndexReady: false })
    expect(report.verdict).toBe("degraded")
    expect(report.findings.find((f) => f.id === "fts-index")?.message).toContain("重建")
  })

  it("canon dual-write 未启用 → warn 不升 critical", () => {
    const report = runDoctorDiagnostics({ ...HEALTHY, canonDualWriteEnabled: false })
    expect(report.verdict).toBe("degraded")
    expect(report.findings.find((f) => f.id === "canon-dual-write")?.severity).toBe("warn")
  })

  it("预算账本孤儿任务 → critical", () => {
    const report = runDoctorDiagnostics({
      ...HEALTHY,
      budgetCompleted: ["a", "ghost"],
    })
    expect(report.verdict).toBe("critical")
    expect(report.findings.find((f) => f.id === "budget-ledger")?.message).toContain("ghost")
  })

  it("无分卷 → ok（不算错误）", () => {
    const report = runDoctorDiagnostics({ ...HEALTHY, volumeArc: null })
    expect(report.findings.find((f) => f.id === "volume-arc")?.severity).toBe("ok")
  })

  it("确定性：同输入双跑全等", () => {
    const a = runDoctorDiagnostics(HEALTHY)
    const b = runDoctorDiagnostics(HEALTHY)
    expect(a).toEqual(b)
  })

  it("formatDoctorReport：渲染 verdict 与各发现", () => {
    const text = formatDoctorReport(runDoctorDiagnostics({ ...HEALTHY, ftsIndexReady: false }))
    expect(text).toContain("degraded")
    expect(text).toContain("[!] FTS 索引")
  })

  it("runProjectDoctor：status.json 存在 + 无备份 → degraded", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("status.json")) return "{}"
      throw new Error("ENOENT")
    })
    fsMocks.listDirectory.mockImplementation(async () => [])
    const report = await runProjectDoctor("/proj", { canonDualWriteEnabled: true, ftsIndexReady: true })
    expect(report.findings.find((f) => f.id === "status-json")?.severity).toBe("ok")
    expect(report.findings.find((f) => f.id === "chapter-backups")?.severity).toBe("warn")
  })

  it("runProjectDoctor：全缺失 → critical 不崩溃", async () => {
    const report = await runProjectDoctor("/proj")
    expect(report.verdict).toBe("critical")
    expect(report.findings.find((f) => f.id === "status-json")?.severity).toBe("error")
  })
})

describe("形态轴新 leaf 挂载诊断 (64 号实施：P0-3/P0-4/P0-5 接线)", () => {
  const base = (extras: Record<string, unknown> = {}): DoctorContext => ({
    statusJsonExists: true,
    canonDualWriteEnabled: true,
    ftsIndexReady: true,
    backupsPresent: true,
    budgetTasks: [],
    budgetCompleted: [],
    volumeArc: null,
    extras,
  })

  it("fanfic-merge-pending：无提案 → ok；有悬挂提案 → warn", () => {
    const clean = runDoctorDiagnostics(base())
    expect(clean.findings.find((f) => f.id === "fanfic-merge-pending")?.severity).toBe("ok")
    const pending = runDoctorDiagnostics(
      base({ fanficMergePending: { sourceBookId: "book-9", mode: "au" } }),
    )
    const finding = pending.findings.find((f) => f.id === "fanfic-merge-pending")
    expect(finding?.severity).toBe("warn")
    expect(finding?.message).toContain("accept 前不写正式 wiki")
  })

  it("translation-drafts：草稿计数注入 → ok 文案", () => {
    const r = runDoctorDiagnostics(base({ translationDraftCount: 3 }))
    const finding = r.findings.find((f) => f.id === "translation-drafts")
    expect(finding?.severity).toBe("ok")
    expect(finding?.message).toContain("3 章草稿")
  })

  it("play-graph：图错误注入 → error 阻断；无错误 → ok", () => {
    const bad = runDoctorDiagnostics(base({ playGraphErrors: 2 }))
    expect(bad.findings.find((f) => f.id === "play-graph")?.severity).toBe("error")
    expect(bad.verdict).toBe("critical")
    const good = runDoctorDiagnostics(base())
    expect(good.findings.find((f) => f.id === "play-graph")?.severity).toBe("ok")
  })

  it("三个新检查项已注册在 DOCTOR_CHECKS", () => {
    const ids = DOCTOR_CHECKS.map((c) => c.id)
    expect(ids).toContain("fanfic-merge-pending")
    expect(ids).toContain("translation-drafts")
    expect(ids).toContain("play-graph")
  })
})
