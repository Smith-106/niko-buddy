/**
 * sync command TS wrapper（UI/lib → commands → Rust）。
 * 收敛所有 `sync_*` invoke，lib 不再直调 @tauri-apps/api/core。
 * Raw 字段保持 snake_case（Rust 无 camelCase rename），映射由调用方完成。
 */
import { invoke } from "@tauri-apps/api/core";

export interface RawSyncConfig { endpoint: string; root: string; credential_ref: string; enabled: boolean }
export interface RawSyncTestResult { ok: boolean; endpoint: string; root: string; credential_available: boolean; reachable: boolean; object_count: number; message: string }
export interface RawSyncStatus { configured: boolean; enabled: boolean; endpoint: string; root: string; credential_ref: string; credential_available: boolean; journal_entries: number; last_direction?: string; last_manifest_id?: string; last_revision?: number }
export interface RawSyncPushResult { manifest_id: string; revision: number; content_hash: string; block_count: number; total_bytes: number; remote_prefix: string }
export interface RawSyncPullResult { manifest_id: string; remote_revision: number; decision: "apply" | "refuse_stale" | "keep_both"; snapshot_dir?: string; conflict_path?: string; message: string }
export interface RawSyncConflict { name: string; path: string; size: number; default_resolution?: "keep_both" }

export async function syncConfigureCommand(projectPath: string, config: RawSyncConfig): Promise<void> {
  return invoke<void>("sync_configure", { projectPath, config });
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
