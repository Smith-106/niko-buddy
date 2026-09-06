/**
 * 64 号实施（63 号共识 §6 缺口 20）：Doctor — 整链诊断入口.
 *
 * 定位：集中健康检查——各子系统状态契约的确定性体检（status.json 唯一真源
 * 存在性、canon dual-write 配置、FTS 索引可重建、备份目录、预算账本一致性、
 * 卷弧状态）。判定层零 IO 零 LLM（ADR-19）；IO 收集层（runProjectDoctor）
 * 只读不写，绝不静默修复（只报告，修复由用户/命令显式执行）。
 *
 * 接线：mod.ts 导出（novel 域公共面），供 UI/命令层调用。
 */

import { readFile, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export type DoctorSeverity = "ok" | "warn" | "error"

export interface DoctorCheckInput {
  id: string
  name: string
  /** 机械判定（纯函数，确定性）。 */
  diagnose: (ctx: DoctorContext) => { severity: DoctorSeverity; message: string }
}

export interface DoctorContext {
  /** status.json 运行时唯一真源是否存在。 */
  statusJsonExists: boolean
  /** canon dual-write 是否已启用配置。 */
  canonDualWriteEnabled: boolean
  /** FTS 索引是否可加载（缺失 → warn 可重建）。 */
  ftsIndexReady: boolean
  /** 章节备份目录是否有产出。 */
  backupsPresent: boolean
  /** 预算账本任务集合。 */
  budgetTasks: readonly { taskId: string }[]
  /** 预算账本已完成集合。 */
  budgetCompleted: readonly string[]
  /** 卷弧状态（无卷 → null）。 */
  volumeArc: { volumeNumber: number; segment: string | null; completedInVolume: number } | null
  /** 额外注入的原始状态（诊断项可读）。 */
  extras: Readonly<Record<string, unknown>>
}

export interface DoctorFinding {
  id: string
  name: string
  severity: DoctorSeverity
  message: string
}

export interface DoctorReport {
  findings: DoctorFinding[]
  /** 全 ok → healthy；有 error → critical；否则 degraded。 */
  verdict: "healthy" | "degraded" | "critical"
}

// ── 内建诊断项（确定性机械规则） ──

const CHECK_STATUS_JSON: DoctorCheckInput = {
  id: "status-json",
  name: "会话状态唯一真源",
  diagnose: (ctx) =>
    ctx.statusJsonExists
      ? { severity: "ok", message: ".novel/status.json 存在（运行时唯一真源）" }
      : { severity: "error", message: ".novel/status.json 缺失——写作状态契约未初始化" },
}

const CHECK_CANON_DUAL_WRITE: DoctorCheckInput = {
  id: "canon-dual-write",
  name: "Canon 双写",
  diagnose: (ctx) =>
    ctx.canonDualWriteEnabled
      ? { severity: "ok", message: "canon dual-write 已启用（正式层写盘受控）" }
      : { severity: "warn", message: "canon dual-write 未启用——正式层写盘无门控" },
}

const CHECK_FTS_INDEX: DoctorCheckInput = {
  id: "fts-index",
  name: "FTS 索引",
  diagnose: (ctx) =>
    ctx.ftsIndexReady
      ? { severity: "ok", message: ".qmai/fts-index.json 可加载" }
      : { severity: "warn", message: "FTS 索引缺失/过期——运行重建（rebuildWikiFtsIndex）后可恢复" },
}

const CHECK_BACKUPS: DoctorCheckInput = {
  id: "chapter-backups",
  name: "章节备份",
  diagnose: (ctx) =>
    ctx.backupsPresent
      ? { severity: "ok", message: ".qmai/chapter-backups 有版本备份产出" }
      : { severity: "warn", message: "尚无章节备份——首次保存章节后自动产生" },
}

const CHECK_BUDGET_LEDGER: DoctorCheckInput = {
  id: "budget-ledger",
  name: "预算账本一致性",
  diagnose: (ctx) => {
    const allIds = new Set(ctx.budgetTasks.map((t) => t.taskId))
    const orphans = ctx.budgetCompleted.filter((id) => !allIds.has(id))
    if (orphans.length > 0) {
      return {
        severity: "error",
        message: `预算账本不一致：已完成集合含未知任务 ${orphans.join(", ")}`,
      }
    }
    return { severity: "ok", message: `预算账本一致（${ctx.budgetCompleted.length}/${ctx.budgetTasks.length} 完成）` }
  },
}

const CHECK_VOLUME_ARC: DoctorCheckInput = {
  id: "volume-arc",
  name: "卷弧状态",
  diagnose: (ctx) => {
    if (!ctx.volumeArc) return { severity: "ok", message: "尚无分卷（未规划卷弧）" }
    const seg = ctx.volumeArc.segment ?? "未开始"
    return {
      severity: "ok",
      message: `第${ctx.volumeArc.volumeNumber}卷 [${seg}] ${ctx.volumeArc.completedInVolume} 章`,
    }
  },
}

// ── 64 号实施（形态轴 P0-3/P0-4/P0-5）：新 leaf 挂载诊断 ──

const CHECK_FANFIC_MERGE_PENDING: DoctorCheckInput = {
  id: "fanfic-merge-pending",
  name: "同人正典合并 pending",
  diagnose: (ctx) => {
    const pending = ctx.extras["fanficMergePending"] as
      | { sourceBookId: string; mode: string } | null | undefined
    if (!pending) return { severity: "ok", message: "无悬挂的同人合并提案" }
    return {
      severity: "warn",
      message: `同人合并提案待处理（源书 ${pending.sourceBookId}，模式 ${pending.mode}）——accept 前不写正式 wiki`,
    }
  },
}

const CHECK_TRANSLATION_DRAFTS: DoctorCheckInput = {
  id: "translation-drafts",
  name: "翻译草稿区",
  diagnose: (ctx) => {
    const drafts = (ctx.extras["translationDraftCount"] as number | undefined) ?? 0
    return drafts > 0
      ? { severity: "ok", message: `.novel/translation-drafts 有 ${drafts} 章草稿（finalized 前不进正式层）` }
      : { severity: "ok", message: "尚无翻译草稿（未启用翻译 runner）" }
  },
}

const CHECK_PLAY_GRAPH: DoctorCheckInput = {
  id: "play-graph",
  name: "互动影游图",
  diagnose: (ctx) => {
    const errs = (ctx.extras["playGraphErrors"] as number | undefined) ?? 0
    return errs > 0
      ? { severity: "error", message: `互动影游图存在 ${errs} 个阻断诊断（missing_start/dangling_edge/empty_choice）` }
      : { severity: "ok", message: "互动影游图校验通过（或未配置 Play）" }
  },
}

export const DOCTOR_CHECKS: readonly DoctorCheckInput[] = [
  CHECK_STATUS_JSON,
  CHECK_CANON_DUAL_WRITE,
  CHECK_FTS_INDEX,
  CHECK_BACKUPS,
  CHECK_BUDGET_LEDGER,
  CHECK_VOLUME_ARC,
  CHECK_FANFIC_MERGE_PENDING,
  CHECK_TRANSLATION_DRAFTS,
  CHECK_PLAY_GRAPH,
]

/** 运行全部诊断（纯函数：ctx 由调用方注入，确定性同输入同输出）。 */
export function runDoctorDiagnostics(ctx: DoctorContext): DoctorReport {
  const findings = DOCTOR_CHECKS.map((check) => {
    const { severity, message } = check.diagnose(ctx)
    return { id: check.id, name: check.name, severity, message }
  })
  const hasError = findings.some((f) => f.severity === "error")
  const hasWarn = findings.some((f) => f.severity === "warn")
  const verdict: DoctorReport["verdict"] = hasError ? "critical" : hasWarn ? "degraded" : "healthy"
  return { findings, verdict }
}

/** 渲染诊断报告为文本（UI/命令层展示）。 */
export function formatDoctorReport(report: DoctorReport): string {
  const marks = { ok: "[OK]", warn: "[!]", error: "[X]" } as const
  const lines = report.findings.map((f) => `${marks[f.severity]} ${f.name}: ${f.message}`)
  return [`## 整链诊断（${report.verdict}）`, ...lines].join("\n")
}

// ── IO 收集层（只读） ──

/**
 * 收集项目状态并跑诊断（只读不写；缺失/读取失败 → 相应诊断降级而非崩溃）。
 */
export async function runProjectDoctor(
  projectPath: string,
  extras: Record<string, unknown> = {},
): Promise<DoctorReport> {
  const pp = normalizePath(projectPath)

  let statusJsonExists = false
  try {
    await readFile(`${pp}/.novel/status.json`)
    statusJsonExists = true
  } catch {
    statusJsonExists = false
  }

  let backupsPresent = false
  try {
    const tree = await listDirectory(`${pp}/.qmai/chapter-backups`)
    backupsPresent = tree.some((n) => !n.is_dir)
  } catch {
    backupsPresent = false
  }

  const ctx: DoctorContext = {
    statusJsonExists,
    canonDualWriteEnabled: extras.canonDualWriteEnabled === true,
    ftsIndexReady: extras.ftsIndexReady === true,
    backupsPresent,
    budgetTasks: Array.isArray(extras.budgetTasks) ? (extras.budgetTasks as { taskId: string }[]) : [],
    budgetCompleted: Array.isArray(extras.budgetCompleted) ? (extras.budgetCompleted as string[]) : [],
    volumeArc: extras.volumeArc && typeof extras.volumeArc === "object"
      ? (extras.volumeArc as DoctorContext["volumeArc"])
      : null,
    extras,
  }
  return runDoctorDiagnostics(ctx)
}
