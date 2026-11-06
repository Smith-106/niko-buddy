/** C4 冒烟覆盖：src/lib/agent/plugins/soul-dialog-plugin.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it, vi } from "vitest"
import { createSoulDialogPlugin } from "./soul-dialog-plugin"
describe("soul-dialog-plugin.ts smoke", () => {
  it("exports createSoulDialogPlugin", () => {
    expect(createSoulDialogPlugin).toBeDefined()
  })
})

describe("createSoulDialogPlugin run 契约", () => {
  const baseInput = { novelMode: true, contextPack: {} } as never

  it("shouldRequestSoulDialog 抛错 → onError 收到 Error，且返回空补丁（不中断管道）", async () => {
    const onError = vi.fn()
    const plugin = createSoulDialogPlugin({
      shouldRequestSoulDialog: () => {
        throw new Error("boom")
      },
      onError,
    })
    await expect(plugin.run(baseInput)).resolves.toEqual({})
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })

  it("抛出的不是 Error → 被包装成 Error 再上报", async () => {
    const onError = vi.fn()
    const plugin = createSoulDialogPlugin({
      shouldRequestSoulDialog: () => {
        throw "plain string"
      },
      onError,
    })
    await expect(plugin.run(baseInput)).resolves.toEqual({})
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect((onError.mock.calls[0]?.[0] as Error).message).toContain("plain string")
  })

  it("shouldRequestSoulDialog 为真 → 请求停止等待用户确认", async () => {
    const plugin = createSoulDialogPlugin({ shouldRequestSoulDialog: () => true })
    await expect(plugin.run(baseInput)).resolves.toEqual({
      shouldStop: true,
      stopReason: "soul_dialog_confirmation_required",
    })
  })

  it("非 novelMode 或空 contextPack → 直接空补丁", async () => {
    const plugin = createSoulDialogPlugin({ shouldRequestSoulDialog: () => true })
    await expect(plugin.run({ novelMode: false, contextPack: {} } as never)).resolves.toEqual({})
    await expect(plugin.run({ novelMode: true, contextPack: null } as never)).resolves.toEqual({})
  })
})

describe("soul-dialog-plugin 默认判据", () => {
  it("shouldRequestSoulDialog 为假 → 空补丁", async () => {
    const plugin = createSoulDialogPlugin({ shouldRequestSoulDialog: () => false })
    await expect(plugin.run({ novelMode: true, contextPack: {} } as never)).resolves.toEqual({})
  })

  it("未注入判据 → 默认看 characterAuras 是否非空", async () => {
    const plugin = createSoulDialogPlugin()
    await expect(
      plugin.run({ novelMode: true, contextPack: { characterAuras: "  " } } as never),
    ).resolves.toEqual({})
    await expect(
      plugin.run({ novelMode: true, contextPack: { characterAuras: "林晚秋：冷" } } as never),
    ).resolves.toEqual({ shouldStop: true, stopReason: "soul_dialog_confirmation_required" })
  })
})
