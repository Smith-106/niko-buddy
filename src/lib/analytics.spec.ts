import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  isTauri: vi.fn(),
  tauriFetch: vi.fn(),
}))

vi.mock("@/lib/web-store", () => ({ getStore: mocks.getStore }))
vi.mock("@/lib/platform", () => ({ isTauri: () => mocks.isTauri() }))
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.tauriFetch }))

import { initAnalytics } from "./analytics"

const fetchSpy = vi.fn()

beforeEach(() => {
  fetchSpy.mockReset()
  vi.stubGlobal("fetch", fetchSpy)
  mocks.getStore.mockReset()
  mocks.isTauri.mockReset()
  mocks.tauriFetch.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  // Re-import to reset module-level cachedUUID/heartbeatTimer between tests.
  vi.resetModules()
})

async function reimport() {
  return await import("./analytics")
}

describe("initAnalytics", () => {
  it("reuses an existing device uuid and reports open + heartbeat", async () => {
    const store = {
      get: vi.fn(async () => "existing-uuid"),
      set: vi.fn(async () => undefined),
    }
    mocks.getStore.mockResolvedValue(store)
    mocks.isTauri.mockReturnValue(false)
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))

    await reimport().then((m) => m.initAnalytics())

    expect(store.get).toHaveBeenCalledWith("analytics_device_uuid")
    expect(store.set).not.toHaveBeenCalled()
    const urls = fetchSpy.mock.calls.map((c) => c[0])
    expect(urls).toContain("https://qmai-analytics.qmai.workers.dev/open")
    expect(urls).toContain("https://qmai-analytics.qmai.workers.dev/heartbeat")
    const bodies = fetchSpy.mock.calls.map((c) => JSON.parse(c[1]?.body ?? "{}"))
    for (const body of bodies) {
      expect(body.uuid).toBe("existing-uuid")
    }
  })

  it("generates and persists a new uuid on first run", async () => {
    const store = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    }
    mocks.getStore.mockResolvedValue(store)
    mocks.isTauri.mockReturnValue(false)
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))
    vi.spyOn(crypto, "randomUUID").mockReturnValue("fresh-uuid")

    await reimport().then((m) => m.initAnalytics())

    expect(store.set).toHaveBeenCalledWith("analytics_device_uuid", "fresh-uuid")
  })

  it("falls back to a fresh uuid when the store is unavailable", async () => {
    mocks.getStore.mockRejectedValue(new Error("store broken"))
    mocks.isTauri.mockReturnValue(false)
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))
    vi.spyOn(crypto, "randomUUID").mockReturnValue("fallback-uuid")

    await reimport().then((m) => m.initAnalytics())

    const urls = fetchSpy.mock.calls.map((c) => c[0])
    expect(urls.some((u) => u.endsWith("/open"))).toBe(true)
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body ?? "{}")
    expect(body.uuid).toBe("fallback-uuid")
  })

  it("uses the Tauri HTTP plugin inside Tauri", async () => {
    const store = {
      get: vi.fn(async () => "tauri-uuid"),
      set: vi.fn(async () => undefined),
    }
    mocks.getStore.mockResolvedValue(store)
    mocks.isTauri.mockReturnValue(true)
    mocks.tauriFetch.mockResolvedValue(new Response(null, { status: 200 }))

    await reimport().then((m) => m.initAnalytics())

    expect(mocks.tauriFetch).toHaveBeenCalledWith(
      expect.stringContaining("/open"),
      expect.objectContaining({ method: "POST" }),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("silently ignores transport failures", async () => {
    const store = {
      get: vi.fn(async () => "uuid"),
      set: vi.fn(async () => undefined),
    }
    mocks.getStore.mockResolvedValue(store)
    mocks.isTauri.mockReturnValue(false)
    fetchSpy.mockRejectedValue(new Error("network down"))

    await expect(reimport().then((m) => m.initAnalytics())).resolves.toBeUndefined()
  })

  it("registers a heartbeat interval and a beforeunload beacon when window exists", async () => {
    vi.useFakeTimers()
    const store = {
      get: vi.fn(async () => "uuid"),
      set: vi.fn(async () => undefined),
    }
    mocks.getStore.mockResolvedValue(store)
    mocks.isTauri.mockReturnValue(false)

    const listeners = new Map<string, () => void>()
    const beaconSpy = vi.fn()
    const win = {
      setInterval: vi.fn(() => 123 as unknown as number),
      clearInterval: vi.fn(),
      addEventListener: vi.fn((event: string, cb: () => void) => {
        listeners.set(event, cb)
      }),
      navigator: { sendBeacon: beaconSpy },
    }
    vi.stubGlobal("window", win as unknown as Window & typeof globalThis)
    vi.stubGlobal("navigator", { sendBeacon: beaconSpy })

    await reimport().then((m) => m.initAnalytics())

    expect(win.setInterval).toHaveBeenCalledWith(expect.any(Function), 60_000)
    expect(listeners.has("beforeunload")).toBe(true)

    // window.setInterval 被 mock，不会真正调度 → 直接调用回调验证心跳逻辑
    const intervalCb = win.setInterval.mock.calls[0][0] as () => void
    intervalCb()
    intervalCb()
    const heartbeats = fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith("/heartbeat"))
    expect(heartbeats.length).toBeGreaterThanOrEqual(2)

    // Fire beforeunload → beacon with the close payload and cleared interval.
    listeners.get("beforeunload")?.()
    expect(beaconSpy).toHaveBeenCalledWith(
      "https://qmai-analytics.qmai.workers.dev/close",
      expect.any(Blob),
    )
    expect(win.clearInterval).toHaveBeenCalled()

    // Fire beforeunload again → heartbeatTimer is already null, so no
    // double-clear, but the close beacon is still sent.
    listeners.get("beforeunload")?.()
    expect(win.clearInterval).toHaveBeenCalledTimes(1)
    expect(beaconSpy).toHaveBeenCalledTimes(2)
  })

  it("clears a pre-existing heartbeat interval before re-registering", async () => {
    vi.useFakeTimers()
    const store = {
      get: vi.fn(async () => "uuid"),
      set: vi.fn(async () => undefined),
    }
    mocks.getStore.mockResolvedValue(store)
    mocks.isTauri.mockReturnValue(false)

    const listeners = new Map<string, () => void>()
    const win = {
      setInterval: vi.fn(() => 999 as unknown as number),
      clearInterval: vi.fn(),
      addEventListener: vi.fn((event: string, cb: () => void) => listeners.set(event, cb)),
      navigator: { sendBeacon: vi.fn() },
    }
    vi.stubGlobal("window", win as unknown as Window & typeof globalThis)

    // First init registers an interval.
    await reimport().then((m) => m.initAnalytics())
    // Second init must clear the previous timer before registering a new one.
    await reimport().then((m) => m.initAnalytics())

    expect(win.clearInterval).toHaveBeenCalledWith(999)
    expect(win.setInterval).toHaveBeenCalledTimes(2)
  })
})
