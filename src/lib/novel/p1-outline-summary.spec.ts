// ISS-20260712-REL-1: reliability Medium/Low 收敛（空 catch 无日志 + outline-import 失败不汇总 + ch 残留）。
// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (_p: string): Promise<string> => ""),
  writeFile: vi.fn(async (): Promise<void> => {}),
  createDirectory: vi.fn(async (): Promise<void> => {}),
  listDirectory: vi.fn(async (): Promise<never[]> => []),
  getUnique: vi.fn(async (_dir: string, name: string): Promise<string> => `${_dir}/${name}`),
}))
vi.mock("@/commands/fs", async () => {
  const actual = await vi.importActual<typeof import("@/commands/fs")>("@/commands/fs")
  return { ...actual, readFile: fsMocks.readFile, writeFile: fsMocks.writeFile, createDirectory: fsMocks.createDirectory, listDirectory: fsMocks.listDirectory }
})
vi.mock("@/lib/path-utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/path-utils")>("@/lib/path-utils")
  return { ...actual, getUniqueOutlinePath: fsMocks.getUnique }
})

import { importOutlinesWithSummary } from "./source-outline-import"

describe("ISS-20260712-REL-1 可靠性收敛", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("批量汇总：成功/失败计数 + 逐条结果（单条失败不阻断其余）", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.includes("bad")) throw new Error("read boom: bad.md")
      return "# 内容"
    })
    const { results, succeeded, failed } = await importOutlinesWithSummary("/P", [
      { sourcePath: "/src/good.md", target: "story-outline" },
      { sourcePath: "/src/bad.md", target: "story-outline" },
    ])
    expect(results).toHaveLength(2)
    expect(succeeded).toBe(1)
    expect(failed).toBe(1)
    expect(results.find((r) => r.sourcePath.includes("good"))?.ok).toBe(true)
    const bad = results.find((r) => r.sourcePath.includes("bad"))!
    expect(bad.ok).toBe(false)
    // 脱敏：失败原因为 message 字符串，不含错误对象
    expect(typeof bad.error).toBe("string")
    expect(bad.error).toContain("read boom")
    expect(bad.outlinePath).toBe("")
  })

  it("全成功批量：failed=0 且汇总不抛", async () => {
    fsMocks.readFile.mockResolvedValue("# 内容")
    const { succeeded, failed } = await importOutlinesWithSummary("/P", [
      { sourcePath: "/src/a.md", target: "story-outline" },
    ])
    expect(succeeded).toBe(1)
    expect(failed).toBe(0)
  })

  it("空批量：零结果零失败（行为等价空循环）", async () => {
    const { results, succeeded, failed } = await importOutlinesWithSummary("/P", [])
    expect(results).toEqual([])
    expect(succeeded).toBe(0)
    expect(failed).toBe(0)
  })
})
