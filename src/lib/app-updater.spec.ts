import { afterEach, describe, expect, it, vi } from "vitest"
import { runAppUpdateFlow, checkForAppUpdate } from "./app-updater"
import { isTauri } from "@/lib/platform"
import { check } from "@tauri-apps/plugin-updater"
import { confirm, message } from "@tauri-apps/plugin-dialog"

vi.mock("@/lib/platform", () => ({ isTauri: vi.fn() }))
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), message: vi.fn() }))

function createBindings() {
  return {
    isTauri: true,
    check: vi.fn(),
    confirm: vi.fn(),
    message: vi.fn(),
  }
}

describe("runAppUpdateFlow", () => {
  it("does not prompt during silent startup checks when an update is available", async () => {
    const bindings = createBindings()
    bindings.check.mockResolvedValue({
      version: "2.2.29",
      body: "update notes",
    })

    const result = await runAppUpdateFlow(bindings, { mode: "silent" })

    expect(result).toEqual({
      status: "update_available",
      prompted: false,
      version: "2.2.29",
    })
    expect(bindings.confirm).not.toHaveBeenCalled()
    expect(bindings.message).not.toHaveBeenCalled()
  })

  it("prompts in interactive mode and stops when the user declines the update", async () => {
    const bindings = createBindings()
    bindings.check.mockResolvedValue({
      version: "2.2.29",
      body: "update notes",
    })
    bindings.confirm.mockResolvedValue(false)

    const result = await runAppUpdateFlow(bindings)

    expect(result).toEqual({
      status: "declined",
      prompted: true,
      version: "2.2.29",
    })
    expect(bindings.confirm).toHaveBeenCalledTimes(1)
    expect(bindings.message).not.toHaveBeenCalled()
  })

  it("never calls dialog APIs during silent startup checks even when an update exists", async () => {
    const bindings = createBindings()
    bindings.check.mockResolvedValue({
      version: "2.2.29",
      body: "update notes",
    })

    await runAppUpdateFlow(bindings, { mode: "silent" })

    expect(bindings.confirm).not.toHaveBeenCalled()
    expect(bindings.message).not.toHaveBeenCalled()
  })
})

describe("runAppUpdateFlow — full-coverage extensions", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(isTauri).mockReset()
    vi.mocked(check).mockReset()
    vi.mocked(confirm).mockReset()
    vi.mocked(message).mockReset()
  })

  it("returns no_update immediately when not running in Tauri", async () => {
    const bindings = createBindings()
    bindings.isTauri = false

    const result = await runAppUpdateFlow(bindings)

    expect(result).toEqual({ status: "no_update", prompted: false })
    expect(bindings.check).not.toHaveBeenCalled()
  })

  it("returns no_update when the check finds nothing", async () => {
    const bindings = createBindings()
    bindings.check.mockResolvedValue(null)

    const result = await runAppUpdateFlow(bindings)

    expect(result).toEqual({ status: "no_update", prompted: false })
  })

  it("downloads and reports downloaded when the user defers installation", async () => {
    const bindings = createBindings()
    const update = {
      version: "2.2.29",
      body: "  ",
      download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn(),
    }
    bindings.check.mockResolvedValue(update)
    bindings.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    bindings.message.mockResolvedValue(undefined)

    const result = await runAppUpdateFlow(bindings)

    expect(result).toEqual({ status: "downloaded", prompted: true, version: "2.2.29" })
    expect(update.download).toHaveBeenCalled()
    expect(update.install).not.toHaveBeenCalled()
    expect(bindings.message).toHaveBeenCalledTimes(1)
  })

  it("installs and reports installed when the user confirms installation", async () => {
    const bindings = createBindings()
    const update = {
      version: "2.2.29",
      body: undefined,
      download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockResolvedValue(undefined),
    }
    bindings.check.mockResolvedValue(update)
    bindings.confirm.mockResolvedValue(true)
    bindings.message.mockResolvedValue(undefined)

    const result = await runAppUpdateFlow(bindings)

    expect(result).toEqual({ status: "installed", prompted: true, version: "2.2.29" })
    expect(update.install).toHaveBeenCalled()
  })

  it("reports a download failure and declines when download rejects with an Error", async () => {
    const bindings = createBindings()
    const update = {
      version: "2.2.29",
      body: null,
      download: vi.fn().mockRejectedValue(new Error("disk full")),
      install: vi.fn(),
    }
    bindings.check.mockResolvedValue(update)
    bindings.confirm.mockResolvedValueOnce(true)
    bindings.message.mockResolvedValue(undefined)

    const result = await runAppUpdateFlow(bindings)

    expect(result).toEqual({ status: "declined", prompted: true, version: "2.2.29" })
    expect(bindings.message).toHaveBeenCalledWith(
      expect.stringContaining("下载更新失败：disk full"),
      expect.anything(),
    )
  })

  it("reports a download failure when download rejects with a non-Error value", async () => {
    const bindings = createBindings()
    const update = {
      version: "2.2.29",
      body: "",
      download: vi.fn().mockRejectedValue("raw failure"),
      install: vi.fn(),
    }
    bindings.check.mockResolvedValue(update)
    bindings.confirm.mockResolvedValueOnce(true)
    bindings.message.mockResolvedValue(undefined)

    const result = await runAppUpdateFlow(bindings)

    expect(result).toEqual({ status: "declined", prompted: true, version: "2.2.29" })
    expect(bindings.message).toHaveBeenCalledWith(
      expect.stringContaining("下载更新失败：raw failure"),
      expect.anything(),
    )
  })

  it("treats a process-exit install error as a successful install", async () => {
    const bindings = createBindings()
    const update = {
      version: "2.2.29",
      body: "",
      download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockRejectedValue(new Error("process exited with code 0")),
    }
    bindings.check.mockResolvedValue(update)
    bindings.confirm.mockResolvedValue(true)
    bindings.message.mockResolvedValue(undefined)

    const result = await runAppUpdateFlow(bindings)

    expect(result).toEqual({ status: "installed", prompted: true, version: "2.2.29" })
  })

  it("reports a real install failure and returns downloaded", async () => {
    const bindings = createBindings()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const update = {
      version: "2.2.29",
      body: "",
      download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockRejectedValue(new Error("signature mismatch")),
    }
    bindings.check.mockResolvedValue(update)
    bindings.confirm.mockResolvedValue(true)
    bindings.message.mockResolvedValue(undefined)

    const result = await runAppUpdateFlow(bindings)

    expect(result).toEqual({ status: "downloaded", prompted: true, version: "2.2.29" })
    expect(bindings.message).toHaveBeenCalledWith(
      expect.stringContaining("安装更新失败：signature mismatch"),
      expect.anything(),
    )
    expect(errorSpy).toHaveBeenCalled()
  })

  it("reports an install failure when install rejects with a non-Error value", async () => {
    const bindings = createBindings()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const update = {
      version: "2.2.29",
      body: "",
      download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockRejectedValue("boom string"),
    }
    bindings.check.mockResolvedValue(update)
    bindings.confirm.mockResolvedValue(true)
    bindings.message.mockResolvedValue(undefined)

    const result = await runAppUpdateFlow(bindings)

    expect(result).toEqual({ status: "downloaded", prompted: true, version: "2.2.29" })
    expect(bindings.message).toHaveBeenCalledWith(
      expect.stringContaining("安装更新失败：boom string"),
      expect.anything(),
    )
    errorSpy.mockRestore()
  })

  it("swallows a failing error dialog after an install failure", async () => {
    const bindings = createBindings()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const update = {
      version: "2.2.29",
      body: "",
      download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockRejectedValue(new Error("bad")),
    }
    bindings.check.mockResolvedValue(update)
    bindings.confirm.mockResolvedValue(true)
    bindings.message
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("dialog closed"))

    const result = await runAppUpdateFlow(bindings)

    expect(result).toEqual({ status: "downloaded", prompted: true, version: "2.2.29" })
    expect(errorSpy).toHaveBeenCalledWith("显示安装失败对话框也失败了：", expect.anything())
    errorSpy.mockRestore()
  })
})

describe("checkForAppUpdate — full-coverage extensions", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(isTauri).mockReset()
    vi.mocked(check).mockReset()
    vi.mocked(confirm).mockReset()
    vi.mocked(message).mockReset()
  })

  it("does nothing when not running in Tauri", async () => {
    vi.mocked(isTauri).mockReturnValue(false)

    const result = await checkForAppUpdate()

    expect(result).toBeUndefined()
    expect(check).not.toHaveBeenCalled()
  })

  it("runs the update flow when running in Tauri", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(check).mockResolvedValue({ version: "2.2.29", body: "" } as never)
    vi.mocked(confirm).mockResolvedValue(false)
    vi.mocked(message).mockResolvedValue(undefined)

    await checkForAppUpdate()

    expect(check).toHaveBeenCalled()
    expect(confirm).toHaveBeenCalled()
  })

  it("logs a warning when the update check throws", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(check).mockRejectedValue(new Error("network"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await checkForAppUpdate()

    expect(warnSpy).toHaveBeenCalledWith("检查应用更新失败：", expect.anything())
    warnSpy.mockRestore()
  })

  it("skips a second concurrent check while one is in flight", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    let resolveCheck: (value: unknown) => void = () => {}
    vi.mocked(check).mockImplementation(
      () => new Promise((resolve) => {
        resolveCheck = resolve
      }) as never,
    )

    const first = checkForAppUpdate()
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1))
    await checkForAppUpdate()
    resolveCheck(null)
    await first

    expect(check).toHaveBeenCalledTimes(1)
  })
})
