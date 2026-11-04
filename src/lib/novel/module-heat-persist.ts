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

/** 读取快照；缺失/损坏一律返回空窗口。 */
export async function loadHeatSnapshot(projectPath: string): Promise<ModuleHeatSnapshot | null> {
  try {
    const raw = await readFile(heatSnapshotPath(projectPath))
    const parsed = JSON.parse(raw) as ModuleHeatSnapshot
    if (!parsed || parsed.fileVersion !== 1 || !Array.isArray(parsed.hits)) return null
    return parsed
  } catch {
    return null
  }
}
