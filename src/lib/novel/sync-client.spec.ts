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
    vi.mocked(invoke).mockResolvedValue(undefined)
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
