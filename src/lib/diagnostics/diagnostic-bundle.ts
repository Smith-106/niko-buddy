/**
 * J15 诊断包 — 默认最小化 + 统一脱敏（承接 MAJOR-3）。
 *
 * 硬门禁映射：
 * - 门禁10（默认脱敏）：所有纳入字段经 `sanitizeForBundle` 过滤。
 * - 门禁11（导出前可预览范围）：`previewDiagnosticBundle` 列出
 *   将包含/将排除/已脱敏字段/保存位置，用户确认后才导出。
 * - 门禁12（凭据/敏感正文不入包）：EXCLUDED 清单 + 脱敏器双重保证。
 * - 门禁13（错误码关联 Run/资产/组件）：HealthItem.errorCode + 关联 id。
 * - 门禁14（重启后诊断可重算）：包内容全由 collectHealthReport 重算，
 *   不含会话内存态。
 *
 * 与散点脱敏的关系：本模块提供**统一诊断脱敏器**（ingest.ts:541/600 的
 * 内联正则 + PAT-DC1 纪律在此集中），供诊断包/日志预览/未来 snippet
 * 脱敏复用——不散布各自为政的正则。
 */

import type { HealthReport, HealthItem } from "./health-check"

// ── 脱敏器（统一，承接 MAJOR-3） ────────────────────────────────────────────

/** 诊断包/日志/snippet 通用脱敏：URL/凭据/路径/用户名 全部遮蔽。 */
export function sanitizeForBundle(input: string): string {
  let s = String(input ?? "")
  // URL（含 query/凭据段）
  s = s.replace(/https?:\/\/[^\s"'`)\]]+/gi, "[url]")
  // 凭据头/键值
  s = s.replace(
    /(Bearer|Authorization|api[-_]?key|apikey|token|secret|password|passwd|credential)\s*[:=]?\s*[^\s"'`)\],&]+/gi,
    "$1:[redacted]",
  )
  // Windows 绝对路径用户名段 C:/Users/<name>/ → C:/Users/[user]/
  s = s.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"'`]+/gi, "$1[user]")
  // POSIX 家目录 /home/<name>/ /Users/<name>/
  s = s.replace(/(\/(?:home|Users)\/)[^\/\s"'`]+/g, "$1[user]")
  // 裸 Bearer token / JWT-ish 长串
  s = s.replace(/\b(eyJ[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{8,}|[A-Fa-f0-9]{32,})\b/g, "[redacted]")
  return s
}

/** 深脱敏一个任意可 JSON 化对象的字符串字段（递归）。 */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") return sanitizeForBundle(value) as T
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v)) as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // 凭据类字段整体剔除（不只脱敏值——字段本身不进包）。
      if (/api[-_]?key|token|secret|password|credential|authorization|cookie/i.test(k)) {
        continue
      }
      out[k] = sanitizeDeep(v)
    }
    return out as T
  }
  return value
}

// ── 诊断包内容 ──────────────────────────────────────────────────────────────

/** 默认包含的字段（最小化）。 */
export interface DiagnosticBundle {
  schema: "niko-buddy/diagnostic-bundle@1"
  generatedAt: string
  /** 应用版本（无构建指纹/用户名）。 */
  appVersion: string
  /** OS/运行环境摘要。 */
  platform: string
  /** 项目结构摘要（目录计数，非正文）。 */
  project: {
    present: boolean
    /** 仅相对结构标记，不含绝对路径/正文。 */
    markers: string[]
  }
  /** 各组件健康项（已脱敏）。 */
  health: Array<{
    id: string
    status: string
    objectName: string
    userImpact: string
    suggestedAction: string
    autoRecoverable: boolean
    errorCode?: string
    checkedAt: string
    technicalDetail?: string // 已脱敏
  }>
  /** Run 状态摘要（无 userRequest 全文）。 */
  run: {
    status: string
    sessionId: string
    hasCurrentTask: boolean
  } | null
  /** 历史记录状态计数（计数非内容）。 */
  historyCounts: Record<string, number>
  /** 导出记录条目数（非内容）。 */
  exportEntryCount: number
}

/** 导出前预览：告知用户将包含/排除/脱敏了什么、保存到哪。 */
export interface DiagnosticBundlePreview {
  /** 将包含的顶层段。 */
  included: string[]
  /** 将排除的类别（明文声明）。 */
  excluded: string[]
  /** 已脱敏的字段类别。 */
  sanitizedFields: string[]
  /** 目标保存位置（相对项目根或用户选择）。 */
  targetPath: string
  /** 序列化后的字节数估计。 */
  approxBytes: number
  /** 实际包对象（供高级预览展开，已脱敏）。 */
  bundle: DiagnosticBundle
}

const INCLUDED_FIELDS = [
  "应用版本",
  "运行环境摘要",
  "项目结构标记（目录名计数）",
  "组件健康状态（status/影响/建议/错误码）",
  "Run 状态摘要（status/session_id）",
  "历史记录状态计数",
  "导出记录计数",
  "哈希与时间戳",
]

const EXCLUDED_FIELDS = [
  "API Key / 凭据 / Cookie / Authorization / Bearer token",
  "完整系统用户名与绝对路径",
  "项目与章节正文全文",
  "用户提示词全文",
  "未脱敏 Trace / retrieval 原文",
  "模型响应全文",
  "草稿正文 / pending 内容",
]

const SANITIZED_FIELD_CLASSES = [
  "URL 端点",
  "凭据键值（Bearer/api_key/token/secret/password）",
  "文件系统用户名与绝对路径",
  "技术详情中的路径/端点片段",
  "项目根绝对路径（→[project]）",
]

/** 转义正则特殊字符（项目根掩码用）。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 项目根掩码：把报告内残留的项目根绝对路径统一替换为 [project]。
 * 审计要求"不必要绝对路径（项目根→<project>）"默认排除——正斜杠与
 * 反斜杠两种写法都掩（Windows 路径两种分隔符混用常见）。
 */
function maskProjectRoot(s: string, projectPath: string): string {
  if (!projectPath) return s
  const fwd = projectPath.replace(/\\/g, "/")
  const back = fwd.replace(/\//g, "\\")
  let out = s
  for (const variant of new Set([fwd, back])) {
    if (variant) out = out.replace(new RegExp(escapeRegExp(variant), "g"), "[project]")
  }
  return out
}

/**
 * 构建脱敏诊断包。输入 HealthReport 已由 collectHealthReport 产出；
 * 本函数再做一遍深脱敏（纵深防御：即使上游某字段漏脱敏，包内也不出明文）。
 */
export function buildDiagnosticBundle(input: {
  report: HealthReport
  appVersion: string
  platform: string
  projectMarkers: string[]
  run?: { status: string; sessionId: string; hasCurrentTask: boolean } | null
  exportEntryCount: number
}): DiagnosticBundle {
  const { report } = input
  // 纵深防御第二层：先项目根掩码，再通用脱敏（顺序固定——掩码后的
  // [project] 不含敏感字符，不会被脱敏器二次改写）。
  const clean = (s: string) => sanitizeForBundle(maskProjectRoot(s, report.projectPath))
  const health = report.items.map((it: HealthItem) => ({
    id: it.id,
    status: it.status,
    objectName: it.objectName,
    userImpact: clean(it.userImpact),
    suggestedAction: clean(it.suggestedAction),
    autoRecoverable: it.autoRecoverable,
    errorCode: it.errorCode,
    checkedAt: it.checkedAt,
    technicalDetail: it.technicalDetail
      ? clean(it.technicalDetail)
      : undefined,
  }))

  const historyCounts: Record<string, number> = {}
  for (const it of report.items) {
    if (it.id === "history" && it.technicalDetail) {
      for (const m of it.technicalDetail.matchAll(
        /(available|source_missing|output_missing|partially_available|invalid)=(\d+)/g,
      )) {
        historyCounts[m[1]] = Number(m[2])
      }
    }
  }

  const run = input.run
    ? sanitizeDeep({
        status: input.run.status,
        sessionId: input.run.sessionId,
        hasCurrentTask: input.run.hasCurrentTask,
      })
    : null

  return {
    schema: "niko-buddy/diagnostic-bundle@1",
    generatedAt: new Date().toISOString(),
    appVersion: clean(input.appVersion),
    platform: clean(input.platform),
    project: {
      present: input.projectMarkers.length > 0,
      markers: input.projectMarkers.map((m) => clean(m)),
    },
    health,
    run,
    historyCounts,
    exportEntryCount: input.exportEntryCount,
  }
}

/** 导出前预览：返回将包含/排除/脱敏/目标路径 + 已脱敏包对象。 */
export function previewDiagnosticBundle(input: {
  bundle: DiagnosticBundle
  targetPath: string
}): DiagnosticBundlePreview {
  const json = JSON.stringify(input.bundle, null, 2)
  return {
    included: INCLUDED_FIELDS,
    excluded: EXCLUDED_FIELDS,
    sanitizedFields: SANITIZED_FIELD_CLASSES,
    targetPath: input.targetPath,
    approxBytes: new Blob([json]).size,
    bundle: input.bundle,
  }
}

/** 序列化诊断包为可写文件内容（导出层写盘由调用方控制）。 */
export function serializeDiagnosticBundle(bundle: DiagnosticBundle): string {
  return JSON.stringify(bundle, null, 2)
}
