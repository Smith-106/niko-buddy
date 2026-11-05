/**
 * sync-client.spec.ts — F-004 云端备份客户端契约测试。
 *
 * 这组用例的真实价值是**镜像漂移检测**：每条判定都在 Rust 侧有对应实现
 * （`src-tauri/src/commands/sync_target.rs` 的同名测试），两侧必须给出同一结论。
 * 漂移在这里暴露，而不是在用户的项目里暴露。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))

import { invoke } from "@tauri-apps/api/core"
import {
  readCloudBackupConfig,
  runSyncNow,
  startSyncScheduler,
  stopSyncScheduler,
  readSyncSchedulerStatus,
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
    expect(SYNC_CONFIG_FILE).toBe(".niko-buddy/sync-config.json")
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
      // 老后端不返回 unchanged → 一律 false（不把「不知道」当成「没变」）。
      unchanged: false,
    })
  })

  it("sync_push：unchanged=true 时原样映射（内容未变 → 未产生新版本）", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      manifest_id: "m-2",
      revision: 8,
      content_hash: "a".repeat(64),
      block_count: 5,
      total_bytes: 0,
      remote_prefix: "demo/rev-8",
      unchanged: true,
    })
    const result = await pushCloudBackup("C:/proj", "C:/proj/out.zip", "dev-1")
    expect(result.unchanged).toBe(true)
    expect(result.revision).toBe(8)
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

describe("validateSyncConfig 本地/GitHub/调度分支", () => {
  const localBase: SyncConfig = {
    endpoint: "local",
    root: "",
    credentialRef: "",
    enabled: false,
    localPath: "C:/backups/nb",
  }

  it("合法本地文件夹配置一次通过", () => {
    expect(validateSyncConfig(localBase)).toEqual([])
  })

  it("本地路径缺失或空白逐条拒绝", () => {
    expect(validateSyncConfig({ ...localBase, localPath: "" })).toContain(
      "localPath must be an absolute directory path",
    )
    expect(validateSyncConfig({ ...localBase, localPath: "   " })).toContain(
      "localPath must be an absolute directory path",
    )
  })

  it("本地相对路径与含 .. 逐条拒绝", () => {
    expect(validateSyncConfig({ ...localBase, localPath: "rel/dir" })).toContain(
      "localPath must be an absolute path",
    )
    expect(validateSyncConfig({ ...localBase, localPath: "C:/a/../b" })).toContain(
      "localPath must not contain '..'",
    )
  })

  it("本地目标携带 credentialRef 即拒", () => {
    expect(validateSyncConfig({ ...localBase, credentialRef: "nb:webdav:x" })).toContain(
      "a local folder target must not carry a credentialRef",
    )
  })

  it("UNC 与 POSIX 绝对路径被接受", () => {
    expect(validateSyncConfig({ ...localBase, localPath: "\\\\nas\\nb" })).toEqual([])
    expect(validateSyncConfig({ ...localBase, localPath: "/mnt/nb" })).toEqual([])
  })

  const githubBase: SyncConfig = {
    endpoint: "github",
    root: "",
    credentialRef: "nb:github:octo",
    enabled: true,
    github: { owner: "octo", repo: "vault", branch: "main", pathPrefix: "nb" },
  }

  it("合法 GitHub 配置一次通过", () => {
    expect(validateSyncConfig(githubBase)).toEqual([])
  })

  it("github 块缺失即拒", () => {
    const { github: _drop, ...noBlock } = githubBase
    void _drop
    expect(validateSyncConfig(noBlock)).toContain(
      "github block is required when endpoint is 'github'",
    )
  })

  it("owner 与 repo 空值及非法字符逐条拒绝", () => {
    expect(
      validateSyncConfig({ ...githubBase, github: { ...githubBase.github!, owner: "  " } }),
    ).toContain("github owner must not be empty")
    expect(
      validateSyncConfig({ ...githubBase, github: { ...githubBase.github!, repo: "a/b" } }),
    ).toContain("github repo must match [A-Za-z0-9._-]: a/b")
  })

  it("branch 空与非法形态逐条拒绝", () => {
    const bad = (branch: string) =>
      validateSyncConfig({ ...githubBase, github: { ...githubBase.github!, branch } })
    expect(bad("   ")).toContain("github branch must not be empty")
    expect(bad("/main")).toContain("github branch must be a relative ref without '..': /main")
    expect(bad("a/../b")).toContain("github branch must be a relative ref without '..': a/../b")
    expect(bad("feat a")).toContain("github branch must match [A-Za-z0-9._/-]: feat a")
    expect(bad("release/v1")).toEqual([])
  })

  it("pathPrefix 绝对路径与含 .. 或反斜杠即拒", () => {
    const bad = (pathPrefix: string) =>
      validateSyncConfig({ ...githubBase, github: { ...githubBase.github!, pathPrefix } })
    expect(bad("/x")).toContain("github pathPrefix must be a relative POSIX prefix without '..': /x")
    expect(bad("a/../b")).toContain("github pathPrefix must be a relative POSIX prefix without '..': a/../b")
    expect(bad("a\\b")).toContain("github pathPrefix must be a relative POSIX prefix without '..': a\\b")
  })

  it("GitHub 目标凭据域错误即拒", () => {
    expect(validateSyncConfig({ ...githubBase, credentialRef: "nb:webdav:x" })).toContain(
      "github credentialRef must start with 'nb:github:'",
    )
  })

  it("非法调度档位即拒，合法档位放行", () => {
    expect(
      validateSyncConfig({ ...validConfig, schedule: { intervalMinutes: 7 as never } }),
    ).toContain("schedule.intervalMinutes must be one of 15 / 30 / 60")
    expect(validateSyncConfig({ ...validConfig, schedule: { intervalMinutes: 30 } })).toEqual([])
  })

  it("endpoint 含空格即拒", () => {
    expect(validateSyncConfig({ ...validConfig, endpoint: "https://a b.com" })).toContain(
      "endpoint must not contain spaces",
    )
  })

  it("疑似密钥明文的 credentialRef 被点名", () => {
    const reasons = validateSyncConfig({ ...validConfig, credentialRef: "nb:token-abc" })
    expect(reasons.some((r) => r.includes("credentialRef must be a reference"))).toBe(true)
  })
})

describe("configureCloudBackup 传输块映射（toRaw）", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it("本地目标：凭据与 root 清空、local 块透传裁剪后路径", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    await configureCloudBackup("C:/proj", {
      endpoint: "local",
      root: "should-be-cleared",
      credentialRef: "",
      enabled: true,
      localPath: "  D:/nb  ",
    })
    expect(invoke).toHaveBeenCalledWith("sync_configure", {
      projectPath: "C:/proj",
      config: {
        endpoint: "local",
        root: "",
        credential_ref: "",
        enabled: true,
        local: { localPath: "D:/nb" },
      },
    })
  })

  it("GitHub 目标：github 块透传", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    const github = { owner: "o", repo: "r", branch: "main", pathPrefix: "" }
    await configureCloudBackup("C:/proj", {
      endpoint: "github",
      root: "",
      credentialRef: "nb:github:o",
      enabled: true,
      github,
    })
    expect(invoke).toHaveBeenCalledWith("sync_configure", {
      projectPath: "C:/proj",
      config: {
        endpoint: "github",
        root: "",
        credential_ref: "nb:github:o",
        enabled: true,
        github,
      },
    })
  })

  it("调度块随配置透传", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    await configureCloudBackup("C:/proj", {
      ...validConfig,
      schedule: { intervalMinutes: 60 },
    })
    expect(invoke).toHaveBeenLastCalledWith("sync_configure", {
      projectPath: "C:/proj",
      config: expect.objectContaining({ schedule: { intervalMinutes: 60 } }),
    })
  })
})

describe("G2a 调度与配置读回", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it("未配置读回 null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null)
    await expect(readCloudBackupConfig("C:/proj")).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledWith("sync_config_read", { projectPath: "C:/proj" })
  })

  it("读回完整视图：local 与 github 透传，非法 schedule 档位丢弃", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      endpoint: "github",
      root: "",
      credential_ref: "nb:github:o",
      enabled: true,
      local: { localPath: "D:/nb" },
      github: { owner: "o", repo: "r", branch: "main", pathPrefix: "" },
      schedule: { intervalMinutes: 999 },
    })
    const cfg = await readCloudBackupConfig("C:/proj")
    expect(cfg?.github?.repo).toBe("r")
    expect(cfg?.localPath).toBe("D:/nb")
    expect(cfg?.schedule).toBeUndefined()
    expect(cfg?.enabled).toBe(true)
  })

  it("读回合规 schedule 档位保留", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      endpoint: "https://dav.example.com",
      root: "r",
      credential_ref: "nb:webdav:x",
      enabled: false,
      schedule: { intervalMinutes: 15 },
    })
    await expect(readCloudBackupConfig("C:/proj")).resolves.toMatchObject({
      schedule: { intervalMinutes: 15 },
    })
  })

  it("runSyncNow 与调度器启停查走各自命令并映射 snake_case", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "sync_now") {
        return { ran: true, manifest_id: "m", revision: 3, decision: "apply", message: "ok" }
      }
      if (
        cmd === "sync_scheduler_start" ||
        cmd === "sync_scheduler_stop" ||
        cmd === "sync_scheduler_status"
      ) {
        return {
          running: true,
          project_path: "C:/proj",
          interval_minutes: 15,
          sync_enabled: true,
          last_outcome: "ok",
        }
      }
      throw new Error(`unexpected ${cmd}`)
    })
    const tick = await runSyncNow("C:/proj", "dev-1")
    expect(tick).toMatchObject({ ran: true, manifestId: "m", revision: 3, decision: "apply" })
    expect(invoke).toHaveBeenCalledWith("sync_now", {
      projectPath: "C:/proj",
      deviceId: "dev-1",
    })

    const started = await startSyncScheduler("C:/proj", "dev-1", 30)
    expect(started).toMatchObject({ running: true, intervalMinutes: 15, syncEnabled: true })
    expect(invoke).toHaveBeenCalledWith("sync_scheduler_start", {
      projectPath: "C:/proj",
      deviceId: "dev-1",
      intervalMinutes: 30,
    })

    const stopped = await stopSyncScheduler()
    expect(stopped.running).toBe(true)
    const status = await readSyncSchedulerStatus()
    expect(status.lastOutcome).toBe("ok")
  })

  it("skip 原因透传（ran=false 时 skipReason 说明原因）", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      ran: false,
      skip_reason: "disabled",
      manifest_id: "",
      revision: 0,
      decision: "",
      message: "off",
    })
    await expect(runSyncNow("C:/proj", "d")).resolves.toMatchObject({
      ran: false,
      skipReason: "disabled",
    })
  })
})
