/**
 * module-heat-persist.ts — 运行热力的最小持久化适配（`.novel/telemetry/module-heat.json`）。
 *
 * 纪律：
 * - 遥测是过程产物，不是真源：任何读写失败都不得阻断写作主流程（best-effort，不抛）；
 * - 只落「最近一次会话的命中窗口」，不建第二份状态真源（`status.json` 仍是唯一会话真源）；
 * - 覆盖写单文件而非 append，避免 `@/commands/fs` 无 append 原语带来的读-改-写放大；
 * - **原子写**（B8）：走 `writeFileAtomic`（Rust `write_file_atomic` = 同目录 temp + fsync + rename），
 *   进程被杀/断电时要么是旧的完整快照、要么是新的完整快照，绝不留下半写文件
 *   （半写文件会被 `loadHeatSnapshot` 判为损坏 → 上一次会话窗口静默丢失）。
 *
 * @license MIT © Niko Buddy
 */

import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { ModuleHit } from "./module-heat"

/** 快照文件相对路径（项目根下）。 */
export const MODULE_HEAT_SNAPSHOT = ".novel/telemetry/module-heat.json"

export interface ModuleHeatSnapshot {
  fileVersion: 1
  sessionStartedAt: number
  savedAt: number
  hits: ModuleHit[]
}

export function heatSnapshotPath(projectPath: string): string {
  return `${normalizePath(projectPath).replace(/\/+$/, "")}/${MODULE_HEAT_SNAPSHOT}`
}

/** 写出快照；失败静默（遥测不得影响主流程）。 */
export async function saveHeatSnapshot(
  projectPath: string,
  sessionStartedAt: number,
  hits: readonly ModuleHit[],
  now: number,
): Promise<boolean> {
  if (hits.length === 0) return false
  const snapshot: ModuleHeatSnapshot = {
    fileVersion: 1,
    sessionStartedAt,
    savedAt: now,
    hits: hits.slice(),
  }
  const path = heatSnapshotPath(projectPath)
  try {
    const dir = path.slice(0, path.lastIndexOf("/"))
    await createDirectory(dir)
    // 原子写（B8）：temp + rename 由 Rust 侧 `write_file_atomic` 保证（含 fsync）。
    // 不用 `writeFile`：直接覆盖会在进程被杀时留下截断的 JSON，下次启动整窗口丢失。
    await writeFileAtomic(path, JSON.stringify(snapshot))
    return true
  } catch {
    return false
  }
}

/**
 * 单条命中是否可用。
 *
 * 必要性（A-04）：快照是**用户磁盘状态**，可能因历史版本、手工编辑、部分写或
 * 磁盘异常而含非法元素。只校验容器（`Array.isArray(hits)`）时，一条非 `ModuleHit`
 * 记录会经 `hydrate` 并入 store，渲染时 `moduleLabel(undefined).replace` 抛 TypeError
 * 被 ErrorBoundary 接住 —— 热力图视图从此渲染不出来且不自愈，用户也不知道该删哪个文件。
 * 故在读盘侧逐条过滤，坏条目丢弃而非让整份快照失效。
 */
function isUsableHit(value: unknown): value is ModuleHit {
  if (!value || typeof value !== "object") return false
  const hit = value as Partial<ModuleHit>
  return (
    typeof hit.path === "string" &&
    hit.path.length > 0 &&
    typeof hit.at === "number" &&
    Number.isFinite(hit.at)
  )
}

/** 读取快照；缺失/损坏一律返回空窗口。 */
export async function loadHeatSnapshot(projectPath: string): Promise<ModuleHeatSnapshot | null> {
  try {
    const raw = await readFile(heatSnapshotPath(projectPath))
    const parsed = JSON.parse(raw) as ModuleHeatSnapshot
    if (!parsed || parsed.fileVersion !== 1 || !Array.isArray(parsed.hits)) return null
    // 逐条过滤（A-04）：合法条目原样保留，坏条目丢弃，不因个别坏数据整份失效。
    return { ...parsed, hits: parsed.hits.filter(isUsableHit) }
  } catch {
    return null
  }
}
