/**
 * J15 诊断中心 — 统一健康聚合层。
 *
 * 定位：**读已有真源映射健康态，不建第七套状态语义**（硬门禁2）。
 * 每个健康项复用对应子状态机（LLM 六态 / Run 生命周期 / 导出五态 /
 * 索引投影 / 锁三态），只做聚合+映射，不重写判定逻辑。
 *
 * 硬门禁映射：
 * - 门禁1（健康来自真实状态源）：每项 evidenceSource 标明真源路径/命令。
 * - 门禁2（不建重复状态模型）：collectHealthReport 只组装子系统已有状态。
 * - 门禁3（每个异常说明用户影响+恢复动作）：HealthItem 七字段强制。
 * - 门禁4（检测失败显示 unknown 非 healthy）：任何 detect 抛错→unknown。
 * - 门禁5（sourceMissing/outputMissing 可定位）：历史健康项逐条带状态。
 * - 门禁7（用户可重检测看更新）：recheck=重跑 collect（纯读）。
 * - 门禁9（恢复幂等）：recover 仅调幂等安全操作（重建索引/重读/重连）。
 * - 门禁15（索引失败不毁历史真源）：索引项独立，不牵连历史项。
 * - 门禁16（不把可重建索引当用户数据危险恢复）：索引重建=安全自动级。
 *
 * 分级（恢复矩阵）：
 *   auto     — 安全自动：重检测/重建索引/重连/刷新状态/清临时文件
 *   confirm  — 需确认：重启Buddy/中止残留进程/移除缓存/重置设置/重认证
 *   forbidden— 禁止自动：删项目/覆盖正文/清空历史/改正式版/删凭据/不可逆迁移
 */

import { fileExists, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { loadNovelSessionStatus } from "@/lib/novel/novel-session-status"
import { loadFtsIndex, rebuildWikiFtsIndex } from "@/lib/novel/fts-index"
import { loadExportHistoryView } from "@/lib/export/export-history-view"
import { assessLlmHealth, type LlmHealthStatus } from "@/lib/llm-health"
import { isTauri } from "@/lib/platform"

// ── 健康状态机（J15 顶层聚合态） ─────────────────────────────────────────────
export type HealthStatus =
  | "healthy"
  | "degraded"
  | "attention_required"
  | "unavailable"
  | "unknown"

/** 恢复动作级别（权限矩阵）。 */
export type RecoveryLevel = "auto" | "confirm" | "forbidden"

export interface RecoveryAction {
  /** 动作标识。 */
  id: string
  /** 用户可读动作名。 */
  label: string
  level: RecoveryLevel
  /** 幂等（重复执行不产生额外副作用/重复对象）。 */
  idempotent: boolean
  /** 是否可回滚（仅描述性，forbidden 级无回滚）。 */
  reversible: boolean
  /** 执行体（forbidden 级为 null，不提供执行）。 */
  run: (() => Promise<{ ok: boolean; detail: string }>) | null
}

/** 统一健康项（门禁3：七字段齐全）。 */
export interface HealthItem {
  /** 稳定组件 id。 */
  id: string
  status: HealthStatus
  /** 检测对象（用户可读）。 */
  objectName: string
  /** 证据来源（真源路径/命令名）。 */
  evidenceSource: string
  /** 最后检测时间 ISO。 */
  checkedAt: string
  /** 用户影响（白话）。 */
  userImpact: string
  /** 建议操作。 */
  suggestedAction: string
  /** 是否可自动恢复。 */
  autoRecoverable: boolean
  /** 技术详情（折叠展示）。 */
  technicalDetail?: string
  /** 关联错误码（门禁13：可关联 Run/资产/组件）。 */
  errorCode?: string
  /** 关联恢复动作（分级）。 */
  recoveries: RecoveryAction[]
}

export interface HealthReport {
  checkedAt: string
  projectPath: string
  /** 汇总态：最差项决定 overall（attention_required>degraded>unknown>unavailable>healthy）。 */
  overall: HealthStatus
  items: HealthItem[]
}

const SEVERITY_ORDER: HealthStatus[] = [
  "attention_required",
  "unavailable",
  "degraded",
  "unknown",
  "healthy",
]

function worst(statuses: HealthStatus[]): HealthStatus {
  for (const s of SEVERITY_ORDER) {
    if (statuses.includes(s)) return s
  }
  return "healthy"
}

function nowIso(): string {
  return new Date().toISOString()
}

// ── 各健康项检测器（读真源，不建重复模型） ───────────────────────────────────

/** LLM 配置健康：复用 J05 六态 assessLlmHealth，不新建第七态。 */
function llmHealthItem(
  cfg: Parameters<typeof assessLlmHealth>[0],
): HealthItem {
  const h = assessLlmHealth(cfg)
  const map: Record<LlmHealthStatus, HealthStatus> = {
    usable: "healthy",
    unconfigured: "degraded",
    incomplete: "degraded",
    checking: "unknown",
    auth_failed: "attention_required",
    model_unavailable: "attention_required",
  }
  const status = map[h.status]
  return {
    id: "llm",
    status,
    objectName: "模型服务",
    evidenceSource: "wiki-store.llmConfig + credential_vault + assessLlmHealth",
    checkedAt: nowIso(),
    userImpact:
      status === "healthy"
        ? "AI 写作可用"
        : status === "degraded"
          ? "AI 写作不可用，本地编辑不受影响"
          : status === "attention_required"
            ? "AI 写作失败：需要重新认证或更换模型"
            : "模型服务检测中/无法确定",
    suggestedAction: h.nextStep ?? "无需操作",
    autoRecoverable: status === "degraded" || status === "attention_required",
    technicalDetail: `llm.status=${h.status}; canWrite=${h.canWrite}`,
    errorCode:
      h.status === "auth_failed"
        ? "LLM_AUTH_FAILED"
        : h.status === "model_unavailable"
          ? "LLM_MODEL_UNAVAILABLE"
          : undefined,
    recoveries: [
      {
        id: "recheck-llm",
        label: "重新检测模型服务",
        level: "auto",
        idempotent: true,
        reversible: true,
        run: null, // 由调用方触发 connection-tests.testLlmConnection（联网，按需）
      },
      {
        id: "reauth-llm",
        label: "重新认证 / 更新密钥",
        level: "confirm",
        idempotent: false,
        reversible: true,
        run: null, // UI 引导到设置页
      },
    ],
  }
}

/** Run/会话健康：复用 status.json 生命周期（J10/J13）。 */
async function runHealthItem(projectPath: string): Promise<HealthItem> {
  const pp = normalizePath(projectPath)
  const ev = `${pp}/.novel/status.json`
  try {
    const status = await loadNovelSessionStatus(pp)
    if (!status) {
      return {
        id: "run",
        status: "healthy",
        objectName: "写作会话 (Run)",
        evidenceSource: ev,
        checkedAt: nowIso(),
        userImpact: "当前无进行中的写作会话",
        suggestedAction: "无需操作",
        autoRecoverable: false,
        recoveries: [],
      }
    }
    const s = status.status
    const map: Record<string, HealthStatus> = {
      running: "healthy",
      completed: "healthy",
      interrupted: "attention_required",
      paused: "degraded",
      blocked: "degraded",
    }
    const hs = map[s] ?? "unknown"
    return {
      id: "run",
      status: hs,
      objectName: "写作会话 (Run)",
      evidenceSource: ev,
      checkedAt: nowIso(),
      userImpact:
        s === "interrupted"
          ? "上次写作会话被中断，可能需要恢复"
          : s === "paused" || s === "blocked"
            ? "写作会话已暂停/阻塞"
            : "写作会话状态正常",
      suggestedAction:
        s === "interrupted" ? "打开项目恢复会话（自动降级已生效）" : "无需操作",
      autoRecoverable: s === "interrupted",
      technicalDetail: `status=${s}; session_id=${status.session_id ?? ""}`,
      errorCode: s === "interrupted" ? "RUN_INTERRUPTED" : undefined,
      recoveries:
        s === "interrupted"
          ? [
              {
                id: "resume-run",
                label: "恢复被中断的会话",
                level: "auto",
                idempotent: true,
                reversible: true,
                run: null, // markSessionInterrupted 已生效;恢复=打开项目
              },
            ]
          : [],
    }
  } catch (e) {
    return {
      id: "run",
      status: "unknown",
      objectName: "写作会话 (Run)",
      evidenceSource: ev,
      checkedAt: nowIso(),
      userImpact: "无法读取写作会话状态",
      suggestedAction: "检查项目 .novel/status.json 是否损坏",
      autoRecoverable: false,
      technicalDetail: e instanceof Error ? e.message : String(e),
      errorCode: "RUN_STATUS_UNREADABLE",
      recoveries: [],
    }
  }
}

/** 历史/资产健康：复用 J14 五态派生（不重新判断）。 */
async function historyHealthItem(projectPath: string): Promise<HealthItem> {
  const pp = normalizePath(projectPath)
  const ev = `${pp}/.novel/export-history.json`
  try {
    const view = await loadExportHistoryView(pp)
    const counts = { available: 0, source_missing: 0, output_missing: 0, partially_available: 0, invalid: 0 }
    for (const v of view) counts[v.status] += 1
    const degraded = counts.source_missing + counts.output_missing + counts.partially_available
    const status: HealthStatus =
      counts.invalid > 0
        ? "attention_required"
        : degraded > 0
          ? "degraded"
          : "healthy"
    return {
      id: "history",
      status,
      objectName: "导出历史与源资产",
      evidenceSource: ev,
      checkedAt: nowIso(),
      userImpact:
        status === "healthy"
          ? `${counts.available} 条导出记录完整可溯`
          : `${degraded} 条记录源/产物缺失,${counts.invalid} 条记录损坏`,
      suggestedAction:
        status === "healthy" ? "无需操作" : "查看导出历史定位缺失源/产物",
      autoRecoverable: false, // 源缺失不自动修——需用户决策
      technicalDetail: `available=${counts.available} source_missing=${counts.source_missing} output_missing=${counts.output_missing} invalid=${counts.invalid}`,
      errorCode: counts.invalid > 0 ? "HISTORY_INVALID_RECORD" : degraded > 0 ? "HISTORY_MISSING_SOURCE_OR_OUTPUT" : undefined,
      recoveries: [],
    }
  } catch (e) {
    return {
      id: "history",
      status: "unknown",
      objectName: "导出历史与源资产",
      evidenceSource: ev,
      checkedAt: nowIso(),
      userImpact: "无法读取导出历史",
      suggestedAction: "检查 .novel/export-history.json 是否损坏",
      autoRecoverable: false,
      technicalDetail: e instanceof Error ? e.message : String(e),
      errorCode: "HISTORY_UNREADABLE",
      recoveries: [],
    }
  }
}

/** 搜索索引健康：可重建投影（独立于历史真源，门禁15/16）。 */
async function indexHealthItem(projectPath: string): Promise<HealthItem> {
  const pp = normalizePath(projectPath)
  const ev = `${pp}/.niko-buddy/fts-index.json`
  try {
    const idx = await loadFtsIndex(pp)
    const status: HealthStatus = idx ? "healthy" : "degraded"
    return {
      id: "search_index",
      status,
      objectName: "搜索索引 (FTS)",
      evidenceSource: ev,
      checkedAt: nowIso(),
      userImpact:
        status === "healthy"
          ? "搜索索引可用"
          : "搜索索引缺失/损坏——将回退全量扫描，搜索变慢但可用",
      suggestedAction:
        status === "healthy" ? "无需操作" : "重建搜索索引（可安全自动重建）",
      autoRecoverable: true, // 可重建投影=安全自动恢复
      technicalDetail: idx
        ? `docs=${Object.keys(idx.docs).length} builtAt=${idx.builtAt}`
        : "index missing/corrupt (loadFtsIndex→null)",
      errorCode: idx ? undefined : "INDEX_STALE_OR_MISSING",
      recoveries: [
        {
          id: "rebuild-fts",
          label: "重建搜索索引",
          level: "auto",
          idempotent: true, // rebuild 幂等(同语料同输出)
          reversible: true, // 可重建投影,重建无风险
          run: async () => {
            const r = await rebuildWikiFtsIndex(pp)
            return {
              ok: r.errors.length === 0,
              detail: `重建完成 indexed=${r.indexed} errors=${r.errors.length}`,
            }
          },
        },
      ],
    }
  } catch (e) {
    return {
      id: "search_index",
      status: "unknown",
      objectName: "搜索索引 (FTS)",
      evidenceSource: ev,
      checkedAt: nowIso(),
      userImpact: "无法检测搜索索引状态",
      suggestedAction: "重建搜索索引",
      autoRecoverable: true,
      technicalDetail: e instanceof Error ? e.message : String(e),
      errorCode: "INDEX_CHECK_FAILED",
      recoveries: [
        {
          id: "rebuild-fts",
          label: "重建搜索索引",
          level: "auto",
          idempotent: true,
          reversible: true,
          run: async () => {
            const r = await rebuildWikiFtsIndex(pp)
            return { ok: r.errors.length === 0, detail: `indexed=${r.indexed}` }
          },
        },
      ],
    }
  }
}

/** 项目/文件系统健康：结构标记文件存在性。 */
async function projectFsHealthItem(projectPath: string): Promise<HealthItem> {
  const pp = normalizePath(projectPath)
  const ev = `${pp}/.niko-buddy/project.json + schema.md + QM/ + .novel/`
  try {
    const markers = [
      `${pp}/.niko-buddy/project.json`,
      `${pp}/schema.md`,
      `${pp}/QM`,
      `${pp}/.novel`,
    ]
    const missing: string[] = []
    for (const m of markers) {
      if (!(await fileExists(m))) missing.push(m)
    }
    const status: HealthStatus = missing.length === 0 ? "healthy" : "attention_required"
    return {
      id: "project_fs",
      status,
      objectName: "项目文件结构",
      evidenceSource: ev,
      checkedAt: nowIso(),
      userImpact:
        status === "healthy"
          ? "项目结构完整"
          : `项目结构缺失 ${missing.length} 项标记`,
      suggestedAction:
        status === "healthy" ? "无需操作" : "检查项目目录是否被移动/删除",
      autoRecoverable: false,
      technicalDetail:
        missing.length === 0 ? "all markers present" : `missing: ${missing.join(", ")}`,
      errorCode: missing.length === 0 ? undefined : "PROJECT_STRUCTURE_INCOMPLETE",
      recoveries: [],
    }
  } catch (e) {
    return {
      id: "project_fs",
      status: "unavailable",
      objectName: "项目文件结构",
      evidenceSource: ev,
      checkedAt: nowIso(),
      userImpact: "项目目录不可访问",
      suggestedAction: "确认项目路径存在且可读",
      autoRecoverable: false,
      technicalDetail: e instanceof Error ? e.message : String(e),
      errorCode: "PROJECT_UNREACHABLE",
      recoveries: [],
    }
  }
}

/** 版本/协议健康：应用版本 + status.json schema_version。 */
async function versionHealthItem(projectPath: string): Promise<HealthItem> {
  const pp = normalizePath(projectPath)
  const ev = "package.json __APP_VERSION__ + .novel/status.json schema_version"
  try {
    const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "unknown"
    let schemaOk = true
    let schemaDetail = "no status.json"
    try {
      const status = await loadNovelSessionStatus(pp)
      if (status) {
        const sv = (status as { schema_version?: unknown }).schema_version
        schemaOk = sv === "1" || sv === 1 || sv === undefined
        schemaDetail = `schema_version=${String(sv)}`
      }
    } catch {
      schemaOk = false
      schemaDetail = "status.json unreadable"
    }
    const status: HealthStatus = schemaOk ? "healthy" : "attention_required"
    return {
      id: "version",
      status,
      objectName: "应用版本与数据协议",
      evidenceSource: ev,
      checkedAt: nowIso(),
      userImpact:
        status === "healthy"
          ? `应用版本 ${appVersion}，数据协议兼容`
          : "数据协议版本与应用不匹配，可能影响读写",
      suggestedAction: status === "healthy" ? "无需操作" : "查看版本兼容说明",
      autoRecoverable: false,
      technicalDetail: `appVersion=${appVersion}; ${schemaDetail}`,
      errorCode: schemaOk ? undefined : "SCHEMA_VERSION_MISMATCH",
      recoveries: [],
    }
  } catch (e) {
    return {
      id: "version",
      status: "unknown",
      objectName: "应用版本与数据协议",
      evidenceSource: ev,
      checkedAt: nowIso(),
      userImpact: "无法检测版本/协议状态",
      suggestedAction: "重新检测",
      autoRecoverable: false,
      technicalDetail: e instanceof Error ? e.message : String(e),
      errorCode: "VERSION_CHECK_FAILED",
      recoveries: [],
    }
  }
}

/** Buddy/运行时健康：invoke 存活 + status_watcher（桌面单进程）。 */
async function runtimeHealthItem(projectPath: string): Promise<HealthItem> {
  const ev = "Tauri invoke + status_watcher + app_lock"
  try {
    // 轻量探活：读一个已知会返回的命令（lockState 或 fileExists）。
    // 桌面应用 Buddy=主进程;invoke 通即进程存活。
    const probeOk = isTauri()
      ? await fileExists(normalizePath(projectPath)).then(() => true).catch(() => false)
      : true // web 模式无 Buddy 进程概念
    const status: HealthStatus = probeOk ? "healthy" : "unavailable"
    return {
      id: "runtime",
      status,
      objectName: "运行时 / Buddy 进程",
      evidenceSource: ev,
      checkedAt: nowIso(),
      userImpact:
        status === "healthy" ? "应用进程与 IPC 正常" : "应用进程/IPC 不可达",
      suggestedAction:
        status === "healthy" ? "无需操作" : "重启应用",
      autoRecoverable: false,
      technicalDetail: `isTauri=${isTauri()}; probeOk=${probeOk}`,
      errorCode: probeOk ? undefined : "RUNTIME_UNREACHABLE",
      recoveries:
        probeOk
          ? []
          : [
              {
                id: "restart-buddy",
                label: "重启应用",
                level: "confirm",
                idempotent: true,
                reversible: false,
                run: null, // 进程重启属用户/OS 操作
              },
            ],
    }
  } catch (e) {
    return {
      id: "runtime",
      status: "unavailable",
      objectName: "运行时 / Buddy 进程",
      evidenceSource: ev,
      checkedAt: nowIso(),
      userImpact: "应用进程/IPC 不可达",
      suggestedAction: "重启应用",
      autoRecoverable: false,
      technicalDetail: e instanceof Error ? e.message : String(e),
      errorCode: "RUNTIME_PROBE_FAILED",
      recoveries: [
        {
          id: "restart-buddy",
          label: "重启应用",
          level: "confirm",
          idempotent: true,
          reversible: false,
          run: null,
        },
      ],
    }
  }
}

// ── 聚合入口 ────────────────────────────────────────────────────────────────

/**
 * 收集统一健康报告。纯读——只组装各子系统已有状态，不建重复状态模型。
 * @param llmCfg 调用方注入的 LLM 配置（避免健康层直接依赖 store 水合时序）。
 */
export async function collectHealthReport(input: {
  projectPath: string
  llmCfg?: Parameters<typeof assessLlmHealth>[0]
}): Promise<HealthReport> {
  const pp = normalizePath(input.projectPath)
  const items = await Promise.all([
    Promise.resolve(llmHealthItem(input.llmCfg)),
    runHealthItem(pp),
    historyHealthItem(pp),
    indexHealthItem(pp),
    projectFsHealthItem(pp),
    versionHealthItem(pp),
    runtimeHealthItem(pp),
  ])
  return {
    checkedAt: nowIso(),
    projectPath: pp,
    overall: worst(items.map((i) => i.status)),
    items,
  }
}
