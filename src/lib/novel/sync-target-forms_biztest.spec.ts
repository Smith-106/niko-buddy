/**
 * sync-target-forms_biztest.spec.ts — 业务验收 B1（同步目标三形态 + 全局开关）。
 *
 * 这一组用例**不是**重跑 sync-client 的逐条镜像判定，而是回答用户视角的问题：
 *
 *   B1-a 「我在设置里选 WebDAV / GitHub 私有仓 / 本地文件夹，点保存 → 立即同步，
 *         三种选法是不是走同一条路？」——断言三种形态都经**同一组** IPC 命令
 *         `sync_configure` → `sync_push` → `sync_pull`，且各自载荷按形态成形
 *         （WebDAV 四字段 / github 块 / local 块），返回结果映射成同一域模型。
 *   B1-b 「我把总开关关掉，还会不会自己在后台同步？」——断言默认关闭、
 *         关闭时调度器启动被拒（Rust 门禁原样透出），手动/自动周期只回报
 *         `skip_reason=disabled` 而**不推送**。
 *
 * 传输层 IO（真实 HTTP / 真实私有仓）不在此处：这里守的是「同一入口 + 同一裁决」
 * 这条用户可见契约；各传输实现自身的落盘/校验由 Rust 侧单测覆盖（见 run report）。
 *
 * ⚠️ 已知缺陷（本文件第 2 个用例故意红）：`validateSyncConfig` 没有 GitHub 分支，
 * `endpoint === "github"` 被当成 WebDAV 端点校验 → 返回 "endpoint must be an http(s) URL"。
 * 后果：CloudBackupPanel 的「保存」按钮 `disabled={busy || !configValid}` 恒禁用，
 * GitHub 目标**无法从界面保存**。用例保持「期望行为」写法（红），不改成迁就缺陷。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))

import { invoke } from "@tauri-apps/api/core"
import { GITHUB_SYNC_ENDPOINT, syncConfigureCommand, syncEnabled } from "@/commands/sync"
import {
  DEFAULT_SYNC_ENABLED,
  configureCloudBackup,
  pullCloudBackup,
  pushCloudBackup,
  runSyncNow,
  startSyncScheduler,
  validateSyncConfig,
  type SyncConfig,
} from "./sync-client"

const PROJECT = "C:/novel/demo"
const DEVICE = "device-a"
const ARTIFACT = "C:/novel/demo/backups/auto/20261102-120000.zip"

const webdavConfig: SyncConfig = {
  endpoint: "https://dav.example.com",
  root: "niko-buddy/backups",
  credentialRef: "nb:webdav:niko",
  enabled: true,
}

const githubConfig: SyncConfig = {
  endpoint: "github",
  root: "",
  credentialRef: "nb:github:niko",
  enabled: true,
  github: { owner: "niko", repo: "novel-backups", branch: "main", pathPrefix: "backups/qmai" },
}

const localConfig: SyncConfig = {
  endpoint: "local",
  root: "",
  credentialRef: "",
  enabled: true,
  localPath: "D:/paired/novel",
}

function wirePush(prefix: string) {
  return {
    manifest_id: "20261102-120000",
    revision: 1,
    content_hash: "a".repeat(64),
    block_count: 2,
    total_bytes: 2048,
    remote_prefix: prefix,
  }
}

function wirePull(snapshotDir: string) {
  return {
    manifest_id: "20261102-120000",
    remote_revision: 1,
    decision: "apply",
    snapshot_dir: snapshotDir,
    message: "pulled as snapshot",
  }
}

/** 让一次「保存 → 推送 → 拉取」走完，返回实际发出的命令序列。 */
async function runOneCycle(prefix: string): Promise<string[]> {
  vi.mocked(invoke).mockReset()
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    switch (command) {
      case "sync_configure":
        return undefined
      case "sync_push":
        return wirePush(prefix)
      case "sync_pull":
        return wirePull(`${PROJECT}/.novel/snapshots/remote-20261102-120000-rev-1`)
      default:
        throw new Error(`unexpected command ${command}`)
    }
  })
  const pushed = await pushCloudBackup(PROJECT, ARTIFACT, DEVICE)
  const pulled = await pullCloudBackup(PROJECT, pushed.manifestId, DEVICE)
  expect(pushed.blockCount).toBe(2)
  expect(pulled.decision).toBe("apply")
  return vi.mocked(invoke).mock.calls.map(([command]) => String(command))
}

beforeEach(() => {
  vi.mocked(invoke).mockReset()
})

describe("B1-a 同步目标三形态：同一 configure → push → pull 入口", () => {
  it("WebDAV 形态：经同一组 IPC 命令走完一次同步", async () => {
    await configureCloudBackup(PROJECT, webdavConfig)
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("sync_configure", {
      projectPath: PROJECT,
      config: {
        endpoint: "https://dav.example.com",
        root: "niko-buddy/backups",
        credential_ref: "nb:webdav:niko",
        enabled: true,
      },
    })
    expect(await runOneCycle("remote/webdav")).toEqual(["sync_push", "sync_pull"])
  })

  it("本地文件夹形态：经同一组 IPC 命令走完一次同步（凭据与远端前缀清空）", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    await configureCloudBackup(PROJECT, localConfig)
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("sync_configure", {
      projectPath: PROJECT,
      config: {
        endpoint: "local",
        root: "",
        credential_ref: "",
        enabled: true,
        local: { localPath: "D:/paired/novel" },
      },
    })
    expect(await runOneCycle("remote/local")).toEqual(["sync_push", "sync_pull"])
  })

  it("GitHub 形态：经同一组 IPC 命令走完一次同步（期望行为；当前被前端校验误拒）", async () => {
    // 期望：GitHub 目标与另两种形态一样，能保存并通过同一入口同步。
    expect(validateSyncConfig(githubConfig)).toEqual([])
    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    await configureCloudBackup(PROJECT, githubConfig)
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("sync_configure", {
      projectPath: PROJECT,
      config: {
        endpoint: GITHUB_SYNC_ENDPOINT,
        root: "",
        credential_ref: "nb:github:niko",
        enabled: true,
        github: { owner: "niko", repo: "novel-backups", branch: "main", pathPrefix: "backups/qmai" },
      },
    })
    expect(await runOneCycle("remote/github")).toEqual(["sync_push", "sync_pull"])
  })

  it("GitHub 载荷本身是对的（缺陷只在前端校验，不在线上契约）", async () => {
    // 绕过 `validateSyncConfig` 直接发命令：Rust 侧接受的正是这一份载荷。
    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    await syncConfigureCommand(PROJECT, {
      endpoint: GITHUB_SYNC_ENDPOINT,
      root: "",
      credential_ref: "nb:github:niko",
      enabled: true,
      github: { owner: "niko", repo: "novel-backups", branch: "main", pathPrefix: "backups/qmai" },
    })
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("sync_configure", {
      projectPath: PROJECT,
      config: {
        endpoint: "github",
        root: "",
        credential_ref: "nb:github:niko",
        enabled: true,
        github: { owner: "niko", repo: "novel-backups", branch: "main", pathPrefix: "backups/qmai" },
      },
    })
  })

  it("三形态的拉取裁决是同一套语义（apply / keep_both / refuse_stale）", async () => {
    for (const decision of ["apply", "keep_both", "refuse_stale"] as const) {
      vi.mocked(invoke).mockResolvedValueOnce({
        manifest_id: "m",
        remote_revision: 3,
        decision,
        snapshot_dir: decision === "refuse_stale" ? undefined : "C:/novel/demo/.novel/snapshots/s",
        conflict_path:
          decision === "keep_both" ? "C:/novel/demo/.novel/.conflict-device-b-1" : undefined,
        message: decision,
      })
      const pulled = await pullCloudBackup(PROJECT, "m", DEVICE)
      expect(pulled.decision).toBe(decision)
    }
  })
})

describe("B1-b 全局开关：关掉之后没有自动触发", () => {
  it("默认值是关闭，且「读不出开关」一律当关闭", () => {
    expect(DEFAULT_SYNC_ENABLED).toBe(false)
    expect(syncEnabled({ enabled: DEFAULT_SYNC_ENABLED })).toBe(false)
    expect(syncEnabled({ enabled: true })).toBe(true)
    // 缺字段 / 非布尔值（旧配置 / 手改 JSON）不得被当成「开着」。
    const missing = { enabled: undefined } as unknown as { enabled: boolean }
    expect(syncEnabled(missing)).toBe(false)
    const garbage = { enabled: "true" } as unknown as { enabled: boolean }
    expect(syncEnabled(garbage)).toBe(false)
  })

  it("关闭态启动调度器被 Rust 门禁拒绝（用户看到失败，而不是「看起来在跑」）", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("global sync switch is off")
    await expect(startSyncScheduler(PROJECT, DEVICE, 15)).rejects.toBe("global sync switch is off")
  })

  it("关闭态的一次周期只回报 disabled，不产生推送/拉取", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      ran: false,
      skip_reason: "disabled",
      manifest_id: "",
      revision: 0,
      decision: "",
      message: "global sync switch is off",
    })

    const tick = await runSyncNow(PROJECT, DEVICE)

    expect(tick.ran).toBe(false)
    expect(tick.skipReason).toBe("disabled")
    // 只有一次 sync_now 调用：没有任何隐式 push/pull 被触发。
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("sync_now", {
      projectPath: PROJECT,
      deviceId: DEVICE,
    })
    expect(vi.mocked(invoke).mock.calls.map(([command]) => String(command))).not.toContain("sync_push")
  })

  it("开着但未配置目标 → 周期同样只回报 skip（不凭空造产物）", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      ran: false,
      skip_reason: "not_configured",
      manifest_id: "",
      revision: 0,
      decision: "",
      message: "sync target is not configured",
    })
    const tick = await runSyncNow(PROJECT, DEVICE)
    expect(tick.ran).toBe(false)
    expect(tick.skipReason).toBe("not_configured")
  })
})
