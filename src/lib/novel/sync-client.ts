/**
 * sync-client.ts — F-004 云端备份的 TS 封装（TASK-007 / TASK-008）。
 *
 * 职责边界：
 *   - **不重新实现安全策略**，只做 Rust 侧契约的镜像与前置体检（让 UI 在触盘/触网
 *     之前就能给出明确理由）。真正的拒绝发生在 `src-tauri/src/commands/sync_target.rs`。
 *   - **远端任一副本皆非真值**：本模块从不把远端内容写进真值面；拉取是快照入库。
 *   - **凭据永不出现在这里**：配置只有 `credentialRef`，值本身只在 OS keyring。
 *   - **对外文案用「云端备份」而非「同步」**（C-013）：避免与既有持续性文件通道混淆。
 *
 * 镜像函数（`validateSyncConfig` / `conflictFileName` / `isRemoteKeyAllowed` /
 * `decidePull`）与 Rust 实现逐条对应，两侧必须同步演进——spec 里对每条判据都做了
 * 断言，漂移会在测试层暴露而不是在用户面前暴露。
 */

import {
  DEFAULT_SYNC_ENABLED,
  LOCAL_SYNC_ENDPOINT,
  SYNC_SCHEDULE_INTERVALS,
  isGitHubSyncConfig,
  isLocalSyncConfig,
  isSyncScheduleInterval,
  syncConfigReadCommand,
  syncConfigureCommand,
  syncConflictsCommand,
  syncNowCommand,
  syncPullCommand,
  syncPushCommand,
  syncSchedulerStartCommand,
  syncSchedulerStatusCommand,
  syncSchedulerStopCommand,
  syncStatusCommand,
  syncTestCommand,
  type GitHubConfig,
  type RawSyncConfig,
  type RawSyncSchedulerStatus,
  type RawSyncTickResult,
  type SyncSchedule,
  type SyncScheduleIntervalMinutes,
  type SyncTargetKind,
} from "@/commands/sync"
import { GITHUB_CREDENTIAL_REF_PREFIX, isGitHubCredentialRef } from "@/lib/secret-client"

export {
  DEFAULT_SYNC_ENABLED,
  LOCAL_SYNC_ENDPOINT,
  SYNC_SCHEDULE_INTERVALS,
  isSyncScheduleInterval,
}
export type { GitHubConfig, SyncSchedule, SyncScheduleIntervalMinutes, SyncTargetKind }

/** 传输配置文件名（与 Rust `SYNC_CONFIG_FILE` 同值）。 */
export const SYNC_CONFIG_FILE = ".niko-buddy/sync-config.json"

/** 传输 journal 文件名（会话态、可清、非第二真源）。 */
export const SYNC_JOURNAL_FILE = ".novel/sync-journal.jsonl"

/** 冲突副本前缀（与 Rust `CONFLICT_PREFIX` 同值）。 */
export const CONFLICT_PREFIX = ".conflict-"

/** 配置允许的字段集：多一个键即拒（Rust 侧 `deny_unknown_fields`）。 */
export const SYNC_CONFIG_KEYS = ["endpoint", "root", "credential_ref", "enabled"] as const

/** 凭据引用前缀：不是密钥本体，只是 keyring 里的地址。 */
export const CREDENTIAL_REF_PREFIX = "nb:"

/** 远端对象键中禁止出现的路径段（远端不得镜像本地真值面）。 */
export const FORBIDDEN_REMOTE_SEGMENTS = ["qm", "canon", "status.json", ".novel"] as const

/** 冲突裁决的默认项（MUST NOT 静默覆盖）。 */
export const CONFLICT_DEFAULT_RESOLUTION = "keep_both" as const

/** 云端备份传输配置（四字段为 WebDAV 基线，无任何密钥明文）。
 *
 * G2a 扩展：`localPath`（本地文件夹目标）/ `github`（G1 传输块）/ `schedule`
 * （后台调度间隔）均为**可选**——WebDAV 配置仍只需四字段。
 * `enabled` 是**全局**同步开关（`sync_enabled`），默认 `false`。
 */
export interface SyncConfig {
  endpoint: string
  root: string
  credentialRef: string
  /** 全局同步开关：关闭时调度器与一切自动触发全停。 */
  enabled: boolean
  /** G2a：本地文件夹目标目录（`endpoint === "local"` 时必填）。 */
  localPath?: string
  /** G1：GitHub 私有仓传输块（`endpoint === "github"` 时必填）。 */
  github?: GitHubConfig
  /** G2a：后台调度间隔（省略时 Rust 侧按默认档 15 分钟）。 */
  schedule?: SyncSchedule
}

/** 传输状态。 */
export interface SyncStatus {
  configured: boolean
  enabled: boolean
  endpoint: string
  root: string
  credentialRef: string
  credentialAvailable: boolean
  journalEntries: number
  lastDirection?: string
  lastManifestId?: string
  lastRevision?: number
}

/** 连接测试结果。 */
export interface SyncTestResult {
  ok: boolean
  endpoint: string
  root: string
  credentialAvailable: boolean
  reachable: boolean
  objectCount: number
  message: string
}

/** 推送结果。 */
export interface SyncPushResult {
  manifestId: string
  revision: number
  contentHash: string
  blockCount: number
  totalBytes: number
  remotePrefix: string
  /** 内容指纹未变 → 未产生新版本（没传任何块、没写 journal）。 */
  unchanged: boolean
}

/**
 * 拉取结果。
 *
 * `decision` 值域：`apply`（快照入库）/ `unchanged`（远端与本地一致且该版本已入库 →
 * 未下载任何块）/ `refuse_stale`（远端更旧，本地新态被保留）/ `keep_both`（同版本异内容）。
 */
export interface SyncPullResult {
  manifestId: string
  remoteRevision: number
  decision: "apply" | "unchanged" | "refuse_stale" | "keep_both"
  snapshotDir?: string
  conflictPath?: string
  message: string
}

/** 冲突副本（终止态，不是失败）。 */
export interface SyncConflict {
  name: string
  path: string
  size: number
  defaultResolution: "keep_both"
}

/** 单调版本 + 内容指纹（判新旧只认这两项）。 */
export interface RevisionState {
  revision: number
  contentHash: string
}

/** 拉取裁决（与 Rust `PullDecision` 同构）。 */
export type PullDecision =
  | { kind: "apply" }
  | { kind: "refuse_stale"; local: number; remote: number }
  | { kind: "keep_both"; conflictName: string }

/** Rust 侧 `SyncConfig` 的 serde 字段名（snake_case）。 */
function toRaw(config: SyncConfig): RawSyncConfig {
  const raw: RawSyncConfig = {
    endpoint: config.endpoint,
    root: config.root,
    credential_ref: config.credentialRef,
    enabled: config.enabled,
  }
  if (isLocalSyncConfig(raw)) {
    // 本地文件夹目标：凭据与远端前缀一律清空（Rust 配置期硬门：credential_ref 必须为空串）。
    raw.local = { localPath: (config.localPath ?? "").trim() }
    raw.credential_ref = ""
    raw.root = ""
  } else if (isGitHubSyncConfig(raw) && config.github !== undefined) {
    raw.github = config.github
  }
  if (config.schedule !== undefined) {
    raw.schedule = { intervalMinutes: config.schedule.intervalMinutes }
  }
  return raw
}

// ── 响应方向映射 ───────────────────────────────────────────────────────────
// Rust 侧的 `SyncStatus` / `SyncTestResult` / `SyncPushResult` / `SyncPullResult` /
// `SyncConflict` **没有** `#[serde(rename_all = "camelCase")]`（见
// `src-tauri/src/commands/sync_target.rs`），故线上字段是 snake_case；本模块的域模型是
// camelCase。请求方向早已有 `toRaw`，**响应方向此前漏了映射**，后果是 UI 读到 undefined：
// `CloudBackupPanel` 把 `status.credentialRef` 交给 `validateSyncConfig` 时直接抛
// `Cannot read properties of undefined (reading 'startsWith')`，整视图被错误边界拆掉
// （挂载面板后才暴露）。新增字段时两侧必须同步。

interface RawSyncTestResult {
  ok: boolean
  endpoint: string
  root: string
  credential_available: boolean
  reachable: boolean
  object_count: number
  message: string
}

interface RawSyncStatus {
  configured: boolean
  enabled: boolean
  endpoint: string
  root: string
  credential_ref: string
  credential_available: boolean
  journal_entries: number
  last_direction?: string
  last_manifest_id?: string
  last_revision?: number
}

interface RawSyncPushResult {
  manifest_id: string
  revision: number
  content_hash: string
  block_count: number
  total_bytes: number
  remote_prefix: string
  unchanged?: boolean
}

interface RawSyncPullResult {
  manifest_id: string
  remote_revision: number
  decision: "apply" | "unchanged" | "refuse_stale" | "keep_both"
  snapshot_dir?: string
  conflict_path?: string
  message: string
}

interface RawSyncConflict {
  name: string
  path: string
  size: number
  default_resolution?: "keep_both"
}

function fromRawTestResult(raw: RawSyncTestResult): SyncTestResult {
  return {
    ok: raw.ok,
    endpoint: raw.endpoint,
    root: raw.root,
    credentialAvailable: raw.credential_available,
    reachable: raw.reachable,
    objectCount: raw.object_count,
    message: raw.message,
  }
}

function fromRawStatus(raw: RawSyncStatus): SyncStatus {
  return {
    configured: raw.configured,
    enabled: raw.enabled,
    endpoint: raw.endpoint,
    root: raw.root,
    credentialRef: raw.credential_ref,
    credentialAvailable: raw.credential_available,
    journalEntries: raw.journal_entries,
    lastDirection: raw.last_direction,
    lastManifestId: raw.last_manifest_id,
    lastRevision: raw.last_revision,
  }
}

function fromRawPushResult(raw: RawSyncPushResult): SyncPushResult {
  return {
    manifestId: raw.manifest_id,
    revision: raw.revision,
    contentHash: raw.content_hash,
    blockCount: raw.block_count,
    totalBytes: raw.total_bytes,
    remotePrefix: raw.remote_prefix,
    // 老后端不返回该字段 → 视为 false（不把「不知道」当成「没变」）。
    unchanged: raw.unchanged === true,
  }
}

function fromRawPullResult(raw: RawSyncPullResult): SyncPullResult {
  return {
    manifestId: raw.manifest_id,
    remoteRevision: raw.remote_revision,
    decision: raw.decision,
    snapshotDir: raw.snapshot_dir,
    conflictPath: raw.conflict_path,
    message: raw.message,
  }
}

function fromRawConflict(raw: RawSyncConflict): SyncConflict {
  return {
    name: raw.name,
    path: raw.path,
    size: raw.size,
    defaultResolution: raw.default_resolution ?? "keep_both",
  }
}

/** 绝对路径判定（Windows 盘符 / UNC / POSIX 根）。 */
function isAbsoluteLocalPath(value: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(value)
}

/** 校验配置；返回逐条理由（空数组即通过）。 */
export function validateSyncConfig(config: SyncConfig): string[] {
  const reasons: string[] = []
  const scheduleInvalid =
    config.schedule !== undefined && !isSyncScheduleInterval(config.schedule.intervalMinutes)
  if (scheduleInvalid) {
    reasons.push(`schedule.intervalMinutes must be one of ${SYNC_SCHEDULE_INTERVALS.join(" / ")}`)
  }
  if (isLocalSyncConfig(config)) {
    // 本地文件夹目标：不需要凭据，也不需要远端前缀；只校验目录路径。
    const localPath = (config.localPath ?? "").trim()
    if (localPath.length === 0) {
      reasons.push("localPath must be an absolute directory path")
    } else {
      if (!isAbsoluteLocalPath(localPath)) reasons.push("localPath must be an absolute path")
      if (localPath.split(/[\\/]/).includes("..")) reasons.push("localPath must not contain '..'")
    }
    if (config.credentialRef.trim().length > 0) {
      reasons.push("a local folder target must not carry a credentialRef")
    }
    return reasons
  }
  if (isGitHubSyncConfig(config)) {
    // GitHub 目标（G1）：与 Rust `validate_github_config` 同判。endpoint 是字面量
    // `"github"` 而不是 URL，因此不能落到下面的 WebDAV URL 校验；凭据域硬门
    // 要求 `nb:github:<account>`，把别的域配给 GitHub 目标在配置期就失败。
    const github = config.github
    if (github === undefined) {
      reasons.push("github block is required when endpoint is 'github'")
      return reasons
    }
    for (const [label, value] of [
      ["owner", github.owner],
      ["repo", github.repo],
    ] as const) {
      const trimmed = value.trim()
      if (trimmed.length === 0) {
        reasons.push(`github ${label} must not be empty`)
      } else if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
        reasons.push(`github ${label} must match [A-Za-z0-9._-]: ${trimmed}`)
      }
    }
    const branch = github.branch.trim()
    if (branch.length === 0) {
      reasons.push("github branch must not be empty")
    } else if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("..")) {
      reasons.push(`github branch must be a relative ref without '..': ${branch}`)
    } else if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
      reasons.push(`github branch must match [A-Za-z0-9._/-]: ${branch}`)
    }
    const prefix = github.pathPrefix.trim()
    if (prefix.startsWith("/") || prefix.includes("..") || prefix.includes("\\")) {
      reasons.push(`github pathPrefix must be a relative POSIX prefix without '..': ${prefix}`)
    }
    if (!isGitHubCredentialRef(config.credentialRef)) {
      reasons.push(`github credentialRef must start with '${GITHUB_CREDENTIAL_REF_PREFIX}'`)
    }
    return reasons
  }
  if (!/^https?:\/\//.test(config.endpoint)) reasons.push("endpoint must be an http(s) URL")
  if (config.endpoint.includes(" ")) reasons.push("endpoint must not contain spaces")
  if (config.root.includes("..")) reasons.push("root must not contain '..'")
  if (config.root.startsWith("/")) reasons.push("root must be relative")
  if (!config.credentialRef.startsWith(CREDENTIAL_REF_PREFIX)) {
    reasons.push(`credentialRef must start with '${CREDENTIAL_REF_PREFIX}'`)
  }
  const lowered = config.credentialRef.toLowerCase()
  for (const suspicious of ["password", "passwd", "token", "secret", "apikey", "api_key"]) {
    if (lowered.includes(suspicious)) {
      reasons.push(`credentialRef must be a reference, not key material (found '${suspicious}')`)
    }
  }
  return reasons
}

/** 冲突副本文件名 `.conflict-<device>-<timestamp>`；不安全输入返回 null（与 Rust 同判）。 */
export function conflictFileName(deviceId: string, timestamp: string): string | null {
  const device = deviceId.replace(/[^A-Za-z0-9_-]/g, "")
  if (device.length === 0) return null
  const ts = timestamp.replace(/[^0-9-]/g, "")
  if (!/[0-9]/.test(ts)) return null
  return `${CONFLICT_PREFIX}${device}-${ts}`
}

/** 远端对象键守卫（与 Rust `assert_remote_key_allowed` 同判）。 */
export function isRemoteKeyAllowed(key: string): boolean {
  if (key.length === 0) return false
  if (key.startsWith("/") || key.includes("\\")) return false
  for (const segment of key.split("/")) {
    if (segment === ".." || segment.length === 0) return false
    if ((FORBIDDEN_REMOTE_SEGMENTS as readonly string[]).includes(segment.toLowerCase())) return false
  }
  return true
}

/**
 * 拉取裁决（与 Rust `decide_pull` 同判）：
 *   - 远端更旧 → refuse_stale（绝不静默覆盖本地新态）
 *   - 同版本同指纹 → apply（幂等）
 *   - 同版本异指纹 → keep_both（真分歧，保留双方）
 *   - 远端更新 → apply（仍以快照入库）
 */
export function decidePull(
  local: RevisionState,
  remote: RevisionState,
  deviceId: string,
  timestamp: string,
): PullDecision {
  if (remote.revision < local.revision) {
    return { kind: "refuse_stale", local: local.revision, remote: remote.revision }
  }
  if (remote.revision === local.revision && remote.contentHash !== local.contentHash) {
    const conflictName = conflictFileName(deviceId, timestamp)
    if (conflictName === null) {
      throw new Error("deviceId and timestamp must yield a safe conflict name")
    }
    return { kind: "keep_both", conflictName }
  }
  return { kind: "apply" }
}

/** 逐条给出冲突的可读摘要（默认裁决恒为「保留两者」）。 */
export function summarizeConflict(conflict: SyncConflict): string {
  return `${conflict.name} (${conflict.size} B)`
}

/** 保存云端备份配置。 */
export async function configureCloudBackup(projectPath: string, config: SyncConfig): Promise<void> {
  const reasons = validateSyncConfig(config)
  if (reasons.length > 0) {
    throw new Error(`invalid cloud backup config: ${reasons.join("; ")}`)
  }
  await syncConfigureCommand(projectPath, toRaw(config))
}

/** 连接测试（凭据不可用时 Rust 侧直接回报不可用，不降级）。 */
export async function testCloudBackup(projectPath: string): Promise<SyncTestResult> {
  return fromRawTestResult(await syncTestCommand(projectPath))
}

/** 读取传输状态（不触网）。 */
export async function cloudBackupStatus(projectPath: string): Promise<SyncStatus> {
  return fromRawStatus(await syncStatusCommand(projectPath))
}

/** 推送导出产物（唯一同步对象 = 显式传入的导出文件）。 */
export async function pushCloudBackup(
  projectPath: string,
  artifactPath: string,
  deviceId: string,
): Promise<SyncPushResult> {
  return fromRawPushResult(
    await syncPushCommand(projectPath, artifactPath, deviceId),
  )
}

/** 拉取为快照入库（显式确认后的恢复动作）。 */
export async function pullCloudBackup(
  projectPath: string,
  manifestId: string,
  deviceId: string,
): Promise<SyncPullResult> {
  return fromRawPullResult(
    await syncPullCommand(projectPath, manifestId, deviceId),
  )
}

/** 列出本地冲突副本。 */
export async function listCloudConflicts(projectPath: string): Promise<SyncConflict[]> {
  const raw = await syncConflictsCommand(projectPath)
  return raw.map(fromRawConflict)
}

// ── G2a：本地文件夹配对 / 全局开关 / 手动与后台调度 ──────────────────────────

/** 落盘配置的完整视图（含 `github` / `local` / `schedule` 块；未配置 → null）。 */
export interface SyncConfigFile {
  endpoint: string
  root: string
  credentialRef: string
  enabled: boolean
  localPath?: string
  github?: GitHubConfig
  schedule?: SyncSchedule
}

/** 一次同步周期的结果（`ran === false` 时 `skipReason` 说明原因，不是异常）。 */
export interface SyncTickResult {
  ran: boolean
  skipReason?: string
  manifestId: string
  revision: number
  decision: string
  message: string
}

/** 调度器状态（上次 / 下次时间、上次结果、全局开关读数）。 */
export interface SyncSchedulerStatus {
  running: boolean
  projectPath?: string
  intervalMinutes: number
  /** 全局开关（`syncEnabled`）的当前值。 */
  syncEnabled: boolean
  lastRunAt?: string
  nextRunAt?: string
  lastOutcome?: string
}

function fromRawSchedulerStatus(raw: RawSyncSchedulerStatus): SyncSchedulerStatus {
  return {
    running: raw.running,
    projectPath: raw.project_path,
    intervalMinutes: raw.interval_minutes,
    syncEnabled: raw.sync_enabled,
    lastRunAt: raw.last_run_at,
    nextRunAt: raw.next_run_at,
    lastOutcome: raw.last_outcome,
  }
}

function fromRawTickResult(raw: RawSyncTickResult): SyncTickResult {
  return {
    ran: raw.ran,
    skipReason: raw.skip_reason,
    manifestId: raw.manifest_id,
    revision: raw.revision,
    decision: raw.decision,
    message: raw.message,
  }
}

/** 读回落盘配置（编辑 GitHub 块 / 本地文件夹路径 / 调度间隔时需要完整视图）。 */
export async function readCloudBackupConfig(projectPath: string): Promise<SyncConfigFile | null> {
  const raw = await syncConfigReadCommand(projectPath)
  if (raw === null || raw === undefined) return null
  const schedule =
    raw.schedule !== undefined && isSyncScheduleInterval(raw.schedule.intervalMinutes)
      ? { intervalMinutes: raw.schedule.intervalMinutes }
      : undefined
  return {
    endpoint: raw.endpoint,
    root: raw.root,
    credentialRef: raw.credential_ref,
    enabled: raw.enabled === true,
    localPath: raw.local?.localPath,
    github: raw.github,
    schedule,
  }
}

/**
 * 「立即同步」：手动触发一次完整周期。
 *
 * 与后台调度共用 Rust 侧同一条 `run_cycle`，因此判定不会在手动 / 自动之间漂移。
 */
export async function runSyncNow(projectPath: string, deviceId: string): Promise<SyncTickResult> {
  return fromRawTickResult(await syncNowCommand(projectPath, deviceId))
}

/** 启动后台调度（全局开关关闭时 Rust 侧直接拒绝启动）。 */
export async function startSyncScheduler(
  projectPath: string,
  deviceId: string,
  intervalMinutes?: SyncScheduleIntervalMinutes,
): Promise<SyncSchedulerStatus> {
  return fromRawSchedulerStatus(
    await syncSchedulerStartCommand(projectPath, deviceId, intervalMinutes),
  )
}

/** 停止后台调度。 */
export async function stopSyncScheduler(): Promise<SyncSchedulerStatus> {
  return fromRawSchedulerStatus(await syncSchedulerStopCommand())
}

/** 读取调度器状态。 */
export async function readSyncSchedulerStatus(): Promise<SyncSchedulerStatus> {
  return fromRawSchedulerStatus(await syncSchedulerStatusCommand())
}
