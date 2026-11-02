/**
 * sync command TS wrapper（UI/lib → commands → Rust）。
 * 收敛所有 `sync_*` / `sync_now` invoke，lib 不再直调 @tauri-apps/api/core。
 * Raw 字段保持 snake_case（Rust 无 camelCase rename），映射由调用方完成。
 *
 * 传输目标由 `endpoint` 字面量选型（三种，与 Rust `sync_target.rs` 同源）：
 *   - `"local"`（G2a 本地文件夹）→ `local` 块必填 `{localPath}`；`credential_ref` 必须为空串。
 *   - `"github"`（G1 GitHub 私有仓）→ `github` 块必填；`credential_ref` 必须是 `nb:github:<account>`。
 *   - 其余按 WebDAV 端点 URL 处理。
 *
 * G2a 语义澄清（**全局开关**）：`enabled` / `sync_enabled` 是**全局**同步开关，
 * 不是「单个传输目标的启用位」。它关闭时，后台调度器与一切自动触发全停
 * （Rust 侧显式门禁 `sync_scheduler::evaluate_gate`），默认值恒为 `false`。
 */
import { invoke } from "@tauri-apps/api/core";

/** GitHub 私有仓传输目标在 `endpoint` 字段里的字面量（与 Rust `GITHUB_ENDPOINT` 同值）。 */
export const GITHUB_SYNC_ENDPOINT = "github" as const

/** 本地文件夹传输目标在 `endpoint` 字段里的字面量（与 Rust `LOCAL_ENDPOINT` 同值）。 */
export const LOCAL_SYNC_ENDPOINT = "local" as const

/** 传输目标类型（UI 目标选择器的取值域）。 */
export type SyncTargetKind = "webdav" | typeof GITHUB_SYNC_ENDPOINT | typeof LOCAL_SYNC_ENDPOINT

/**
 * 全局同步开关的默认值：**关闭**。
 *
 * 「默认关闭」是安全默认：未显式开启前，后台调度器不启动、自动触发全停
 * （Rust 侧 `sync_scheduler_start` 在开关关闭时直接拒绝启动）。
 */
export const DEFAULT_SYNC_ENABLED = false

/**
 * 后台调度间隔三档（分钟）——与 Rust `SCHEDULE_INTERVAL_MINUTES` 同值。
 * 档位是契约：Rust 配置期硬校验，越界档位直接拒收。
 */
export const SYNC_SCHEDULE_INTERVALS = [15, 30, 60] as const

/** 后台调度间隔（分钟）。 */
export type SyncScheduleIntervalMinutes = (typeof SYNC_SCHEDULE_INTERVALS)[number]

/** 后台调度配置（与 Rust `SyncScheduleFile` 同构；线上字段 `intervalMinutes`）。 */
export interface SyncSchedule {
  /** 间隔分钟数，只接受 15 / 30 / 60。 */
  intervalMinutes: SyncScheduleIntervalMinutes
}

/** 调度间隔守卫：非三档一律拒绝（与 Rust `validate_schedule` 同判）。 */
export function isSyncScheduleInterval(value: number): value is SyncScheduleIntervalMinutes {
  return (SYNC_SCHEDULE_INTERVALS as readonly number[]).includes(value)
}

/**
 * GitHub 传输块（与 Rust `GitHubConfig` 同构）。
 * 线上字段是 camelCase（Rust 侧 `rename_all = "camelCase"`）；Rust 同时接受
 * `path_prefix` 别名，但前端一律发 `pathPrefix`。
 */
export interface GitHubConfig {
  owner: string
  repo: string
  branch: string
  pathPrefix: string
}

/** 本地文件夹传输块（与 Rust `LocalFolderConfig` 同构；线上字段 `localPath`）。 */
export interface LocalFolderConfig {
  /** 目标目录绝对路径（用户选定的本地文件夹）。 */
  localPath: string
}

export interface RawSyncConfig {
  /** `LOCAL_SYNC_ENDPOINT`（G2a 本地文件夹）、`GITHUB_SYNC_ENDPOINT`（G1）或 WebDAV 端点 URL。 */
  endpoint: string
  /** WebDAV 根前缀；local / github 传输下由各自传输块承担。 */
  root: string
  /** 凭据引用；本地文件夹目标必须为空串（本地目标不需要凭据）。 */
  credential_ref: string
  /** **全局**同步开关（`sync_enabled`）：关闭时调度器与一切自动触发全停。 */
  enabled: boolean
  /** G1：仅当 `endpoint === GITHUB_SYNC_ENDPOINT` 时必填；其他传输省略。 */
  github?: GitHubConfig
  /** G2a：仅当 `endpoint === LOCAL_SYNC_ENDPOINT` 时必填；其他传输省略。 */
  local?: LocalFolderConfig
  /** G2a：后台调度间隔；省略时 Rust 侧按默认档（15 分钟）。 */
  schedule?: SyncSchedule
}
export interface RawSyncTestResult { ok: boolean; endpoint: string; root: string; credential_available: boolean; reachable: boolean; object_count: number; message: string }
export interface RawSyncStatus { configured: boolean; enabled: boolean; endpoint: string; root: string; credential_ref: string; credential_available: boolean; journal_entries: number; last_direction?: string; last_manifest_id?: string; last_revision?: number }
export interface RawSyncPushResult { manifest_id: string; revision: number; content_hash: string; block_count: number; total_bytes: number; remote_prefix: string; /** 内容未变 → 未产生新版本（老后端不返回该字段）。 */ unchanged?: boolean }
export interface RawSyncPullResult { manifest_id: string; remote_revision: number; decision: "apply" | "unchanged" | "refuse_stale" | "keep_both"; snapshot_dir?: string; conflict_path?: string; message: string }
export interface RawSyncConflict { name: string; path: string; size: number; default_resolution?: "keep_both" }

// ── G2b：批次明细 + 逐项裁决 ────────────────────────────────────────────────

/**
 * 逐项裁决取值（与 Rust `PICK_MINE` / `PICK_THEIRS` / `PICK_KEEP_BOTH` 同值）。
 *
 * `keep_both` 是**兜底**：无 base、缺侧、未知值一律落到这里（fail-closed）。
 */
export const PICK_MINE = "pick_mine" as const
export const PICK_THEIRS = "pick_theirs" as const
export const PICK_KEEP_BOTH = "keep_both" as const

/** 逐项裁决取值联合类型。 */
export type SyncPickChoice = typeof PICK_MINE | typeof PICK_THEIRS | typeof PICK_KEEP_BOTH

/** 批次里的单项（与 Rust `SyncBatchItem` 同构）。 */
export interface RawSyncBatchItem {
  path: string
  direction: string
  status: string
  duration_ms: number
  error?: string
  decision?: string
  actor?: string
  decided_at?: string
  /** 是否可逐项三选一（无 base / 缺侧恒 false）。 */
  pickable: boolean
  base_available: boolean
  choices: string[]
  default_decision: string
}

/** 一个传输批次（与 Rust `SyncBatch` 同构）。 */
export interface RawSyncBatch {
  batch_id: string
  manifest_id: string
  revision: number
  direction: string
  device_id: string
  ts: string
  content_hash: string
  /** G2b 基线指针；老批次缺字段 → undefined（无 base，不迁移）。 */
  base_rev?: number
  base_content_hash?: string
  base_available: boolean
  status: string
  duration_ms: number
  error?: string
  mine_root?: string
  theirs_root?: string
  base_root?: string
  items: RawSyncBatchItem[]
}

/** 逐项裁决请求（一次调用可带多项）。 */
export interface RawSyncItemDecisionRequest {
  path: string
  decision: SyncPickChoice
}

/** 逐项裁决结果（单项失败不滚整体）。 */
export interface RawSyncItemDecisionResult {
  path: string
  decision: string
  status: string
  output_path?: string
  error?: string
}

/** 该配置是否选择了 GitHub 私有仓传输目标（G1）。 */
export function isGitHubSyncConfig(config: Pick<RawSyncConfig, "endpoint">): boolean {
  return config.endpoint.trim().toLowerCase() === GITHUB_SYNC_ENDPOINT
}

/** 该配置是否选择了本地文件夹传输目标（G2a）。 */
export function isLocalSyncConfig(config: Pick<RawSyncConfig, "endpoint">): boolean {
  return config.endpoint.trim().toLowerCase() === LOCAL_SYNC_ENDPOINT
}

/** 由 `endpoint` 归一化出传输目标类型（UI 目标选择器的反解）。 */
export function syncTargetKind(endpoint: string): SyncTargetKind {
  if (isLocalSyncConfig({ endpoint })) return LOCAL_SYNC_ENDPOINT
  if (isGitHubSyncConfig({ endpoint })) return GITHUB_SYNC_ENDPOINT
  return "webdav"
}

/**
 * 全局开关读数（`syncEnabled`）：只有显式 `true` 才算开启。
 *
 * 缺省 / 非布尔值一律视为关闭——「开关读不出来」绝不能等同于「开着」。
 */
export function syncEnabled(config: Pick<RawSyncConfig, "enabled">): boolean {
  return config.enabled === true
}

// ── 调度器 / 手动同步（G2a） ────────────────────────────────────────────────

/**
 * 一次同步周期结果（与 Rust `SyncTickResult` 同构）。
 *
 * `ran === false` 不是异常：`skip_reason` 说明为什么跳过本次
 * （`disabled` / `not_configured` / `window_closed` / `sleeping` / `offline` / `no_artifact`）。
 */
export interface RawSyncTickResult {
  ran: boolean
  skip_reason?: string
  manifest_id: string
  revision: number
  decision: string
  message: string
}

/** 调度器状态（与 Rust `SyncSchedulerStatus` 同构）。 */
export interface RawSyncSchedulerStatus {
  running: boolean
  project_path?: string
  interval_minutes: number
  /** 全局开关（`sync_enabled`）的当前值；关闭时调度器已自行停机。 */
  sync_enabled: boolean
  last_run_at?: string
  next_run_at?: string
  last_outcome?: string
}

export async function syncConfigureCommand(projectPath: string, config: RawSyncConfig): Promise<void> {
  return invoke<void>("sync_configure", { projectPath, config });
}
/** 读回落盘配置（含 `github` / `local` / `schedule` 块）；未配置 → null。 */
export async function syncConfigReadCommand(projectPath: string): Promise<RawSyncConfig | null> {
  return invoke<RawSyncConfig | null>("sync_config_read", { projectPath });
}
export async function syncTestCommand(projectPath: string): Promise<RawSyncTestResult> {
  return invoke<RawSyncTestResult>("sync_test", { projectPath });
}
export async function syncStatusCommand(projectPath: string): Promise<RawSyncStatus> {
  return invoke<RawSyncStatus>("sync_status", { projectPath });
}
export async function syncPushCommand(projectPath: string, artifactPath: string, deviceId: string): Promise<RawSyncPushResult> {
  return invoke<RawSyncPushResult>("sync_push", { projectPath, artifactPath, deviceId });
}
export async function syncPullCommand(projectPath: string, manifestId: string, deviceId: string): Promise<RawSyncPullResult> {
  return invoke<RawSyncPullResult>("sync_pull", { projectPath, manifestId, deviceId });
}
export async function syncConflictsCommand(projectPath: string): Promise<RawSyncConflict[]> {
  return invoke<RawSyncConflict[]>("sync_conflicts", { projectPath });
}

/** 批次明细（只读）：逐批次返回传输结果与逐项结果（含 base 语义）。 */
export async function syncBatchesCommand(projectPath: string): Promise<RawSyncBatch[]> {
  return invoke<RawSyncBatch[]>("sync_batches", { projectPath });
}

/**
 * 逐项裁决落盘（pick-and-apply）。
 *
 * `actor` 是**显式用户动作**标识：Rust 侧空 `actor` 直接拒绝（禁止静默自动裁决）。
 * 结果写到 `.novel/resolutions/<batch>/<path>`，不覆盖工作文件树。
 */
export async function applyPerItemDecisionCommand(
  projectPath: string,
  batch: Pick<RawSyncBatch, "manifest_id" | "revision" | "direction" | "ts" | "device_id">,
  actor: string,
  items: RawSyncItemDecisionRequest[],
): Promise<RawSyncItemDecisionResult[]> {
  return invoke<RawSyncItemDecisionResult[]>("sync_apply_per_item_decision", {
    projectPath,
    manifestId: batch.manifest_id,
    revision: batch.revision,
    direction: batch.direction,
    ts: batch.ts,
    deviceId: batch.device_id,
    actor,
    items,
  });
}

/**
 * 「立即同步」：手动触发一次完整周期（推送 `backups/auto/` 最新产物 + 拉回同清单）。
 *
 * 与后台调度**同一条** Rust 路径（`sync_scheduler::run_cycle`），所以「开关关闭 /
 * 未配置 / 无产物」的判定不会在手动与自动之间漂移。
 */
export async function syncNowCommand(projectPath: string, deviceId: string): Promise<RawSyncTickResult> {
  return invoke<RawSyncTickResult>("sync_now", { projectPath, deviceId });
}

/** 启动后台调度（全局开关关闭时 Rust 侧直接拒绝启动）。 */
export async function syncSchedulerStartCommand(
  projectPath: string,
  deviceId: string,
  intervalMinutes?: SyncScheduleIntervalMinutes,
): Promise<RawSyncSchedulerStatus> {
  return invoke<RawSyncSchedulerStatus>("sync_scheduler_start", {
    projectPath,
    deviceId,
    intervalMinutes,
  });
}

/** 停止后台调度（代际递增 → 旧循环自行退出）。 */
export async function syncSchedulerStopCommand(): Promise<RawSyncSchedulerStatus> {
  return invoke<RawSyncSchedulerStatus>("sync_scheduler_stop");
}

/** 读取调度器状态（上次 / 下次时间、上次结果）。 */
export async function syncSchedulerStatusCommand(): Promise<RawSyncSchedulerStatus> {
  return invoke<RawSyncSchedulerStatus>("sync_scheduler_status");
}
