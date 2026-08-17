import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  tauriFetch: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({ isTauri: () => mocks.isTauri() }))
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.tauriFetch }))

import { submitFeedback, type FeedbackInput } from "./feedback"

const fetchSpy = vi.fn()

function validInput(): FeedbackInput {
  return { type: "bug", message: "  发现一个问题  ", contact: " user@example.com " }
}

beforeEach(() => {
  fetchSpy.mockReset()
  mocks.isTauri.mockReset()
  mocks.tauriFetch.mockReset()
  vi.stubGlobal("fetch", fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("submitFeedback", () => {
  it("rejects empty messages after trimming", async () => {
    await expect(submitFeedback({ type: "bug", message: "   " })).rejects.toThrow("请输入反馈内容")
    await expect(submitFeedback({ type: "bug", message: "" })).rejects.toThrow("请输入反馈内容")
  })

  it("rejects messages longer than 3000 characters", async () => {
    await expect(
      submitFeedback({ type: "bug", message: "x".repeat(3001) }),
    ).rejects.toThrow("反馈内容不能超过 3000 字")
  })

  it("accepts a message of exactly 3000 characters", async () => {
    mocks.isTauri.mockReturnValue(false)
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))
    await expect(submitFeedback({ type: "bug", message: "x".repeat(3000) })).resolves.toBeUndefined()
  })

  it("rejects contact strings longer than 200 characters", async () => {
    await expect(
      submitFeedback({ type: "suggestion", message: "ok", contact: "c".repeat(201) }),
    ).rejects.toThrow("联系方式不能超过 200 字")
  })

  it("posts trimmed feedback with app version and user agent in non-Tauri mode", async () => {
    mocks.isTauri.mockReturnValue(false)
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))

    await submitFeedback(validInput())

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://qmai-analytics.qmai.workers.dev/feedback")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      type: "bug",
      message: "发现一个问题",
      contact: "user@example.com",
      appVersion: expect.any(String),
      userAgent: expect.any(String),
    })
  })

  it("posts an empty user agent when navigator is unavailable", async () => {
    mocks.isTauri.mockReturnValue(false)
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal("navigator", undefined)

    await submitFeedback(validInput())

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))
    expect(body.userAgent).toBe("")
  })

  it("throws when the server responds non-OK", async () => {
    mocks.isTauri.mockReturnValue(false)
    fetchSpy.mockResolvedValue(new Response("oops", { status: 500 }))
    await expect(submitFeedback(validInput())).rejects.toThrow("反馈提交失败，请稍后再试")
  })

  it("uses the Tauri HTTP plugin inside Tauri", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.tauriFetch.mockResolvedValue(new Response(null, { status: 200 }))

    await submitFeedback(validInput())

    expect(mocks.tauriFetch).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("falls back to fetch when the Tauri plugin fails", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.tauriFetch.mockRejectedValue(new Error("plugin crash"))
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))

    await submitFeedback(validInput())

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("surfaces a combined error when both Tauri and fetch fail", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.tauriFetch.mockRejectedValue(new Error("plugin crash"))
    fetchSpy.mockRejectedValue(new Error("network down"))

    await expect(submitFeedback(validInput())).rejects.toThrow("请检查网络后重试：plugin crash")
  })

  it("stringifies non-Error tauri failures", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.tauriFetch.mockRejectedValue("plugin exploded")
    fetchSpy.mockRejectedValue(new Error("network down"))

    await expect(submitFeedback(validInput())).rejects.toThrow("请检查网络后重试：plugin exploded")
  })
})
