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

import { invoke } from "@tauri-apps/api/core"

/** 传输配置文件名（与 Rust `SYNC_CONFIG_FILE` 同值）。 */
export const SYNC_CONFIG_FILE = ".qmai/sync-config.json"

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

/** 云端备份传输配置（只有四个字段，无任何密钥明文）。 */
export interface SyncConfig {
  endpoint: string
  root: string
  credentialRef: string
  enabled: boolean
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
}

/** 拉取结果。`decision === "refuse_stale"` 时本地新态被保留，未发生任何写入。 */
export interface SyncPullResult {
  manifestId: string
  remoteRevision: number
  decision: "apply" | "refuse_stale" | "keep_both"
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
interface RawSyncConfig {
  endpoint: string
  root: string
  credential_ref: string
  enabled: boolean
}

function toRaw(config: SyncConfig): RawSyncConfig {
  return {
    endpoint: config.endpoint,
    root: config.root,
    credential_ref: config.credentialRef,
    enabled: config.enabled,
  }
}

/** 校验配置；返回逐条理由（空数组即通过）。 */
export function validateSyncConfig(config: SyncConfig): string[] {
  const reasons: string[] = []
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
  await invoke("sync_configure", { projectPath, config: toRaw(config) })
}

/** 连接测试（凭据不可用时 Rust 侧直接回报不可用，不降级）。 */
export async function testCloudBackup(projectPath: string): Promise<SyncTestResult> {
  return await invoke<SyncTestResult>("sync_test", { projectPath })
}

/** 读取传输状态（不触网）。 */
export async function cloudBackupStatus(projectPath: string): Promise<SyncStatus> {
  return await invoke<SyncStatus>("sync_status", { projectPath })
}

/** 推送导出产物（唯一同步对象 = 显式传入的导出文件）。 */
export async function pushCloudBackup(
  projectPath: string,
  artifactPath: string,
  deviceId: string,
): Promise<SyncPushResult> {
  return await invoke<SyncPushResult>("sync_push", { projectPath, artifactPath, deviceId })
}

/** 拉取为快照入库（显式确认后的恢复动作）。 */
export async function pullCloudBackup(
  projectPath: string,
  manifestId: string,
  deviceId: string,
): Promise<SyncPullResult> {
  return await invoke<SyncPullResult>("sync_pull", { projectPath, manifestId, deviceId })
}

/** 列出本地冲突副本。 */
export async function listCloudConflicts(projectPath: string): Promise<SyncConflict[]> {
  return await invoke<SyncConflict[]>("sync_conflicts", { projectPath })
}
