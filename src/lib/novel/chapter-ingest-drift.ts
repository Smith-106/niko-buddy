/**
 * chapter-ingest 拆分 W4：真相折叠漂移（drift）比对、告警与自动修复。
 *
 * 本模块是 rebuild 的只读副产品 + 自愈闭环：
 *   - `computeTruthFoldDrift`：逐类比对 live 盘上 store 与从 committed 快照序列
 *     重放的 store（**经注册表同源遍历**，与 rebuild/ingest 用同一 `foldFromSnapshot`）；
 *   - `sampleTruthFoldDrift` / `emitTruthFoldDriftAlarm`：安全采样与告警（GOV-OBS-01
 *     不静默降级）；
 *   - `autoRepairTruthFoldDrift`：漂移类经注册表确定性重建 → 复测仍>0 才告警升级。
 *
 * 只搬不改：判定口径（drifted = liveHash !== replayHash）、误报护栏（drift=0 零动作）、
 * 升级条件与 telemetry 格式一律未动。
 */
import { createDirectory, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { logger, toErrorMessage } from "@/lib/utils"
import { truthStoreHash } from "./projection-store"
import { decideDriftAlarmAfterRepair } from "./kb-observability"
import {
  PROJECTION_REGISTRY,
  type ProjectionFoldContext,
} from "./projection-status-ledger"
import { loadValidMemorySnapshots } from "./chapter-ingest-history"
import {
  rebuildRegistryProjections,
  unfoldedDriftClasses,
} from "./chapter-ingest-fold-registry"

// ── sampleUnfoldedMemoryDriftSuspected ──
export async function sampleUnfoldedMemoryDriftSuspected(projectPath: string): Promise<string[]> {
  try {
    const results = await computeTruthFoldDrift(projectPath, "")
    const unfolded = unfoldedDriftClasses()
    return results
      .filter((r) => r.drifted && unfolded.has(r.file))
      .map((r) => r.file)
  } catch (err) {
    logger.warn("Chapter Ingest", "syncSnapshotToMemory 6 类 drift 采样失败（债务记 trace，不阻断）", {
      error: toErrorMessage(err),
    })
    return []
  }
}

// ── TruthFoldDrift ──
export interface TruthFoldDrift {
  file: string
  liveHash: string
  replayHash: string
  drifted: boolean
}

// ── computeTruthFoldDrift ──
export async function computeTruthFoldDrift(
  projectPath: string,
  now = "",
): Promise<TruthFoldDrift[]> {
  const snapshots = await loadValidMemorySnapshots(projectPath)
  const foldCtx: ProjectionFoldContext = { now }
  const results: TruthFoldDrift[] = []

  const compare = async (file: string, live: unknown, replay: unknown): Promise<void> => {
    const [liveHash, replayHash] = await Promise.all([truthStoreHash(live), truthStoreHash(replay)])
    results.push({ file, liveHash, replayHash, drifted: liveHash !== replayHash })
  }

  // P2-IMP-14: drift 重放路径经注册表同源遍历——live = entry.load（盘上原值，
  // 含 cognition 缺文件 null 语义），replay = entry.foldFromSnapshot（与
  // rebuild/ingest 同一 fold）。比对文件集合 = 注册表带 file 的 store 条目集
  // （9 类），与写盘路径结构上同源（原 9 段硬编码收敛于此）。
  for (const [, entry] of Object.entries(PROJECTION_REGISTRY)) {
    if (!entry.file || !entry.load || !entry.foldFromSnapshot) continue
    const live = await entry.load(projectPath)
    const replay = entry.foldFromSnapshot(snapshots, foldCtx)
    await compare(entry.file, live, replay)
  }

  return results
}

// ── sampleTruthFoldDrift ──
export async function sampleTruthFoldDrift(
  projectPath: string,
  now = "",
): Promise<{ driftCount: number; driftedFiles: string[] } | null> {
  try {
    const results = await computeTruthFoldDrift(projectPath, now)
    const driftedFiles = results.filter((r) => r.drifted).map((r) => r.file)
    return { driftCount: driftedFiles.length, driftedFiles }
  } catch (err) {
    logger.warn("Chapter Ingest", "sampleTruthFoldDrift 采样失败（债务记 trace，不阻断）", {
      error: toErrorMessage(err),
    })
    return null
  }
}

// ── emitTruthFoldDriftAlarm ──
export async function emitTruthFoldDriftAlarm(
  projectPath: string,
  sample: { driftCount: number; driftedFiles: string[] } | null,
): Promise<boolean> {
  if (!sample || sample.driftCount === 0) return false
  const detail = `truth_fold_drift=${sample.driftCount}（漂移文件：${sample.driftedFiles.join(", ")}）`
  logger.warn("Chapter Ingest", `记忆漂移告警：${detail}（建议重建过程库）`)
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    const telemetryDir = `${projectPath}/.novel/telemetry`
    await createDirectory(telemetryDir)
    await writeFileAtomic(
      `${telemetryDir}/drift-${ts}.jsonl`,
      JSON.stringify({ ts: new Date().toISOString(), driftCount: sample.driftCount, driftedFiles: sample.driftedFiles }) + "\n",
    )
  } catch (err) {
    logger.warn("Chapter Ingest", "drift telemetry 写入失败（债务记 trace，不阻断）", {
      error: toErrorMessage(err),
    })
  }
  return true
}

// ── DriftAutoRepairResult ──
export interface DriftAutoRepairResult {
  /** 是否实际尝试了修复（drift=0 / 采样 N-A → false，误报护栏零动作）。 */
  attempted: boolean
  /** 修复前漂移类数；null = 采样不可用（N/A，不伪造）。 */
  driftBefore: number | null
  /** 复测漂移类数；null = 复测不可用（按升级告警处理）。 */
  driftAfter: number | null
  /** 修复后不再漂移的文件。 */
  repairedFiles: string[]
  /** 复测仍漂移的文件（告警升级对象）。 */
  stillDriftedFiles: string[]
  /** 复测仍>0 → 已告警升级（emitTruthFoldDriftAlarm 内部已触发）。 */
  escalated: boolean
  /** 重建失败时的错误信息。 */
  error?: string
}

// ── writeDriftSelfHealTelemetry ──
export async function writeDriftSelfHealTelemetry(
  projectPath: string,
  event: Record<string, unknown>,
): Promise<void> {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    const telemetryDir = `${projectPath}/.novel/telemetry`
    await createDirectory(telemetryDir)
    await writeFileAtomic(`${telemetryDir}/selfheal-${ts}.jsonl`, JSON.stringify(event) + "\n")
  } catch (err) {
    logger.warn("Chapter Ingest", "selfheal telemetry 写入失败（债务记 trace，不阻断）", {
      error: toErrorMessage(err),
    })
  }
}

// ── autoRepairTruthFoldDrift ──
export async function autoRepairTruthFoldDrift(
  projectPath: string,
  options: { now?: string; trigger?: string } = {},
): Promise<DriftAutoRepairResult> {
  const pp = normalizePath(projectPath)
  const now = options.now ?? ""
  const trigger = options.trigger ?? "unknown"
  const before = await sampleTruthFoldDrift(pp, now)
  if (!before) {
    return { attempted: false, driftBefore: null, driftAfter: null, repairedFiles: [], stillDriftedFiles: [], escalated: false }
  }
  if (before.driftCount === 0) {
    return { attempted: false, driftBefore: 0, driftAfter: 0, repairedFiles: [], stillDriftedFiles: [], escalated: false }
  }
  // 漂移文件 → 注册表确定性 fold 投影（仅 rebuildable 条目；非确定性投影不自动）。
  const fileToProjection = new Map<string, string>()
  for (const [id, entry] of Object.entries(PROJECTION_REGISTRY)) {
    if (entry.file !== null && entry.rebuildable) fileToProjection.set(entry.file, id)
  }
  const driftedIds = new Set<string>()
  for (const file of before.driftedFiles) {
    const id = fileToProjection.get(file)
    if (id) driftedIds.add(id)
  }
  let error: string | undefined
  if (driftedIds.size > 0) {
    try {
      const snapshots = await loadValidMemorySnapshots(pp)
      await rebuildRegistryProjections(pp, snapshots, { now }, driftedIds)
    } catch (err) {
      error = toErrorMessage(err)
      logger.warn("Chapter Ingest", "drift 自动修复重建失败（转告警升级）", { error })
    }
  }
  const after = await sampleTruthFoldDrift(pp, now)
  const driftAfter = after ? after.driftCount : before.driftCount
  const stillDriftedFiles = after ? after.driftedFiles : before.driftedFiles
  const repairedFiles = before.driftedFiles.filter((f) => !stillDriftedFiles.includes(f))
  const decision = decideDriftAlarmAfterRepair({ driftBefore: before.driftCount, driftAfter, repairedFiles })
  const escalated = decision.alarm
  await writeDriftSelfHealTelemetry(pp, {
    ts: new Date().toISOString(),
    trigger,
    driftBefore: before.driftCount,
    driftedFiles: before.driftedFiles,
    repairedFiles,
    driftAfter,
    escalated,
    ...(error !== undefined ? { error } : {}),
  })
  if (escalated) {
    // 复测仍>0 才告警升级（IMP-06 通道：logger.warn + drift-<ts>.jsonl）。
    await emitTruthFoldDriftAlarm(pp, { driftCount: driftAfter ?? before.driftCount, driftedFiles: stillDriftedFiles })
  } else {
    logger.info("Chapter Ingest", `drift 自动修复成功：${decision.detail}（trigger=${trigger}）`)
  }
  return {
    attempted: true,
    driftBefore: before.driftCount,
    driftAfter,
    repairedFiles,
    stillDriftedFiles,
    escalated,
    ...(error !== undefined ? { error } : {}),
  }
}
