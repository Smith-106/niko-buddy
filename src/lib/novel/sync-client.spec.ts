/**
 * sync-client.spec.ts — F-004 云端备份客户端契约测试。
 *
 * 这组用例的真实价值是**镜像漂移检测**：每条判定都在 Rust 侧有对应实现
 * （`src-tauri/src/commands/sync_target.rs` 的同名测试），两侧必须给出同一结论。
 * 漂移在这里暴露，而不是在用户的项目里暴露。
 */

import { describe, expect, it, vi } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))

import { invoke } from "@tauri-apps/api/core"
import {
  CONFLICT_DEFAULT_RESOLUTION,
  CONFLICT_PREFIX,
  SYNC_CONFIG_KEYS,
  SYNC_CONFIG_FILE,
  SYNC_JOURNAL_FILE,
  cloudBackupStatus,
  configureCloudBackup,
  conflictFileName,
  decidePull,
  isRemoteKeyAllowed,
  listCloudConflicts,
  pullCloudBackup,
  pushCloudBackup,
  summarizeConflict,
  testCloudBackup,
  validateSyncConfig,
  type SyncConfig,
} from "./sync-client"

const validConfig: SyncConfig = {
  endpoint: "https://dav.example.com",
  root: "niko-buddy/backups",
  credentialRef: "nb:webdav:proj-42",
  enabled: true,
}

describe("constants mirror the Rust contract", () => {
  it("pins config/journal paths, conflict prefix and the four allowed fields", () => {
    expect(SYNC_CONFIG_FILE).toBe(".qmai/sync-config.json")
    expect(SYNC_JOURNAL_FILE).toBe(".novel/sync-journal.jsonl")
    expect(CONFLICT_PREFIX).toBe(".conflict-")
    expect([...SYNC_CONFIG_KEYS]).toEqual(["endpoint", "root", "credential_ref", "enabled"])
    expect(CONFLICT_DEFAULT_RESOLUTION).toBe("keep_both")
  })

  it("never lets a secret-shaped field into the config contract", () => {
    for (const key of SYNC_CONFIG_KEYS) {
      expect(key).not.toMatch(/password|passwd|token|secret/i)
    }
  })
})

describe("validateSyncConfig", () => {
  it("accepts a well-formed config", () => {
    expect(validateSyncConfig(validConfig)).toEqual([])
  })

  it("rejects non-http endpoints, escaping roots and key material in the ref", () => {
    expect(validateSyncConfig({ ...validConfig, endpoint: "ftp://nope" }).length).toBeGreaterThan(0)
    expect(
      validateSyncConfig({ ...validConfig, root: "../escape" }).some((r) => r.includes("'..'")),
    ).toBe(true)
    expect(
      validateSyncConfig({ ...validConfig, root: "/abs" }).some((r) => r.includes("relative")),
    ).toBe(true)
    expect(
      validateSyncConfig({ ...validConfig, credentialRef: "webdav-token" }).some((r) =>
        r.includes("nb:"),
      ),
    ).toBe(true)
  })
})

describe("conflictFileName", () => {
  it("builds .conflict-<device>-<timestamp> and strips unsafe characters", () => {
    expect(conflictFileName("device-a", "20260912130000")).toBe(
      ".conflict-device-a-20260912130000",
    )
    expect(conflictFileName("dev/../x", "2026-09-12")).toBe(".conflict-devx-2026-09-12")
  })

  it("refuses a device id with no safe characters and a timestamp without digits", () => {
    expect(conflictFileName("", "20260912130000")).toBeNull()
    expect(conflictFileName("dev", "no-digits")).toBeNull()
    expect(conflictFileName("***", "2026")).toBeNull()
  })
})

describe("decidePull", () => {
  const local = { revision: 5, contentHash: "a".repeat(64) }

  it("refuses to overwrite a newer local revision with an older remote one", () => {
    expect(decidePull(local, { revision: 4, contentHash: "b".repeat(64) }, "d", "2026")).toEqual({
      kind: "refuse_stale",
      local: 5,
      remote: 4,
    })
  })

  it("applies idempotently for an identical revision and fingerprint", () => {
    expect(decidePull(local, { ...local }, "d", "2026")).toEqual({ kind: "apply" })
  })

  it("applies for a newer remote revision", () => {
    expect(decidePull(local, { revision: 6, contentHash: "c".repeat(64) }, "d", "2026")).toEqual({
      kind: "apply",
    })
  })

  it("keeps both copies on a same-revision fingerprint divergence", () => {
    expect(
      decidePull(local, { revision: 5, contentHash: "f".repeat(64) }, "device-b", "20260912130000"),
    ).toEqual({ kind: "keep_both", conflictName: ".conflict-device-b-20260912130000" })
  })

  it("throws rather than fabricating a conflict name", () => {
    expect(() =>
      decidePull(local, { revision: 5, contentHash: "f".repeat(64) }, "", "2026"),
    ).toThrow()
  })
})

describe("isRemoteKeyAllowed", () => {
  it("allows content-addressed remote keys", () => {
    expect(isRemoteKeyAllowed("20260912-artifact/rev-1/blocks/abc")).toBe(true)
    expect(isRemoteKeyAllowed("demo/rev-2/manifest.json")).toBe(true)
  })

  it("never allows a remote key that mirrors a local truth surface", () => {
    expect(isRemoteKeyAllowed("demo/rev-1/QM/x")).toBe(false)
    expect(isRemoteKeyAllowed("demo/rev-1/canon/x")).toBe(false)
    expect(isRemoteKeyAllowed("demo/rev-1/status.json")).toBe(false)
    expect(isRemoteKeyAllowed("demo/rev-1/.novel/x")).toBe(false)
    expect(isRemoteKeyAllowed("../escape")).toBe(false)
    expect(isRemoteKeyAllowed("/abs")).toBe(false)
    expect(isRemoteKeyAllowed("")).toBe(false)
    expect(isRemoteKeyAllowed("a//b")).toBe(false)
  })
})

describe("invoke envelope", () => {
  it("sends the config with serde field names", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    await configureCloudBackup("C:/proj", validConfig)
    expect(invoke).toHaveBeenCalledWith("sync_configure", {
      projectPath: "C:/proj",
      config: {
        endpoint: validConfig.endpoint,
        root: validConfig.root,
        credential_ref: validConfig.credentialRef,
        enabled: true,
      },
    })
  })

  it("refuses to invoke on an invalid config", async () => {
    vi.mocked(invoke).mockClear()
    await expect(
      configureCloudBackup("C:/proj", { ...validConfig, credentialRef: "plain-token" }),
    ).rejects.toThrow(/invalid cloud backup config/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("routes status/test/push/pull/conflicts to their commands", async () => {
    // 返回值按真实契约给（Rust 侧恒返回对象/数组；响应映射已不再容忍 undefined）。
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "sync_status":
          return {
            configured: false,
            enabled: false,
            endpoint: "",
            root: "",
            credential_ref: "",
            credential_available: false,
            journal_entries: 0,
          }
        case "sync_test":
          return {
            ok: true,
            endpoint: "",
            root: "",
            credential_available: false,
            reachable: false,
            object_count: 0,
            message: "",
          }
        case "sync_push":
          return {
            manifest_id: "m",
            revision: 1,
            content_hash: "a".repeat(64),
            block_count: 1,
            total_bytes: 1,
            remote_prefix: "p",
          }
        case "sync_pull":
          return {
            manifest_id: "m",
            remote_revision: 1,
            decision: "apply",
            snapshot_dir: "s",
            message: "",
          }
        case "sync_conflicts":
          return []
        default:
          return undefined
      }
    })
    await cloudBackupStatus("C:/proj")
    expect(invoke).toHaveBeenLastCalledWith("sync_status", { projectPath: "C:/proj" })
    await testCloudBackup("C:/proj")
    expect(invoke).toHaveBeenLastCalledWith("sync_test", { projectPath: "C:/proj" })
    await pushCloudBackup("C:/proj", "C:/proj/backups/a.zip", "device-a")
    expect(invoke).toHaveBeenLastCalledWith("sync_push", {
      projectPath: "C:/proj",
      artifactPath: "C:/proj/backups/a.zip",
      deviceId: "device-a",
    })
    await pullCloudBackup("C:/proj", "a", "device-a")
    expect(invoke).toHaveBeenLastCalledWith("sync_pull", {
      projectPath: "C:/proj",
      manifestId: "a",
      deviceId: "device-a",
    })
    await listCloudConflicts("C:/proj")
    expect(invoke).toHaveBeenLastCalledWith("sync_conflicts", { projectPath: "C:/proj" })
  })
})

describe("summarizeConflict", () => {
  it("reports the copy name and size and pins keep_both as the default", () => {
    const conflict = {
      name: ".conflict-device-b-20260912130000",
      path: "C:/proj/.novel/.conflict-device-b-20260912130000",
      size: 4096,
      defaultResolution: CONFLICT_DEFAULT_RESOLUTION,
    } as const
    expect(summarizeConflict(conflict)).toBe(".conflict-device-b-20260912130000 (4096 B)")
    expect(conflict.defaultResolution).toBe("keep_both")
  })
})

// ── 响应方向命名映射（回归：曾漏映射导致 CloudBackupPanel 渲染期崩溃） ──────────
// Rust 侧 `SyncStatus` 等结构体没有 `#[serde(rename_all = "camelCase")]`，线上字段是
// snake_case；域模型是 camelCase。此前只做了请求方向（toRaw），响应方向原样返回，
// 于是 `status.credentialRef` 为 undefined → `validateSyncConfig` 读 `.startsWith`
// 抛 TypeError，整视图被错误边界拆掉。以下用例锁定映射不再回退。
describe("response wire→domain mapping", () => {
  it("sync_status：snake_case 载荷映射为 camelCase 域模型", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      configured: true,
      enabled: true,
      endpoint: "https://dav.example.com",
      root: "niko-buddy/backups",
      credential_ref: "nb:webdav:proj-42",
      credential_available: true,
      journal_entries: 3,
      last_direction: "push",
      last_manifest_id: "m-1",
      last_revision: 7,
    })
    const status = await cloudBackupStatus("C:/proj")
    expect(status.credentialRef).toBe("nb:webdav:proj-42")
    expect(status.credentialAvailable).toBe(true)
    expect(status.journalEntries).toBe(3)
    expect(status.lastDirection).toBe("push")
    expect(status.lastManifestId).toBe("m-1")
    expect(status.lastRevision).toBe(7)
    // 映射结果必须可直接喂给校验器（正是此前崩溃的那条路径）
    expect(validateSyncConfig({
      endpoint: status.endpoint,
      root: status.root,
      credentialRef: status.credentialRef,
      enabled: status.enabled,
    })).toEqual([])
  })

  it("sync_test：object_count 映射为 objectCount", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      ok: true,
      endpoint: "https://dav.example.com",
      root: "niko-buddy/backups",
      credential_available: false,
      reachable: true,
      object_count: 2,
      message: "reachable",
    })
    const result = await testCloudBackup("C:/proj")
    expect(result.objectCount).toBe(2)
    expect(result.credentialAvailable).toBe(false)
  })

  it("sync_push：manifest_id/content_hash/block_count/total_bytes/remote_prefix 全映射", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      manifest_id: "m-2",
      revision: 8,
      content_hash: "a".repeat(64),
      block_count: 5,
      total_bytes: 8192,
      remote_prefix: "demo/rev-8",
    })
    const result = await pushCloudBackup("C:/proj", "C:/proj/out.zip", "dev-1")
    expect(result).toEqual({
      manifestId: "m-2",
      revision: 8,
      contentHash: "a".repeat(64),
      blockCount: 5,
      totalBytes: 8192,
      remotePrefix: "demo/rev-8",
    })
  })

  it("sync_pull：remote_revision/snapshot_dir/conflict_path 映射（含可选字段）", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      manifest_id: "m-3",
      remote_revision: 9,
      decision: "keep_both",
      conflict_path: "C:/proj/.novel/.conflict-dev-1-20260912130000",
      message: "both copies preserved",
    })
    const result = await pullCloudBackup("C:/proj", "m-3", "dev-1")
    expect(result.remoteRevision).toBe(9)
    expect(result.conflictPath).toBe("C:/proj/.novel/.conflict-dev-1-20260912130000")
    expect(result.snapshotDir).toBeUndefined()
  })

  it("sync_conflicts：default_resolution 映射为 defaultResolution", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        name: ".conflict-dev-1-20260912130000",
        path: "C:/proj/.novel/.conflict-dev-1-20260912130000",
        size: 4096,
        default_resolution: "keep_both",
      },
    ])
    const conflicts = await listCloudConflicts("C:/proj")
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].defaultResolution).toBe("keep_both")
    expect(summarizeConflict(conflicts[0])).toBe(".conflict-dev-1-20260912130000 (4096 B)")
  })
})
