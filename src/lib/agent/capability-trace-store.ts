/**
 * 能力规划 Trace 持久化（L3 → Capability Learning 数据层）.
 *
 * 把每次 Capability Planner 的决策落盘成 append-only JSONL，累积成
 * 「用户意图 → 最佳能力链」数据集——这是后续 Capability Selector /
 * 离线偏好学习（哪些能力组合最成功、哪些被频繁放弃、哪些规划常失败）
 * 的原料。
 *
 * 落盘契约（对齐 .novel/ 工件规范）：
 *   路径：{projectId}/.novel/capability-traces/trace.jsonl
 *   格式：每行一条 CapabilityTraceRecord（JSON），append-only
 *   写：读旧 → 拼新行 → writeFileAtomic（原子替换，崩溃不损坏）
 *
 * 纯逻辑 + DI 注入 fs deps，可独立测试。生产环境 deps 走 @/commands/fs。
 */

import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import type { SelectedCapabilityTrace } from "./capabilities/types"

export const CAPABILITY_TRACE_DIR = "capability-traces"
export const CAPABILITY_TRACE_FILE = "trace.jsonl"

/** 一条能力规划 trace 记录（append-only 一行）。 */
export interface CapabilityTraceRecord {
  /** 触发规划的用户消息（截断存储，防超长） */
  query: string
  /** 任务意图 */
  intent: string
  /** 工作流模式 */
  mode: string
  /** BM25 召回出的候选能力 id（TopK 全集，含被过滤的） */
  retrieved: string[]
  /** Rule Filter 裁掉的能力 id → 原因 */
  filteredOut: Array<{ id: string; reason: string }>
  /** LLM 规划器最终选中的能力链（拓扑序） */
  planned: SelectedCapabilityTrace[]
  /** 规划结果：success=出 DAG / empty=规划为空 / fallback=回退查表 / error=异常 */
  outcome: "success" | "empty" | "fallback" | "error"
  /** 失败/回退原因（outcome!=success 时有值） */
  detail?: string
  /** 时间戳 */
  at: number
}

/** fs 依赖注入接口（默认走 @/commands/fs；测试可 mock）。 */
export interface CapabilityTraceDeps {
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, contents: string) => Promise<void>
  fileExists: (path: string) => Promise<boolean>
  createDirectory: (path: string) => Promise<void>
}

function defaultDeps(): CapabilityTraceDeps {
  return {
    readFile,
    writeFile: writeFileAtomic,
    fileExists,
    createDirectory,
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "")
}

export function capabilityTraceDirPath(projectId: string): string {
  return `${normalizePath(projectId)}/.novel/${CAPABILITY_TRACE_DIR}`
}

export function capabilityTraceFilePath(projectId: string): string {
  return `${capabilityTraceDirPath(projectId)}/${CAPABILITY_TRACE_FILE}`
}

/** query 截断上限（防超长正文污染 trace 文件）。 */
const QUERY_MAX_CHARS = 2000

function truncateQuery(q: string): string {
  return q.length > QUERY_MAX_CHARS ? q.slice(0, QUERY_MAX_CHARS) + "…[truncated]" : q
}

/**
 * 追加一条 trace 记录到 .novel/capability-traces/trace.jsonl。
 * 读旧内容 → 拼接新行 → 原子写。低频调用（每次规划一条），读改写足够。
 * 任何 IO 失败都不抛出——trace 是旁路观测，绝不能阻断写作主链。
 */
export async function appendCapabilityTrace(
  projectId: string,
  record: Omit<CapabilityTraceRecord, "at">,
  deps: CapabilityTraceDeps = defaultDeps(),
): Promise<void> {
  try {
    const dir = capabilityTraceDirPath(projectId)
    await deps.createDirectory(dir)
    const file = capabilityTraceFilePath(projectId)
    const line: CapabilityTraceRecord = {
      ...record,
      query: truncateQuery(record.query),
      at: Date.now(),
    }
    const prior = (await deps.fileExists(file)) ? await deps.readFile(file) : ""
    const next = prior.length > 0 && !prior.endsWith("\n")
      ? `${prior}\n${JSON.stringify(line)}\n`
      : `${prior}${JSON.stringify(line)}\n`
    await deps.writeFile(file, next)
  } catch {
    // 旁路观测，吞错不阻断
  }
}

/**
 * 读取全部 trace 记录（供离线分析 / Capability Selector 训练）。
 * 解析失败的行跳过（容错）。
 */
export async function readCapabilityTraces(
  projectId: string,
  deps: CapabilityTraceDeps = defaultDeps(),
): Promise<CapabilityTraceRecord[]> {
  try {
    const file = capabilityTraceFilePath(projectId)
    if (!(await deps.fileExists(file))) return []
    const text = await deps.readFile(file)
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as CapabilityTraceRecord } catch { return null } })
      .filter((r): r is CapabilityTraceRecord => r !== null)
  } catch {
    return []
  }
}
