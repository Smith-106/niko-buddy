// @vitest-environment jsdom
/**
 * cloud-backup-batches_biztest.spec.tsx — 业务验收 B2 + B3 的**用户可见面**。
 *
 * 前面 `sync-per-item-pick_biztest.spec.ts` 守的是线上契约；这里直接把云备份面板
 * 渲染出来，断言用户真的能看到 / 能操作到：
 *
 *   B3 「同步完，我展开一个批次，能看到每一项的文件、方向、状态、错误吗？」
 *      → 批次行可展开；展开后每项渲染 path / direction / status；失败项显示错误原因；
 *        无 base 的老批次明说「只能保留两者」。
 *   B2 「双改的那一项，我能选『采用本地 / 采用远端 / 保留两者』吗？没 base 的那项呢？」
 *      → 可逐项选择的项给三选一下拉；不可选的项给**置灰**下拉且只有 keep_both；
 *        点「应用」只提交可逐项选择的项，且未选择时提交的是 keep_both（默认终止态）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor, within } from "@/test-helpers/component-test-utils"

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@/lib/platform", () => ({ isTauri: () => true }))

import { CloudBackupPanel } from "./CloudBackupPanel"
import { PICK_KEEP_BOTH, PICK_MINE, PICK_THEIRS, type RawSyncBatch } from "@/commands/sync"

const PROJECT = "C:/novel/demo"
const DEVICE = "device-a"

const RAW_STATUS = {
  configured: true,
  enabled: true,
  endpoint: "local",
  root: "D:/paired/novel",
  credential_ref: "",
  credential_available: true,
  journal_entries: 4,
  last_direction: "conflict",
  last_manifest_id: "20261102-120000",
  last_revision: 3,
}

const RAW_CONFIG = {
  endpoint: "local",
  root: "",
  credential_ref: "",
  enabled: true,
  local: { localPath: "D:/paired/novel" },
  schedule: { intervalMinutes: 30 },
}

const RAW_SCHEDULER = {
  running: true,
  project_path: PROJECT,
  interval_minutes: 30,
  sync_enabled: true,
  last_run_at: "2026-11-02T12:00:00Z",
  next_run_at: "2026-11-02T12:30:00Z",
  last_outcome: "apply:3",
}

const batchWithBase: RawSyncBatch = {
  batch_id: "batch-1",
  manifest_id: "20261102-120000",
  revision: 3,
  direction: "conflict",
  device_id: DEVICE,
  ts: "20261102120000",
  content_hash: "a".repeat(64),
  base_rev: 2,
  base_content_hash: "b".repeat(64),
  base_available: true,
  status: "keep_both",
  duration_ms: 42,
  items: [
    {
      path: "chapters/01.md",
      direction: "conflict",
      status: "both_changed",
      duration_ms: 12,
      pickable: true,
      base_available: true,
      choices: [PICK_MINE, PICK_THEIRS, PICK_KEEP_BOTH],
      default_decision: PICK_KEEP_BOTH,
    },
    {
      path: "chapters/02.md",
      direction: "conflict",
      status: "theirs_only",
      duration_ms: 3,
      pickable: false,
      base_available: true,
      choices: [PICK_KEEP_BOTH],
      default_decision: PICK_KEEP_BOTH,
    },
  ],
}

const legacyBatchWithoutBase: RawSyncBatch = {
  batch_id: "batch-0",
  manifest_id: "20261101-090000",
  revision: 1,
  direction: "pull",
  device_id: DEVICE,
  ts: "20261101090000",
  content_hash: "c".repeat(64),
  base_available: false,
  status: "partial",
  duration_ms: 900,
  error: "one item failed",
  items: [
    {
      path: "chapters/03.md",
      direction: "pull",
      status: "no_base",
      duration_ms: 5,
      error: "remote read failed",
      pickable: false,
      base_available: false,
      choices: [PICK_KEEP_BOTH],
      default_decision: PICK_KEEP_BOTH,
    },
  ],
}

function installInvoke() {
  mocks.invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "sync_status":
        return RAW_STATUS
      case "sync_conflicts":
        return []
      case "sync_config_read":
        return RAW_CONFIG
      case "sync_batches":
        return [batchWithBase, legacyBatchWithoutBase]
      case "sync_scheduler_status":
        return RAW_SCHEDULER
      case "secret_available":
        return true
      case "sync_apply_per_item_decision":
        return [
          {
            path: "chapters/01.md",
            decision: PICK_KEEP_BOTH,
            status: "keep_both",
          },
        ]
      default:
        return undefined
    }
  })
}

beforeEach(() => {
  mocks.invoke.mockReset()
  installInvoke()
  ;(globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
})

afterEach(() => {
  cleanup()
  delete (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

async function renderPanel() {
  render(<CloudBackupPanel projectPath={PROJECT} deviceId={DEVICE} />)
  await waitFor(() => expect(screen.getByTestId("sync-batch-batch-1")).toBeInTheDocument())
}

describe("B3 批次明细（用户可见）", () => {
  it("按批次列出，展开后逐项显示文件 / 方向 / 状态 / 错误", async () => {
    await renderPanel()

    // 两个批次都在（有新有旧）。
    expect(screen.getByTestId("sync-batch-batch-1")).toBeInTheDocument()
    expect(screen.getByTestId("sync-batch-batch-0")).toBeInTheDocument()

    const withBase = screen.getByTestId("sync-batch-batch-1")
    fireEvent.click(within(withBase).getByRole("button", { name: "sync.batch.expand" }))

    const first = await waitFor(() => screen.getByTestId("sync-batch-item-chapters/01.md"))
    expect(first).toHaveTextContent("chapters/01.md")
    expect(first).toHaveTextContent("conflict")
    expect(within(withBase).getByTestId("sync-batch-item-chapters/02.md")).toBeInTheDocument()

    // 老批次：失败项的原因对用户可见，且明说「无 base」。
    const legacy = screen.getByTestId("sync-batch-batch-0")
    expect(within(legacy).getByTestId("sync-batch-no-base")).toBeInTheDocument()
    fireEvent.click(within(legacy).getByRole("button", { name: "sync.batch.expand" }))
    const failedItem = await waitFor(() => screen.getByTestId("sync-batch-item-chapters/03.md"))
    expect(failedItem).toHaveTextContent("remote read failed")
    expect(failedItem).toHaveTextContent("pull")
  })
})

describe("B2 双改逐项裁决（用户可见）", () => {
  it("可逐项选择的项给三选一；不可选的项置灰且只有「保留两者」", async () => {
    await renderPanel()
    const withBase = screen.getByTestId("sync-batch-batch-1")
    fireEvent.click(within(withBase).getByRole("button", { name: "sync.batch.expand" }))

    const pickableRow = await waitFor(() => screen.getByTestId("sync-batch-item-chapters/01.md"))
    const pickableSelect = within(pickableRow).getByLabelText("sync.batch.pick") as HTMLSelectElement
    expect(pickableSelect.disabled).toBe(false)
    expect([...pickableSelect.options].map((option) => option.value)).toEqual([
      PICK_MINE,
      PICK_THEIRS,
      PICK_KEEP_BOTH,
    ])
    // 默认选中「保留两者」——不选也不会变成覆盖。
    expect(pickableSelect.value).toBe(PICK_KEEP_BOTH)

    const singleSideRow = within(withBase).getByTestId("sync-batch-item-chapters/02.md")
    const singleSideSelect = within(singleSideRow).getByLabelText("sync.batch.pick") as HTMLSelectElement
    expect(singleSideSelect.disabled).toBe(true)
    expect([...singleSideSelect.options].map((option) => option.value)).toEqual([PICK_KEEP_BOTH])
  })

  it("无 base 的批次：每一项都不可选（只有 keep_both）", async () => {
    await renderPanel()
    const legacy = screen.getByTestId("sync-batch-batch-0")
    fireEvent.click(within(legacy).getByRole("button", { name: "sync.batch.expand" }))

    const row = await waitFor(() => screen.getByTestId("sync-batch-item-chapters/03.md"))
    const select = within(row).getByLabelText("sync.batch.pick") as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect([...select.options].map((option) => option.value)).toEqual([PICK_KEEP_BOTH])
  })

  it("点「应用」只提交可逐项选择的项，未选择时裁决是 keep_both，并带显式 actor", async () => {
    await renderPanel()
    const withBase = screen.getByTestId("sync-batch-batch-1")
    fireEvent.click(within(withBase).getByRole("button", { name: "sync.batch.expand" }))
    await waitFor(() => screen.getByTestId("sync-batch-item-chapters/01.md"))

    fireEvent.click(within(withBase).getByRole("button", { name: "sync.batch.apply" }))

    await waitFor(() => {
      const call = mocks.invoke.mock.calls.find(
        ([command]) => command === "sync_apply_per_item_decision",
      )
      expect(call).toBeDefined()
    })

    const call = mocks.invoke.mock.calls.find(
      ([command]) => command === "sync_apply_per_item_decision",
    )!
    const payload = call[1] as {
      projectPath: string
      manifestId: string
      revision: number
      direction: string
      ts: string
      deviceId: string
      actor: string
      items: { path: string; decision: string }[]
    }
    expect(payload.projectPath).toBe(PROJECT)
    expect(payload.manifestId).toBe("20261102-120000")
    expect(payload.revision).toBe(3)
    expect(payload.direction).toBe("conflict")
    expect(payload.ts).toBe("20261102120000")
    // 显式用户动作：actor 是本机标识，Rust 侧空 actor 直接拒绝。
    expect(payload.actor).toBe(DEVICE)
    // 只提交可逐项选择的项（chapters/02.md 不可选 → 不提交）。
    expect(payload.items).toEqual([{ path: "chapters/01.md", decision: PICK_KEEP_BOTH }])
  })

  it("无 base 的批次没有可选项 → 「应用」按钮禁用（用户不会误以为能覆盖）", async () => {
    await renderPanel()
    const legacy = screen.getByTestId("sync-batch-batch-0")
    fireEvent.click(within(legacy).getByRole("button", { name: "sync.batch.expand" }))
    await waitFor(() => screen.getByTestId("sync-batch-item-chapters/03.md"))
    expect(within(legacy).getByRole("button", { name: "sync.batch.apply" })).toBeDisabled()
  })
})
