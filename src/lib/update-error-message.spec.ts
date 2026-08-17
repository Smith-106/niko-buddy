import { describe, expect, it } from "vitest"
import { formatUpdateErrorMessage } from "./update-error-message"

describe("formatUpdateErrorMessage", () => {
  it("maps the remote-release-fetch failure to a friendly hint", () => {
    const err = new Error("Could not fetch a valid release JSON from the remote")
    expect(formatUpdateErrorMessage(err)).toBe(
      "检查更新失败：没有从更新服务器拿到有效的版本信息。请先确认网络可以访问 GitHub，若未启用代理请关闭系统或软件代理后重试。",
    )
  })

  it("maps the message even when delivered as a plain string", () => {
    expect(formatUpdateErrorMessage("Could not fetch a valid release JSON from the remote")).toBe(
      "检查更新失败：没有从更新服务器拿到有效的版本信息。请先确认网络可以访问 GitHub，若未启用代理请关闭系统或软件代理后重试。",
    )
  })

  it("wraps an Error message verbatim", () => {
    expect(formatUpdateErrorMessage(new Error("404 Not Found"))).toBe(
      "检查更新失败：404 Not Found",
    )
  })

  it("stringifies non-Error values", () => {
    expect(formatUpdateErrorMessage("timeout")).toBe("检查更新失败：timeout")
    expect(formatUpdateErrorMessage(42)).toBe("检查更新失败：42")
  })

  it("falls back to a generic message for empty or whitespace errors", () => {
    expect(formatUpdateErrorMessage(new Error(""))).toBe("检查更新失败：请稍后重试。")
    expect(formatUpdateErrorMessage("   ")).toBe("检查更新失败：请稍后重试。")
    expect(formatUpdateErrorMessage("")).toBe("检查更新失败：请稍后重试。")
  })

  it("stringifies nullish values without crashing", () => {
    expect(formatUpdateErrorMessage(null)).toBe("检查更新失败：null")
    expect(formatUpdateErrorMessage(undefined)).toBe("检查更新失败：undefined")
  })
})
