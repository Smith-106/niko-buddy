/**
 * listSnapshots failLoud —— 章节目录需要诚实错误态（grok Wave1 审查发现 1）。
 * 目录不存在 → []；failLoud 下真正的 IO 失败必须抛出，不得伪装成「暂无章节」。
 */
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, listDirectory: vi.fn() }
})

const fsMod = await import("@/commands/fs")
const { listSnapshots } = await import("./chapter-ingest")

describe("listSnapshots failLoud", () => {
  afterEach(() => {
    vi.mocked(fsMod.listDirectory).mockReset()
  })

  it("failLoud=true：权限类错误必须抛（不得谎报空目录）", async () => {
    vi.mocked(fsMod.listDirectory).mockRejectedValueOnce(new Error("Permission denied"))
    await expect(listSnapshots("C:/p", { failLoud: true })).rejects.toThrow("Permission denied")
  })

  it("failLoud=true：目录不存在 → 诚实空数组", async () => {
    vi.mocked(fsMod.listDirectory).mockRejectedValueOnce(new Error("No such file or directory"))
    await expect(listSnapshots("C:/p", { failLoud: true })).resolves.toEqual([])
  })

  it("默认（failLoud 省略）：保持旧行为吞错返回 []", async () => {
    vi.mocked(fsMod.listDirectory).mockRejectedValueOnce(new Error("Permission denied"))
    await expect(listSnapshots("C:/p")).resolves.toEqual([])
  })
})
