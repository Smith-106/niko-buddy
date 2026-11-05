// @vitest-environment jsdom
/**
 * SyncSettingsSection 全口径行为 spec（TASK-023：from_scratch 新建）。
 *
 * 覆盖：非 Tauri 降级、空路径早退、store 路径兜底、刷新成功/失败、
 * 时间戳格式化四路（缺失/空串/非法/合法）、开关启停（含停机失败吞错）、
 * 未配置目标、写回失败、切档三路（未跑/在跑/未配置/非法档）、
 * 手动同步四路（成功/跳过带因/跳过无因/失败/降级）、busy 禁用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils"
import { SyncSettingsSection } from "./sync-settings"
import DefaultExport from "./sync-settings"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string, _options?: Record<string, unknown>) => key),
  state: { project: null as { path: string } | null },
  isTauri: vi.fn(() => true),
  getDeviceId: vi.fn(() => "dev-1"),
  cloudBackupStatus: vi.fn(),
  readCloudBackupConfig: vi.fn(),
  readSyncSchedulerStatus: vi.fn(),
  configureCloudBackup: vi.fn(),
  startSyncScheduler: vi.fn(),
  stopSyncScheduler: vi.fn(),
  runSyncNow: vi.fn(),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: typeof mocks.state) => unknown) =>
      selector(mocks.state),
  }
})

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>()
  return { ...actual, isTauri: mocks.isTauri }
})

vi.mock("@/lib/device-id", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/device-id")>()
  return { ...actual, getDeviceId: mocks.getDeviceId }
})

vi.mock("@/lib/novel", () => ({
  DEFAULT_SYNC_ENABLED: false,
  SYNC_SCHEDULE_INTERVALS: [15, 30, 60],
  isSyncScheduleInterval: (value: number) => [15, 30, 60].includes(value),
  cloudBackupStatus: mocks.cloudBackupStatus,
  readCloudBackupConfig: mocks.readCloudBackupConfig,
  readSyncSchedulerStatus: mocks.readSyncSchedulerStatus,
  configureCloudBackup: mocks.configureCloudBackup,
  startSyncScheduler: mocks.startSyncScheduler,
  stopSyncScheduler: mocks.stopSyncScheduler,
  runSyncNow: mocks.runSyncNow,
}))

const PATH = "/p/sync-book"

const STATUS = {
  configured: true,
  enabled: true,
  endpoint: "https://dav.example.com",
  root: "backups",
  credentialRef: "nb:webdav:book",
  credentialAvailable: true,
  journalEntries: 0,
}

const FILE = {
  endpoint: "https://dav.example.com",
  root: "backups",
  credentialRef: "nb:webdav:book",
  enabled: true,
  schedule: { intervalMinutes: 30 as const },
}

function schedulerRunning() {
  return {
    running: true,
    projectPath: PATH,
    intervalMinutes: 30,
    syncEnabled: true,
    lastRunAt: "2026-01-02T03:04:05.000Z",
    nextRunAt: "2026-01-02T03:34:05.000Z",
  }
}

function schedulerStopped() {
  return {
    running: false,
    projectPath: PATH,
    intervalMinutes: 15,
    syncEnabled: false,
  }
}

function checkbox(): HTMLInputElement {
  return screen.getByRole("checkbox") as HTMLInputElement
}

function intervalSelect(): HTMLSelectElement {
  return screen.getByRole("combobox") as HTMLSelectElement
}

function syncButton(): HTMLButtonElement {
  return screen.getByText("sync.now").closest("button")!
}

function statusBox(): string {
  return screen.getByTestId("sync-schedule-status").textContent ?? ""
}

function setBaseline(): void {
  mocks.cloudBackupStatus.mockResolvedValue({ ...STATUS })
  mocks.readCloudBackupConfig.mockResolvedValue({ ...FILE })
  mocks.readSyncSchedulerStatus.mockResolvedValue(schedulerRunning())
  mocks.configureCloudBackup.mockResolvedValue(undefined)
  mocks.startSyncScheduler.mockResolvedValue(schedulerRunning())
  mocks.stopSyncScheduler.mockResolvedValue(schedulerStopped())
  mocks.runSyncNow.mockResolvedValue({
    ran: true,
    manifestId: "m1",
    revision: 7,
    decision: "apply",
    message: "ok",
  })
}

beforeEach(() => {
  setupDomGlobals()
  vi.clearAllMocks()
  mocks.state.project = null
  mocks.isTauri.mockReturnValue(true)
  mocks.getDeviceId.mockReturnValue("dev-1")
  setBaseline()
})

afterEach(() => {
  cleanup()
})

describe("SyncSettingsSection — 导出与降级路径", () => {
  it("默认导出即命名导出", () => {
    expect(DefaultExport).toBe(SyncSettingsSection)
  })

  it("非 Tauri 安静降级：不触发 IPC，开关/档位可操作且提示已保存", async () => {
    mocks.isTauri.mockReturnValue(false)
    render(<SyncSettingsSection projectPath={PATH} />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(mocks.cloudBackupStatus).not.toHaveBeenCalled()
    // 未配置（refresh 未跑）→ 同步按钮禁用 + 未配置提示
    expect(syncButton().disabled).toBe(true)
    expect(screen.getByText("sync.notConfigured")).toBeTruthy()
    // 开关切换走降级分支
    fireEvent.click(checkbox())
    await waitFor(() => {
      expect(screen.getByText("sync.saved")).toBeTruthy()
    })
    expect(mocks.configureCloudBackup).not.toHaveBeenCalled()
    // 切档同样走降级分支
    fireEvent.change(intervalSelect(), { target: { value: "30" } })
    await waitFor(() => {
      expect(screen.getAllByText("sync.saved").length).toBeGreaterThan(0)
    })
  })

  it("空路径 + 无项目：refresh 直接返回，不触发 IPC", async () => {
    render(<SyncSettingsSection />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(mocks.cloudBackupStatus).not.toHaveBeenCalled()
    fireEvent.click(checkbox())
    await waitFor(() => {
      expect(screen.getByText("sync.saved")).toBeTruthy()
    })
  })

  it("未传 prop 时用 store.project.path 兜底刷新", async () => {
    mocks.state.project = { path: "/p/store" }
    render(<SyncSettingsSection />)
    await waitFor(() => {
      expect(mocks.cloudBackupStatus).toHaveBeenCalledWith("/p/store")
    })
  })
})

describe("SyncSettingsSection — 刷新", () => {
  it("刷新成功：开关/档位/调度器状态全部落盘值", async () => {
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(mocks.cloudBackupStatus).toHaveBeenCalledWith(PATH)
    })
    await waitFor(() => {
      expect(checkbox().checked).toBe(true)
    })
    expect(intervalSelect().value).toBe("30")
    expect(syncButton().disabled).toBe(false)
    const box = statusBox()
    expect(box).toContain("sync.schedule.running")
    expect(box).not.toContain("sync.schedule.never")
    expect(box).not.toContain("sync.schedule.notScheduled")
  })

  it("enabled 非 true 视为关闭；无效档位保持默认；调度器 null 走停止文案", async () => {
    mocks.cloudBackupStatus.mockResolvedValueOnce({ ...STATUS, enabled: false })
    mocks.readCloudBackupConfig.mockResolvedValueOnce({
      ...FILE,
      schedule: { intervalMinutes: 45 },
    })
    mocks.readSyncSchedulerStatus.mockResolvedValueOnce(null)
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(checkbox().checked).toBe(false)
    })
    expect(intervalSelect().value).toBe("15")
    const box = statusBox()
    expect(box).toContain("sync.schedule.stopped")
    expect(box).toContain("sync.schedule.never")
    expect(box).toContain("sync.schedule.notScheduled")
  })

  it("配置/调度器读取失败被吞为 null：档位默认、状态停止", async () => {
    mocks.readCloudBackupConfig.mockRejectedValueOnce(new Error("no file"))
    mocks.readSyncSchedulerStatus.mockRejectedValueOnce(new Error("no sched"))
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(mocks.readCloudBackupConfig).toHaveBeenCalledWith(PATH)
    })
    await waitFor(() => {
      expect(intervalSelect().value).toBe("15")
    })
    expect(statusBox()).toContain("sync.schedule.stopped")
  })

  it("刷新失败：展示 errorLead 错误", async () => {
    mocks.cloudBackupStatus.mockRejectedValueOnce(new Error("status boom"))
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(screen.getByText(/sync\.errorLead/)).toBeTruthy()
    })
    expect(screen.getByText(/sync\.errorLead/).textContent).toContain("status boom")
  })

  it("缺失时间戳走尚未同步/未排程文案", async () => {
    mocks.readSyncSchedulerStatus.mockResolvedValueOnce({
      running: false,
      intervalMinutes: 15,
      syncEnabled: true,
    })
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(statusBox()).toContain("sync.schedule.never")
    })
    expect(statusBox()).toContain("sync.schedule.notScheduled")
  })

  it("非法日期原样展示；空串走尚未同步", async () => {
    mocks.readSyncSchedulerStatus.mockResolvedValueOnce({
      running: false,
      intervalMinutes: 15,
      syncEnabled: true,
      lastRunAt: "not-a-date",
      nextRunAt: "",
    })
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(statusBox()).toContain("not-a-date")
    })
    expect(statusBox()).toContain("sync.schedule.notScheduled")
  })
})

describe("SyncSettingsSection — 全局开关", () => {
  it("开启：写回配置并按当前档启动调度器", async () => {
    mocks.cloudBackupStatus.mockResolvedValueOnce({ ...STATUS, enabled: false })
    mocks.readCloudBackupConfig.mockResolvedValueOnce({ ...FILE, enabled: false })
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(checkbox().checked).toBe(false)
    })
    fireEvent.click(checkbox())
    await waitFor(() => {
      expect(mocks.configureCloudBackup).toHaveBeenCalledWith(
        PATH,
        expect.objectContaining({
          endpoint: FILE.endpoint,
          root: FILE.root,
          credentialRef: FILE.credentialRef,
          enabled: true,
        }),
      )
    })
    await waitFor(() => {
      expect(mocks.startSyncScheduler).toHaveBeenCalledWith(PATH, "dev-1", 30)
    })
    await waitFor(() => {
      expect(screen.getByText("sync.schedule.started")).toBeTruthy()
    })
    expect(checkbox().checked).toBe(true)
  })

  it("关闭：停机并提示 disabledNotice；停机失败也被吞掉", async () => {
    mocks.stopSyncScheduler.mockRejectedValueOnce(new Error("already stopped"))
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(checkbox().checked).toBe(true)
    })
    fireEvent.click(checkbox())
    await waitFor(() => {
      expect(mocks.stopSyncScheduler).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByText("sync.disabledNotice")).toBeTruthy()
    })
    expect(mocks.readSyncSchedulerStatus).toHaveBeenCalled()
    expect(checkbox().checked).toBe(false)
  })

  it("关闭且调度器状态读取失败：仍提示 disabledNotice", async () => {
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(checkbox().checked).toBe(true)
    })
    mocks.readSyncSchedulerStatus.mockRejectedValueOnce(new Error("status gone"))
    fireEvent.click(checkbox())
    await waitFor(() => {
      expect(screen.getByText("sync.disabledNotice")).toBeTruthy()
    })
    expect(checkbox().checked).toBe(false)
  })

  it("未配置传输目标：提示 notConfigured 且不碰调度器", async () => {
    mocks.readCloudBackupConfig.mockResolvedValue(null)
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(mocks.readCloudBackupConfig).toHaveBeenCalled()
    })
    fireEvent.click(checkbox())
    await waitFor(() => {
      expect(screen.getByText("sync.notConfigured")).toBeTruthy()
    })
    expect(mocks.configureCloudBackup).not.toHaveBeenCalled()
    expect(mocks.startSyncScheduler).not.toHaveBeenCalled()
    expect(mocks.stopSyncScheduler).not.toHaveBeenCalled()
  })

  it("写回失败：展示 errorLead 错误", async () => {
    mocks.configureCloudBackup.mockRejectedValueOnce(new Error("write denied"))
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(checkbox().checked).toBe(true)
    })
    fireEvent.click(checkbox())
    await waitFor(() => {
      expect(screen.getByText(/sync\.errorLead/)).toBeTruthy()
    })
    expect(screen.getByText(/sync\.errorLead/).textContent).toContain("write denied")
  })
})

describe("SyncSettingsSection — 间隔档位", () => {
  it("切档：落盘 + 调度器未跑 → intervalSaved，不重启", async () => {
    mocks.readSyncSchedulerStatus.mockResolvedValueOnce(schedulerStopped())
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(intervalSelect().value).toBe("15")
    })
    fireEvent.change(intervalSelect(), { target: { value: "30" } })
    await waitFor(() => {
      expect(mocks.configureCloudBackup).toHaveBeenCalledWith(
        PATH,
        expect.objectContaining({ schedule: { intervalMinutes: 30 } }),
      )
    })
    await waitFor(() => {
      expect(screen.getByText("sync.schedule.intervalSaved")).toBeTruthy()
    })
    expect(mocks.startSyncScheduler).not.toHaveBeenCalled()
    expect(intervalSelect().value).toBe("30")
  })

  it("切档且调度器在跑：按新档重启并提示 restarted", async () => {
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(intervalSelect().value).toBe("30")
    })
    fireEvent.change(intervalSelect(), { target: { value: "60" } })
    await waitFor(() => {
      expect(mocks.startSyncScheduler).toHaveBeenCalledWith(PATH, "dev-1", 60)
    })
    await waitFor(() => {
      expect(screen.getByText("sync.schedule.restarted")).toBeTruthy()
    })
  })

  it("切档时未配置目标：notConfigured", async () => {
    mocks.readCloudBackupConfig.mockResolvedValue(null)
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(mocks.cloudBackupStatus).toHaveBeenCalled()
    })
    fireEvent.change(intervalSelect(), { target: { value: "60" } })
    await waitFor(() => {
      expect(screen.getByText("sync.notConfigured")).toBeTruthy()
    })
    expect(mocks.startSyncScheduler).not.toHaveBeenCalled()
  })

  it("非法档位不触发任何写操作", async () => {
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(mocks.cloudBackupStatus).toHaveBeenCalled()
    })
    fireEvent.change(intervalSelect(), { target: { value: "45" } })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(mocks.configureCloudBackup).not.toHaveBeenCalled()
    expect(mocks.startSyncScheduler).not.toHaveBeenCalled()
  })
})

describe("SyncSettingsSection — 手动同步", () => {
  it("成功：nowDone 且同步后刷新状态", async () => {
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(syncButton().disabled).toBe(false)
    })
    fireEvent.click(syncButton())
    await waitFor(() => {
      expect(mocks.runSyncNow).toHaveBeenCalledWith(PATH, "dev-1")
    })
    await waitFor(() => {
      expect(screen.getByText("sync.nowDone")).toBeTruthy()
    })
    // syncNow 内调 refresh → cloudBackupStatus 至少两次
    expect(mocks.cloudBackupStatus.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("跳过：带原因与无原因（默认 unknown）都走 nowSkipped", async () => {
    mocks.runSyncNow
      .mockResolvedValueOnce({
        ran: false,
        skipReason: "disabled",
        manifestId: "",
        revision: 0,
        decision: "skipped",
        message: "skip",
      })
      .mockResolvedValueOnce({
        ran: false,
        manifestId: "",
        revision: 0,
        decision: "skipped",
        message: "skip",
      })
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(syncButton().disabled).toBe(false)
    })
    fireEvent.click(syncButton())
    await waitFor(() => {
      expect(screen.getByText("sync.nowSkipped")).toBeTruthy()
    })
    fireEvent.click(syncButton())
    await waitFor(() => {
      expect(mocks.runSyncNow).toHaveBeenCalledTimes(2)
    })
    const skippedCalls = mocks.t.mock.calls.filter(
      ([key]) => key === "sync.nowSkipped",
    )
    expect(skippedCalls).toHaveLength(2)
    expect(skippedCalls[0][1]).toEqual(
      expect.objectContaining({ reason: "disabled" }),
    )
    expect(skippedCalls[1][1]).toEqual(expect.objectContaining({ reason: "unknown" }))
  })

  it("非 Tauri 下同步直接提示已保存", async () => {
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(syncButton().disabled).toBe(false)
    })
    mocks.isTauri.mockReturnValue(false)
    fireEvent.click(syncButton())
    await waitFor(() => {
      expect(screen.getByText("sync.saved")).toBeTruthy()
    })
    expect(mocks.runSyncNow).not.toHaveBeenCalled()
  })

  it("空路径下同步直接提示已保存", async () => {
    const view = render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(syncButton().disabled).toBe(false)
    })
    view.rerender(<SyncSettingsSection projectPath="" />)
    fireEvent.click(syncButton())
    await waitFor(() => {
      expect(screen.getByText("sync.saved")).toBeTruthy()
    })
    expect(mocks.runSyncNow).not.toHaveBeenCalled()
  })

  it("同步失败：展示 errorLead 错误", async () => {
    mocks.runSyncNow.mockRejectedValueOnce(new Error("cycle failed"))
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(syncButton().disabled).toBe(false)
    })
    fireEvent.click(syncButton())
    await waitFor(() => {
      expect(screen.getByText(/sync\.errorLead/)).toBeTruthy()
    })
    expect(screen.getByText(/sync\.errorLead/).textContent).toContain("cycle failed")
  })
})

describe("SyncSettingsSection — busy 状态", () => {
  it("执行中禁用输入，完成后恢复", async () => {
    let resolveConfigure!: (value: unknown) => void
    mocks.configureCloudBackup.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConfigure = resolve
      }),
    )
    mocks.cloudBackupStatus.mockResolvedValueOnce({ ...STATUS, enabled: false })
    render(<SyncSettingsSection projectPath={PATH} />)
    await waitFor(() => {
      expect(checkbox().checked).toBe(false)
    })
    fireEvent.click(checkbox())
    await waitFor(() => {
      expect(checkbox().disabled).toBe(true)
    })
    expect(intervalSelect().disabled).toBe(true)
    await act(async () => {
      resolveConfigure(undefined)
    })
    await waitFor(() => {
      expect(checkbox().disabled).toBe(false)
    })
    expect(intervalSelect().disabled).toBe(false)
  })
})
