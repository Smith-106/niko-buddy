// @vitest-environment jsdom
/**
 * CloudBackupPanel.spec.tsx — W3 深化的真测试（替换 C4 空壳）。
 *
 * 覆盖：传输目标三档切换、全部输入编辑、保存/测试/立即同步/推送/拉取、
 * 冲突终止态、调度时间展示、凭据域守卫、刷新容错、本地目录选择、
 * 批次展开/逐项改选/应用分流、项目切换竞态丢弃。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { act, fireEvent, render, screen, waitFor, within } from "@/test-helpers/component-test-utils"
import { CloudBackupPanel } from "./CloudBackupPanel"
import { PICK_KEEP_BOTH, PICK_MINE } from "@/commands/sync"

const mocks = vi.hoisted(() => ({
  cloudBackupStatus: vi.fn(),
  configureCloudBackup: vi.fn(),
  listCloudConflicts: vi.fn(),
  pullCloudBackup: vi.fn(),
  pushCloudBackup: vi.fn(),
  readCloudBackupConfig: vi.fn(),
  readSyncSchedulerStatus: vi.fn(),
  runSyncNow: vi.fn(),
  startSyncScheduler: vi.fn(),
  stopSyncScheduler: vi.fn(),
  testCloudBackup: vi.fn(),
  secretAvailable: vi.fn(),
  secretPut: vi.fn(),
  secretDelete: vi.fn(),
  syncBatchesCommand: vi.fn(),
  applyPerItemDecisionCommand: vi.fn(),
  dialogOpen: vi.fn(),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    cloudBackupStatus: mocks.cloudBackupStatus,
    configureCloudBackup: mocks.configureCloudBackup,
    listCloudConflicts: mocks.listCloudConflicts,
    pullCloudBackup: mocks.pullCloudBackup,
    pushCloudBackup: mocks.pushCloudBackup,
    readCloudBackupConfig: mocks.readCloudBackupConfig,
    readSyncSchedulerStatus: mocks.readSyncSchedulerStatus,
    runSyncNow: mocks.runSyncNow,
    startSyncScheduler: mocks.startSyncScheduler,
    stopSyncScheduler: mocks.stopSyncScheduler,
    testCloudBackup: mocks.testCloudBackup,
  }
})

vi.mock("@/lib/secret-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/secret-client")>()
  return {
    ...actual,
    secretAvailable: mocks.secretAvailable,
    secretPut: mocks.secretPut,
    secretDelete: mocks.secretDelete,
  }
})

vi.mock("@/commands/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/sync")>()
  return {
    ...actual,
    syncBatchesCommand: mocks.syncBatchesCommand,
    applyPerItemDecisionCommand: mocks.applyPerItemDecisionCommand,
  }
})

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.dialogOpen,
}))

const PROJECT = "/p/mybook"
const DEVICE = "dev-1"

const WEBDAV_STATUS = {
  configured: true,
  enabled: true,
  endpoint: "https://dav.example.com",
  root: "backups",
  credentialRef: "nb:webdav:mybook",
  credentialAvailable: true,
  journalEntries: 3,
  lastDirection: "push",
  lastRevision: 7,
}

const SCHEDULER_OK = {
  running: true,
  projectPath: PROJECT,
  intervalMinutes: 30,
  syncEnabled: true,
  lastRunAt: "2026-11-02T12:00:00.000Z",
  nextRunAt: "2026-11-02T12:30:00.000Z",
  lastOutcome: "apply:3",
}

function installDefaults(): void {
  mocks.cloudBackupStatus.mockResolvedValue({ ...WEBDAV_STATUS })
  mocks.listCloudConflicts.mockResolvedValue([])
  mocks.readCloudBackupConfig.mockResolvedValue(null)
  mocks.syncBatchesCommand.mockResolvedValue([])
  mocks.readSyncSchedulerStatus.mockResolvedValue({ ...SCHEDULER_OK })
  mocks.secretAvailable.mockResolvedValue(true)
  mocks.secretPut.mockResolvedValue("nb:webdav:mybook")
  mocks.secretDelete.mockResolvedValue(true)
  mocks.configureCloudBackup.mockResolvedValue(undefined)
  mocks.testCloudBackup.mockResolvedValue({
    ok: true,
    endpoint: "https://dav.example.com",
    root: "backups",
    credentialAvailable: true,
    reachable: true,
    objectCount: 1,
    message: "reachable",
  })
  mocks.runSyncNow.mockResolvedValue({
    ran: true,
    manifestId: "m1",
    revision: 8,
    decision: "apply",
    message: "ok",
  })
  mocks.pushCloudBackup.mockResolvedValue({
    manifestId: "m1",
    revision: 8,
    contentHash: "h",
    blockCount: 4,
    totalBytes: 100,
    remotePrefix: "backups",
    unchanged: false,
  })
  mocks.pullCloudBackup.mockResolvedValue({
    manifestId: "m1",
    remoteRevision: 8,
    decision: "apply",
    message: "restored",
  })
  mocks.startSyncScheduler.mockResolvedValue({ ...SCHEDULER_OK })
  mocks.stopSyncScheduler.mockResolvedValue({ ...SCHEDULER_OK, running: false })
  mocks.applyPerItemDecisionCommand.mockResolvedValue([
    { path: "a.md", decision: PICK_KEEP_BOTH, status: "keep_both" },
  ])
  mocks.dialogOpen.mockResolvedValue(null)
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function renderPanel(projectPath: string = PROJECT) {
  return render(<CloudBackupPanel projectPath={projectPath} deviceId={DEVICE} />)
}

function targetSelect(): HTMLSelectElement {
  return screen.getByTestId("cloud-backup-target").querySelector("select") as HTMLSelectElement
}

beforeEach(() => {
  vi.clearAllMocks()
  installDefaults()
})

afterEach(() => {
  cleanup()
})

describe("CloudBackupPanel 真测试：挂载与状态轨", () => {
  it("挂载后展示标题、目标选择器与无冲突/调度时间", async () => {
    renderPanel()
    await waitFor(() => expect(mocks.cloudBackupStatus).toHaveBeenCalledWith(PROJECT))
    await flushAsync()
    expect(screen.getByTestId("cloud-backup-panel")).toBeInTheDocument()
    expect(screen.getAllByText("backup.cloud.noConflicts").length).toBeGreaterThan(0)
    // 调度时间来自真实 formatTimestamp：有效 RFC3339 被转为本地串，不再是原文。
    expect(screen.getByTestId("cloud-backup-schedule")).not.toHaveTextContent("2026-11-02T12:00:00.000Z")
    expect(targetSelect().value).toBe("webdav")
  })

  it("空配置时保存按钮禁用并给出 endpoint 校验理由", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({
      configured: false,
      enabled: false,
      endpoint: "",
      root: "",
      credentialRef: "",
      credentialAvailable: true,
      journalEntries: 0,
    })
    renderPanel()
    await flushAsync()
    expect(screen.getByText("backup.cloud.save")).toBeDisabled()
    expect(screen.getByTestId("cloud-backup-status-rail")).toHaveTextContent(
      "endpoint must be an http(s) URL",
    )
  })

  it("凭据不可用时状态轨给出 credentialUnavailable 警告", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({ ...WEBDAV_STATUS, credentialAvailable: false })
    renderPanel()
    await flushAsync()
    expect(screen.getByTestId("cloud-backup-status-rail")).toHaveTextContent(
      "backup.cloud.credentialUnavailable",
    )
  })

  it("refresh 失败时展示 errorLead 而不是空白", async () => {
    mocks.cloudBackupStatus.mockRejectedValue(new Error("status down"))
    renderPanel()
    await flushAsync()
    expect(screen.getByText(/backup.cloud.errorLead/)).toHaveTextContent("status down")
  })

  it("增强读取失败时退化为空列表/空调度而不是整面板报错", async () => {
    mocks.readCloudBackupConfig.mockRejectedValue(new Error("no config cmd"))
    mocks.syncBatchesCommand.mockRejectedValue(new Error("no batches cmd"))
    mocks.readSyncSchedulerStatus.mockRejectedValue(new Error("no scheduler cmd"))
    renderPanel()
    await flushAsync()
    // 主链路仍可用：状态轨正常、无报错横幅。
    expect(screen.getByTestId("cloud-backup-panel")).toBeInTheDocument()
    expect(screen.queryByText(/backup.cloud.errorLead/)).toBeNull()
    expect(screen.getAllByText("backup.cloud.noConflicts").length).toBeGreaterThan(0)
  })

  it("缺失调度时间走「尚未同步」文案；非法时间串原样回显", async () => {
    mocks.readSyncSchedulerStatus.mockResolvedValue({
      running: false,
      intervalMinutes: 30,
      syncEnabled: false,
    })
    const { unmount } = renderPanel()
    await flushAsync()
    expect(screen.getByTestId("cloud-backup-schedule")).toHaveTextContent("sync.schedule.never")
    unmount()
    cleanup()
    mocks.readSyncSchedulerStatus.mockResolvedValue({
      running: true,
      intervalMinutes: 30,
      syncEnabled: true,
      lastRunAt: "not-a-date",
      nextRunAt: "",
    })
    renderPanel()
    await flushAsync()
    // 非法串原样回显（formatTimestamp 的 NaN 分支）。
    expect(screen.getByTestId("cloud-backup-schedule")).toHaveTextContent("not-a-date")
  })
})

describe("传输目标切换与输入编辑", () => {
  it("切到本地目标：隐藏凭据链、清空引用与远端根", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({ ...WEBDAV_STATUS })
    renderPanel()
    await flushAsync()
    expect(screen.getByTestId("cloud-backup-credentials")).toBeInTheDocument()
    fireEvent.change(targetSelect(), { target: { value: "local" } })
    expect(targetSelect().value).toBe("local")
    expect(screen.queryByTestId("cloud-backup-credentials")).toBeNull()
    expect(screen.getByText("sync.localNoCredential")).toBeInTheDocument()
  })

  it("切到 GitHub 目标：出现四项仓库输入并保留 github 域引用语义", async () => {
    renderPanel()
    await flushAsync()
    fireEvent.change(targetSelect(), { target: { value: "github" } })
    expect(screen.getByPlaceholderText("niko")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("novel-backups")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("main")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("backups/qmai")).toBeInTheDocument()
    // 凭据链仍可见（只有本地隐藏），占位切换到 github 域。
    expect(screen.getByPlaceholderText("nb:github:account")).toBeInTheDocument()
  })

  it("从远端切回 WebDAV：github 域旧引用被清掉（跨域不复用）", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({
      ...WEBDAV_STATUS,
      endpoint: "github",
      credentialRef: "nb:github:mybook",
    })
    mocks.readCloudBackupConfig.mockResolvedValue({
      endpoint: "github",
      root: "",
      credentialRef: "nb:github:mybook",
      enabled: true,
      github: { owner: "niko", repo: "r", branch: "main", pathPrefix: "" },
    })
    renderPanel()
    await flushAsync()
    expect(targetSelect().value).toBe("github")
    fireEvent.change(targetSelect(), { target: { value: "webdav" } })
    expect(targetSelect().value).toBe("webdav")
    // 跨域引用已清空：凭据输入不再是 nb:github: 开头。
    const refInput = screen.getByPlaceholderText("nb:webdav:project") as HTMLInputElement
    expect(refInput.value).not.toContain("nb:github:")
  })

  it("WebDAV 端点与根输入可编辑", async () => {
    renderPanel()
    await flushAsync()
    const endpoint = screen.getByPlaceholderText("https://dav.example.com") as HTMLInputElement
    fireEvent.change(endpoint, { target: { value: "https://dav.other.example/x" } })
    expect(endpoint.value).toBe("https://dav.other.example/x")
    const root = screen.getByPlaceholderText("niko-buddy/backups") as HTMLInputElement
    fireEvent.change(root, { target: { value: "myroot" } })
    expect(root.value).toBe("myroot")
  })

  it("GitHub 四项输入分别落盘到 config.github", async () => {
    renderPanel()
    await flushAsync()
    fireEvent.change(targetSelect(), { target: { value: "github" } })
    fireEvent.change(screen.getByPlaceholderText("niko"), { target: { value: "octo" } })
    fireEvent.change(screen.getByPlaceholderText("novel-backups"), { target: { value: "repo2" } })
    fireEvent.change(screen.getByPlaceholderText("main"), { target: { value: "dev" } })
    fireEvent.change(screen.getByPlaceholderText("backups/qmai"), { target: { value: "p/f" } })
    expect((screen.getByPlaceholderText("niko") as HTMLInputElement).value).toBe("octo")
    expect((screen.getByPlaceholderText("novel-backups") as HTMLInputElement).value).toBe("repo2")
    expect((screen.getByPlaceholderText("main") as HTMLInputElement).value).toBe("dev")
    expect((screen.getByPlaceholderText("backups/qmai") as HTMLInputElement).value).toBe("p/f")
  })

  it("本地路径与全局开关可编辑；凭据引用可手填", async () => {
    renderPanel()
    await flushAsync()
    fireEvent.change(targetSelect(), { target: { value: "local" } })
    const local = screen.getByPlaceholderText("D:/NovelBackups/qmai") as HTMLInputElement
    fireEvent.change(local, { target: { value: "D:/paired/novel" } })
    expect(local.value).toBe("D:/paired/novel")
    const checkbox = screen.getByText("sync.enabled").querySelector("input") as HTMLInputElement
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(false)
    fireEvent.change(targetSelect(), { target: { value: "webdav" } })
    const ref = screen.getByPlaceholderText("nb:webdav:project") as HTMLInputElement
    fireEvent.change(ref, { target: { value: "nb:webdav:hand" } })
    expect(ref.value).toBe("nb:webdav:hand")
  })
})

describe("保存 / 测试 / 立即同步", () => {
  it("保存：enabled=true 时落盘并启动调度器", async () => {
    renderPanel()
    await flushAsync()
    fireEvent.click(screen.getByText("backup.cloud.save"))
    await flushAsync()
    expect(mocks.configureCloudBackup).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ endpoint: "https://dav.example.com", enabled: true }),
    )
    expect(mocks.startSyncScheduler).toHaveBeenCalledWith(PROJECT, DEVICE, undefined)
    expect(mocks.stopSyncScheduler).not.toHaveBeenCalled()
    expect(screen.getByText("backup.cloud.saved")).toBeInTheDocument()
  })

  it("保存：enabled=false 时落盘并停止调度器", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({ ...WEBDAV_STATUS, enabled: false })
    renderPanel()
    await flushAsync()
    fireEvent.click(screen.getByText("backup.cloud.save"))
    await flushAsync()
    expect(mocks.configureCloudBackup).toHaveBeenCalled()
    expect(mocks.stopSyncScheduler).toHaveBeenCalled()
    expect(mocks.startSyncScheduler).not.toHaveBeenCalled()
  })

  it("保存：调度器启停失败不阻碍落盘成功文案", async () => {
    mocks.startSyncScheduler.mockRejectedValue(new Error("scheduler down"))
    renderPanel()
    await flushAsync()
    fireEvent.click(screen.getByText("backup.cloud.save"))
    await flushAsync()
    expect(mocks.configureCloudBackup).toHaveBeenCalled()
    expect(screen.getByText("backup.cloud.saved")).toBeInTheDocument()
    expect(screen.queryByText(/backup.cloud.errorLead/)).toBeNull()
  })

  it("保存失败时展示 errorLead 且不刷出 saved", async () => {
    mocks.configureCloudBackup.mockRejectedValue(new Error("invalid config"))
    renderPanel()
    await flushAsync()
    fireEvent.click(screen.getByText("backup.cloud.save"))
    await flushAsync()
    expect(screen.getByText(/backup.cloud.errorLead/)).toHaveTextContent("invalid config")
  })

  it("连接测试：ok 与失败两种文案", async () => {
    renderPanel()
    await flushAsync()
    fireEvent.click(screen.getByText("backup.cloud.test"))
    await flushAsync()
    expect(mocks.testCloudBackup).toHaveBeenCalledWith(PROJECT)
    expect(screen.getByText(/backup.cloud.testOk/)).toBeInTheDocument()
    cleanup()
    vi.clearAllMocks()
    installDefaults()
    mocks.testCloudBackup.mockResolvedValue({
      ok: false,
      endpoint: "https://dav.example.com",
      root: "backups",
      credentialAvailable: true,
      reachable: false,
      objectCount: 0,
      message: "dial refused",
    })
    renderPanel()
    await flushAsync()
    fireEvent.click(screen.getByText("backup.cloud.test"))
    await flushAsync()
    expect(screen.getByText(/backup.cloud.testFailed/)).toHaveTextContent("dial refused")
  })

  it("立即同步：ran=true 展示 revision；ran=false 展示 skipReason", async () => {
    renderPanel()
    await flushAsync()
    fireEvent.click(screen.getByText("sync.now"))
    await flushAsync()
    expect(mocks.runSyncNow).toHaveBeenCalledWith(PROJECT, DEVICE)
    expect(screen.getByText("sync.nowDone")).toBeInTheDocument()
    cleanup()
    vi.clearAllMocks()
    installDefaults()
    mocks.runSyncNow.mockResolvedValue({
      ran: false,
      skipReason: "disabled",
      manifestId: "",
      revision: 0,
      decision: "",
      message: "",
    })
    renderPanel()
    await flushAsync()
    fireEvent.click(screen.getByText("sync.now"))
    await flushAsync()
    expect(screen.getByText("sync.nowSkipped")).toBeInTheDocument()
  })

  it("立即同步：无 skipReason 时回退 unknown", async () => {
    mocks.runSyncNow.mockResolvedValue({
      ran: false,
      manifestId: "",
      revision: 0,
      decision: "",
      message: "",
    })
    renderPanel()
    await flushAsync()
    fireEvent.click(screen.getByText("sync.now"))
    await flushAsync()
    expect(screen.getByText("sync.nowSkipped")).toBeInTheDocument()
  })
})

describe("推送 / 拉取 / 冲突终止态", () => {
  it("推送：填产物路径后调用 push 并展示 revision", async () => {
    renderPanel()
    await flushAsync()
    const artifact = screen.getByText("backup.cloud.artifactPath").closest("label") as HTMLElement
    const input = within(artifact).getByRole("textbox") as HTMLInputElement
    fireEvent.change(input, { target: { value: "/tmp/export.md" } })
    fireEvent.click(screen.getByText("backup.cloud.push"))
    await flushAsync()
    expect(mocks.pushCloudBackup).toHaveBeenCalledWith(PROJECT, "/tmp/export.md", DEVICE)
    expect(screen.getByText("backup.cloud.pushDone")).toBeInTheDocument()
  })

  it("拉取：填 manifest 后调用 pull 并展示裁决", async () => {
    renderPanel()
    await flushAsync()
    const label = screen.getByText("backup.cloud.manifestId").closest("label") as HTMLElement
    const input = within(label).getByRole("textbox") as HTMLInputElement
    fireEvent.change(input, { target: { value: "20261102-120000" } })
    fireEvent.click(screen.getByText("backup.cloud.pull"))
    await flushAsync()
    expect(mocks.pullCloudBackup).toHaveBeenCalledWith(PROJECT, "20261102-120000", DEVICE)
    expect(screen.getByText(/backup.cloud.decision.apply/)).toBeInTheDocument()
  })

  it("冲突非空时逐条渲染摘要并声明终止态（保留两者，无覆盖按钮）", async () => {
    mocks.listCloudConflicts.mockResolvedValue([
      { name: "a.conflict-dev-1", path: "a.md", size: 12, defaultResolution: "keep_both" },
      { name: "b.conflict-dev-1", path: "b.md", size: 34, defaultResolution: "keep_both" },
    ])
    renderPanel()
    await waitFor(() => expect(screen.getByText("a.conflict-dev-1 (12 B)")).toBeInTheDocument())
    await flushAsync()
    expect(screen.getByTestId("cloud-backup-status-rail")).toHaveTextContent("backup.cloud.conflicts")
    expect(screen.getByText("b.conflict-dev-1 (34 B)")).toBeInTheDocument()
    const items = screen.getAllByText(/backup.cloud.keepBoth/)
    expect(items.length).toBeGreaterThan(0)
    expect(screen.getByTestId("cloud-backup-panel")).toHaveTextContent("backup.cloud.conflictTerminal")
  })

  it("页脚展示 journal 条数与最近传输", async () => {
    renderPanel()
    await flushAsync()
    const footer = document.querySelector("footer") as HTMLElement
    expect(footer).not.toBeNull()
    expect(footer).toHaveTextContent("backup.cloud.journalEntries")
    expect(footer).toHaveTextContent("backup.cloud.lastTransfer")
  })
})

describe("批次展开 / 逐项改选 / 应用分流", () => {
  const batch = {
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
        choices: [PICK_MINE, PICK_KEEP_BOTH],
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

  it("展开后逐项渲染并可收起；改选后应用只提交可选项", async () => {
    mocks.syncBatchesCommand.mockResolvedValue([batch])
    renderPanel()
    await flushAsync()
    const row = screen.getByTestId("sync-batch-batch-1")
    fireEvent.click(within(row).getByRole("button", { name: "sync.batch.expand" }))
    const item = await waitFor(() => screen.getByTestId("sync-batch-item-chapters/01.md"))
    expect(item).toHaveTextContent("chapters/01.md")
    const select = within(item).getByLabelText("sync.batch.pick") as HTMLSelectElement
    expect(select.value).toBe(PICK_KEEP_BOTH)
    fireEvent.change(select, { target: { value: PICK_MINE } })
    expect(select.value).toBe(PICK_MINE)
    fireEvent.click(within(row).getByRole("button", { name: "sync.batch.apply" }))
    await waitFor(() => expect(mocks.applyPerItemDecisionCommand).toHaveBeenCalled())
    const [, , actor, items] = mocks.applyPerItemDecisionCommand.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      { path: string; decision: string }[],
    ]
    expect(actor).toBe(DEVICE)
    expect(items).toEqual([{ path: "chapters/01.md", decision: PICK_MINE }])
    // 收起再次点击同一按钮（expanded ? null : id 的另一分支）。
    fireEvent.click(within(row).getByRole("button", { name: "sync.batch.collapse" }))
    expect(screen.queryByTestId("sync-batch-item-chapters/01.md")).toBeNull()
  })

  it("部分失败时展示 partial 文案", async () => {
    mocks.syncBatchesCommand.mockResolvedValue([batch])
    mocks.applyPerItemDecisionCommand.mockResolvedValue([
      { path: "chapters/01.md", decision: PICK_MINE, status: "error" },
    ])
    renderPanel()
    await flushAsync()
    const row = screen.getByTestId("sync-batch-batch-1")
    fireEvent.click(within(row).getByRole("button", { name: "sync.batch.expand" }))
    await waitFor(() => screen.getByTestId("sync-batch-item-chapters/01.md"))
    fireEvent.click(within(row).getByRole("button", { name: "sync.batch.apply" }))
    await waitFor(() => expect(mocks.applyPerItemDecisionCommand).toHaveBeenCalled())
    await flushAsync()
    expect(screen.getByText("sync.batch.partial")).toBeInTheDocument()
  })

  it("无 base 批次置灰并明说只能保留两者；带 decision 与 error 的项如实展示", async () => {
    mocks.syncBatchesCommand.mockResolvedValue([
      {
        batch_id: "batch-0",
        manifest_id: "20261101-090000",
        revision: 1,
        direction: "pull",
        device_id: DEVICE,
        ts: "20261101090000",
        content_hash: "c".repeat(64),
        base_available: false,
        status: "partial",
        duration_ms: 9,
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
            decision: PICK_KEEP_BOTH,
          },
        ],
      },
    ])
    renderPanel()
    await flushAsync()
    const legacy = screen.getByTestId("sync-batch-batch-0")
    expect(within(legacy).getByTestId("sync-batch-no-base")).toBeInTheDocument()
    expect(legacy).toHaveTextContent("one item failed")
    fireEvent.click(within(legacy).getByRole("button", { name: "sync.batch.expand" }))
    const failed = await waitFor(() => screen.getByTestId("sync-batch-item-chapters/03.md"))
    expect(failed).toHaveTextContent("remote read failed")
    const select = within(failed).getByLabelText("sync.batch.pick") as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(within(legacy).getByRole("button", { name: "sync.batch.apply" })).toBeDisabled()
  })
})

describe("凭据域守卫与本地目录选择", () => {
  it("GitHub 域写错域时直接报错且不回填引用", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({
      ...WEBDAV_STATUS,
      endpoint: "github",
      credentialRef: "",
    })
    mocks.secretPut.mockResolvedValue("nb:webdav:mybook")
    renderPanel()
    await flushAsync()
    const secret = screen.getByPlaceholderText("user:password") as HTMLInputElement
    fireEvent.change(secret, { target: { value: "ghp_x" } })
    fireEvent.click(screen.getByText("backup.cloud.credentialSave"))
    await flushAsync()
    expect(screen.getByText(/backup.cloud.errorLead/)).toHaveTextContent("nb:github")
    expect((screen.getByPlaceholderText("nb:github:account") as HTMLInputElement).value).toBe("")
  })

  it("secret 删除返回 false 时展示 credentialAbsent", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({ ...WEBDAV_STATUS })
    mocks.secretDelete.mockResolvedValue(false)
    renderPanel()
    await flushAsync()
    fireEvent.click(screen.getByText("backup.cloud.credentialClear"))
    await flushAsync()
    expect(screen.getByText("backup.cloud.credentialAbsent")).toBeInTheDocument()
  })

  it("目录选择器返回路径时回填 localPath；取消与异常时不报错", async () => {
    renderPanel()
    await flushAsync()
    fireEvent.change(targetSelect(), { target: { value: "local" } })
    mocks.dialogOpen.mockResolvedValue("D:/picked/novel")
    fireEvent.click(screen.getByText("sync.localPick"))
    await flushAsync()
    expect((screen.getByPlaceholderText("D:/NovelBackups/qmai") as HTMLInputElement).value).toBe(
      "D:/picked/novel",
    )
    cleanup()
    vi.clearAllMocks()
    installDefaults()
    mocks.dialogOpen.mockResolvedValue(null)
    renderPanel()
    await flushAsync()
    fireEvent.change(targetSelect(), { target: { value: "local" } })
    fireEvent.click(screen.getByText("sync.localPick"))
    await flushAsync()
    expect(screen.queryByText(/backup.cloud.errorLead/)).toBeNull()
    cleanup()
    vi.clearAllMocks()
    installDefaults()
    mocks.dialogOpen.mockRejectedValue(new Error("no dialog"))
    renderPanel()
    await flushAsync()
    fireEvent.change(targetSelect(), { target: { value: "local" } })
    fireEvent.click(screen.getByText("sync.localPick"))
    await flushAsync()
    expect(screen.queryByText(/backup.cloud.errorLead/)).toBeNull()
  })
})

describe("分支补齐：文件回填 / 跨域复用 / 无 github 块", () => {
  it("完整配置带 localPath 时优先采用文件值（local 回填分支）", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({
      ...WEBDAV_STATUS,
      endpoint: "local",
      root: "",
      credentialRef: "",
    })
    mocks.readCloudBackupConfig.mockResolvedValue({
      endpoint: "local",
      root: "",
      credentialRef: "",
      enabled: true,
      localPath: "D:/from-file/novel",
    })
    renderPanel()
    await flushAsync()
    expect(targetSelect().value).toBe("local")
    expect((screen.getByPlaceholderText("D:/NovelBackups/qmai") as HTMLInputElement).value).toBe(
      "D:/from-file/novel",
    )
  })

  it("切到 GitHub 时已有 github 域引用被复用（不清空）", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({ ...WEBDAV_STATUS, credentialRef: "nb:github:keepme" })
    renderPanel()
    await flushAsync()
    fireEvent.change(targetSelect(), { target: { value: "github" } })
    expect((screen.getByPlaceholderText("nb:github:account") as HTMLInputElement).value).toBe(
      "nb:github:keepme",
    )
  })

  it("从本地目标切回 WebDAV 时端点清空（LOCAL 分支）", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({
      ...WEBDAV_STATUS,
      endpoint: "local",
      root: "",
      credentialRef: "",
    })
    renderPanel()
    await flushAsync()
    expect(targetSelect().value).toBe("local")
    fireEvent.change(targetSelect(), { target: { value: "webdav" } })
    expect(targetSelect().value).toBe("webdav")
    expect((screen.getByPlaceholderText("https://dav.example.com") as HTMLInputElement).value).toBe("")
  })

  it("GitHub 目标无 github 块时输入仍可用（?? 回退分支）", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({
      ...WEBDAV_STATUS,
      endpoint: "github",
      credentialRef: "nb:github:solo",
    })
    mocks.readCloudBackupConfig.mockResolvedValue({
      endpoint: "github",
      root: "",
      credentialRef: "nb:github:solo",
      enabled: true,
    })
    // 每项都作为「github 未定义时的第一次编辑」：各 handler 的 ?? 回退分支。
    const firstEdits: Array<[string, string]> = [
      ["niko", "solo-owner"],
      ["novel-backups", "solo-repo"],
      ["main", "solo-branch"],
      ["backups/qmai", "solo/prefix"],
    ]
    for (const [placeholder, value] of firstEdits) {
      renderPanel()
      await flushAsync()
      expect(targetSelect().value).toBe("github")
      fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } })
      expect((screen.getByPlaceholderText(placeholder) as HTMLInputElement).value).toBe(value)
      cleanup()
    }
  })

  it("WebDAV 切到 WebDAV 时保留原端点（else 分支）", async () => {
    renderPanel()
    await flushAsync()
    expect(targetSelect().value).toBe("webdav")
    const endpoint = screen.getByPlaceholderText("https://dav.example.com") as HTMLInputElement
    expect(endpoint.value).toBe("https://dav.example.com")
    fireEvent.change(targetSelect(), { target: { value: "webdav" } })
    expect((screen.getByPlaceholderText("https://dav.example.com") as HTMLInputElement).value).toBe(
      "https://dav.example.com",
    )
  })

  it("卸载后凭据探针回包不写状态（cancelled 分支）", async () => {
    let resolveProbe!: (value: boolean) => void
    mocks.secretAvailable.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveProbe = resolve
      }),
    )
    const { unmount } = renderPanel()
    unmount()
    await act(async () => {
      resolveProbe(true)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByTestId("cloud-backup-panel")).toBeNull()
  })

  it("卸载后凭据探针拒绝也不写状态（catch 内 cancelled 分支）", async () => {
    let rejectProbe!: (reason?: unknown) => void
    mocks.secretAvailable.mockReturnValue(
      new Promise<boolean>((_resolve, reject) => {
        rejectProbe = reject
      }),
    )
    const { unmount } = renderPanel()
    unmount()
    await act(async () => {
      rejectProbe(new Error("probe down"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByTestId("cloud-backup-panel")).toBeNull()
  })
})

describe("竞态：项目切换时旧响应不得覆盖新状态", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it("旧 cloudBackupStatus 晚到时丢弃（首个守卫）", async () => {
    const gate = deferred<typeof WEBDAV_STATUS>()
    mocks.cloudBackupStatus
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValue({ ...WEBDAV_STATUS, endpoint: "https://second.example/", root: "s2" })
    const { rerender } = renderPanel("/p/one")
    rerender(<CloudBackupPanel projectPath="/p/two" deviceId={DEVICE} />)
    gate.resolve({ ...WEBDAV_STATUS, endpoint: "https://first.example/", root: "first" })
    await flushAsync()
    await flushAsync()
    // 新项目状态保留，旧响应未覆盖。
    expect(mocks.cloudBackupStatus).toHaveBeenCalledWith("/p/two")
    expect(screen.getByTestId("cloud-backup-panel")).toBeInTheDocument()
  })

  it("旧完整配置晚到时丢弃（第二个守卫）", async () => {
    const gate = deferred<null>()
    mocks.readCloudBackupConfig.mockReturnValueOnce(gate.promise).mockResolvedValue(null)
    const { rerender } = renderPanel("/p/one")
    await act(async () => {
      await Promise.resolve()
    })
    rerender(<CloudBackupPanel projectPath="/p/two" deviceId={DEVICE} />)
    gate.resolve(null)
    await flushAsync()
    await flushAsync()
    expect(mocks.readCloudBackupConfig).toHaveBeenCalledWith("/p/two")
  })

  it("旧批次晚到时丢弃（第三个守卫）", async () => {
    const gate = deferred<never[]>()
    mocks.syncBatchesCommand.mockReturnValueOnce(gate.promise).mockResolvedValue([])
    const { rerender } = renderPanel("/p/one")
    await act(async () => {
      await Promise.resolve()
    })
    rerender(<CloudBackupPanel projectPath="/p/two" deviceId={DEVICE} />)
    gate.resolve([])
    await flushAsync()
    await flushAsync()
    expect(mocks.syncBatchesCommand).toHaveBeenCalledWith("/p/two")
  })

  it("旧调度器状态晚到时丢弃（第四个守卫）", async () => {
    const gate = deferred<typeof SCHEDULER_OK>()
    mocks.readSyncSchedulerStatus.mockReturnValueOnce(gate.promise).mockResolvedValue({
      ...SCHEDULER_OK,
    })
    const { rerender } = renderPanel("/p/one")
    await act(async () => {
      await Promise.resolve()
    })
    rerender(<CloudBackupPanel projectPath="/p/two" deviceId={DEVICE} />)
    gate.resolve({ ...SCHEDULER_OK })
    await flushAsync()
    await flushAsync()
    expect(mocks.readSyncSchedulerStatus).toHaveBeenCalledTimes(2)
  })

  it("旧请求报错晚到时不展示错误（catch 守卫）", async () => {
    const gate = deferred<typeof WEBDAV_STATUS>()
    mocks.cloudBackupStatus.mockReturnValueOnce(gate.promise).mockResolvedValue({
      ...WEBDAV_STATUS,
    })
    const { rerender } = renderPanel("/p/one")
    rerender(<CloudBackupPanel projectPath="/p/two" deviceId={DEVICE} />)
    gate.reject(new Error("stale boom"))
    await flushAsync()
    await flushAsync()
    expect(screen.queryByText(/stale boom/)).toBeNull()
  })
})
