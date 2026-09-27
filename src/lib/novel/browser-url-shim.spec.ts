/** C4 冒烟覆盖：src/lib/novel/browser-url-shim.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { fileURLToPath } from "./browser-url-shim"
describe("browser-url-shim.ts smoke", () => {
  it("fileURLToPath() throws the documented browser-shim error", () => {
    // webview（tauri:// 协议）下 fileURLToPath 本就不可用——调用方 try/catch 降级
    expect(() => fileURLToPath()).toThrow("node:url unavailable in browser (shim)")
  })
})
