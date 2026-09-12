import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT, collectErrors } from "./tauri-mock"

/**
 * F-004 云端备份的 e2e（TASK-008 verify 项三）。
 *
 * **范围声明（诚实边界）**：本 spec 覆盖的是**页面内 IPC 边界**——浏览器环境下的
 * `window.__TAURI_INTERNALS__.invoke` 信封形状与失败语义（配置无明文护栏 / 远端键守卫 /
 * 拉取三态裁决 / 冲突默认裁决），以及应用启动契约。它**不**驱动 `CloudBackupPanel` 的
 * UI 走查：该面板目前尚未被应用壳层挂载（无宿主调用方），因此没有可点击入口可走。
 * 该缺口已在波次记录中显式登记为待接线项，不以本 spec 冒充覆盖。
 *
 * Rust 侧的安全语义（块寻址 / 逐块校验 / 拒绝旧远端 / 冲突副本落盘 / 真值面拒绝）
 * 由 `src-tauri/src/commands/sync_target.rs` 的内联 `#[cfg(test)]` 用例覆盖：
 * `older_remote_does_not_overwrite` / `conflict_preserves_copy` / `pull_cannot_write_qm`。
 */

async function invokeInPage(
  page: Page,
  cmd: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return page.evaluate((payload) => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
      }
    }
    return w.__TAURI_INTERNALS__.invoke(payload.cmd, payload.args)
  }, { cmd, args })
}

async function rejectedMessage(
  page: Page,
  cmd: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    await invokeInPage(page, cmd, args)
    return ""
  } catch (cause) {
    return String(cause)
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(MOCK_INIT)
})

test("cloud backup IPC enforces the no-plaintext config and the pull decision contract", async ({
  page,
}) => {
  const errors = collectErrors(page)
  await page.goto("/")
  await expect(page.locator("#root")).not.toBeEmpty()

  // 配置：只允许四个白名单字段（凭据引用，不是密钥本体）。
  await invokeInPage(page, "sync_configure", {
    projectPath: "C:/mock/proj",
    config: {
      endpoint: "https://dav.example.com",
      root: "niko-buddy/backups",
      credential_ref: "nb:webdav:proj-42",
      enabled: true,
    },
  })
  const refusedSecret = await rejectedMessage(page, "sync_configure", {
    projectPath: "C:/mock/proj",
    config: {
      endpoint: "https://dav.example.com",
      root: "niko-buddy/backups",
      credential_ref: "nb:webdav:proj-42",
      enabled: true,
      password: "hunter2",
    },
  })
  expect(refusedSecret).toContain("key material")

  const refusedRef = await rejectedMessage(page, "sync_configure", {
    projectPath: "C:/mock/proj",
    config: {
      endpoint: "https://dav.example.com",
      root: "niko-buddy/backups",
      credential_ref: "plain-token",
      enabled: true,
    },
  })
  expect(refusedRef).toContain("credential_ref")

  // 状态与连接测试：凭据可用、可达。
  const status = (await invokeInPage(page, "sync_status", { projectPath: "C:/mock/proj" })) as {
    configured: boolean
    enabled: boolean
    credential_ref: string
    journal_entries: number
  }
  expect(status.configured).toBe(true)
  expect(status.enabled).toBe(true)
  expect(status.credential_ref.startsWith("nb:")).toBe(true)

  const tested = (await invokeInPage(page, "sync_test", { projectPath: "C:/mock/proj" })) as {
    ok: boolean
    reachable: boolean
    credential_available: boolean
  }
  expect(tested.ok).toBe(true)
  expect(tested.reachable).toBe(true)
  expect(tested.credential_available).toBe(true)

  // 推送：显式产物是唯一传输对象；空产物即拒。
  const noArtifact = await rejectedMessage(page, "sync_push", {
    projectPath: "C:/mock/proj",
    artifactPath: "",
    deviceId: "device-a",
  })
  expect(noArtifact).toContain("artifact not found")

  // 远端键不得镜像本地真值面。
  const truthMirror = await rejectedMessage(page, "sync_push", {
    projectPath: "C:/mock/proj",
    artifactPath: "C:/mock/proj/QM/book-analysis/artifact.zip",
    deviceId: "device-a",
  })
  expect(truthMirror).toContain("truth surface")

  const pushed = (await invokeInPage(page, "sync_push", {
    projectPath: "C:/mock/proj",
    artifactPath: "C:/mock/proj/backups/auto/20260912-artifact.zip",
    deviceId: "device-a",
  })) as { manifest_id: string; revision: number; content_hash: string; block_count: number }
  expect(pushed.manifest_id).toBe("demo")
  expect(pushed.revision).toBeGreaterThan(0)
  expect(pushed.content_hash).toHaveLength(64)

  // 拉取三态：远端更旧 → 拒绝（无快照、无冲突）；真分歧 → 保留两者；否则快照入库。
  const stale = (await invokeInPage(page, "sync_pull", {
    projectPath: "C:/mock/proj",
    manifestId: "demo-stale",
    deviceId: "device-b",
  })) as { decision: string; snapshot_dir?: string; conflict_path?: string }
  expect(stale.decision).toBe("refuse_stale")
  expect(stale.snapshot_dir).toBeUndefined()
  expect(stale.conflict_path).toBeUndefined()

  const diverged = (await invokeInPage(page, "sync_pull", {
    projectPath: "C:/mock/proj",
    manifestId: "demo-diverge",
    deviceId: "device-b",
  })) as { decision: string; conflict_path?: string }
  expect(diverged.decision).toBe("keep_both")
  expect(diverged.conflict_path).toContain(".conflict-device-b-")

  const applied = (await invokeInPage(page, "sync_pull", {
    projectPath: "C:/mock/proj",
    manifestId: "demo",
    deviceId: "device-b",
  })) as { decision: string; snapshot_dir?: string }
  expect(applied.decision).toBe("apply")
  expect(applied.snapshot_dir).toContain(".novel/snapshots/")

  // 真值面拒绝：指向 canon 的项目路径一律拒（远端副本永非真值）。
  const truthDenied = await rejectedMessage(page, "sync_pull", {
    projectPath: "C:/mock/proj/canon",
    manifestId: "demo",
    deviceId: "device-b",
  })
  expect(truthDenied).toContain("never truth")

  // 冲突裁决出口：默认「保留两者」。
  await page.evaluate(() => {
    const w = window as unknown as { __MOCK_CLOUD__: Record<string, unknown> }
    w.__MOCK_CLOUD__.conflicts = [
      {
        name: ".conflict-device-b-20260912130000",
        path: "C:/mock/proj/.novel/.conflict-device-b-20260912130000",
        size: 4096,
        default_resolution: "keep_both",
      },
    ]
  })
  const conflicts = (await invokeInPage(page, "sync_conflicts", {
    projectPath: "C:/mock/proj",
  })) as Array<{ name: string; default_resolution: string; size: number }>
  expect(conflicts).toHaveLength(1)
  expect(conflicts[0].name).toContain(".conflict-device-b-")
  expect(conflicts[0].default_resolution).toBe("keep_both")
  expect(conflicts[0].size).toBeGreaterThan(0)

  expect(errors, `unexpected console/page errors: ${errors.join(" || ")}`).toEqual([])
})
