/** C4 冒烟覆盖：src/lib/format-operation-error.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { formatOperationError } from "./format-operation-error"
describe("format-operation-error.ts", () => {
  const t = ((_k: string, def?: string) => def ?? "操作失败") as never

  it("exports formatOperationError", () => {
    expect(formatOperationError).toBeDefined()
  })

  it("formats Error, string, and plain objects without [object Object]", () => {
    expect(formatOperationError(t, new Error("disk full"))).toBe("操作失败：disk full")
    expect(formatOperationError(t, "plain error")).toBe("操作失败：plain error")
    expect(formatOperationError(t, { message: "msg-obj" })).toBe("操作失败：msg-obj")
    expect(formatOperationError(t, { error: "err-obj" })).toBe("操作失败：err-obj")
    expect(formatOperationError(t, { code: "EACCES" })).toBe('操作失败：{"code":"EACCES"}')

    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(formatOperationError(t, circular)).toBe("操作失败：未知错误")
    expect(formatOperationError(t, {})).toBe("操作失败：未知错误")
  })
})
