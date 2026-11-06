/** C4 冒烟覆盖：src/lib/agent/tools/read-memory.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it, vi } from "vitest"
import { createReadMemoryTool } from "./read-memory"

describe("read-memory.ts smoke", () => {
  it("exports createReadMemoryTool", () => {
    expect(createReadMemoryTool).toBeDefined()
  })

  it("多条 pattern 同时命中时按声明顺序拼接全部命中的独立别名文件", async () => {
    // 「人物状态人物认知」同时命中 character-states.md（人物状态/角色状态）
    // 与 character-cognition.md（人物认知/角色认知）；两个条目 fileName 不同，
    // 因此都通过去重 filter，按 MEMORY_ALIAS_FILES 声明顺序读取与拼接。
    const readTextFile = vi.fn(async (path: string) => `内容:${path.split("/").pop()}`)
    const tool = createReadMemoryTool("/memory", readTextFile)

    const result = await tool.execute({ name: "人物状态人物认知" })

    expect(result).toContain("已读取记忆条目「人物状态人物认知」对应的结构化记忆")
    expect(readTextFile).toHaveBeenCalledTimes(2)
    expect(readTextFile.mock.calls.map((c) => c[0])).toEqual([
      "/memory/character-states.md",
      "/memory/character-cognition.md",
    ])
    expect(result.indexOf("## 人物状态记忆")).toBeLessThan(result.indexOf("## 人物认知记忆"))
    expect(result).toContain("内容:character-states.md")
    expect(result).toContain("内容:character-cognition.md")
    // 两个小节之间有分隔符，且各出现一次
    expect(result).toContain("\n\n---\n\n")
    expect(result.match(/## 人物状态记忆/g)).toHaveLength(1)
    expect(result.match(/## 人物认知记忆/g)).toHaveLength(1)
  })

  it("同一别名的多条 pattern 只产出一次读取（.filter 每条目至多一次）", async () => {
    // 「伏笔线索」命中 foreshadowing-tracker.md 的两条 pattern（/伏笔/、/线索/），
    // 但 MEMORY_ALIAS_FILES.filter 对该条目只会 push 一次 —— 锁定既有契约：
    // 多 pattern 命中不等于多份内容。
    const readTextFile = vi.fn(async (path: string) => `内容:${path.split("/").pop()}`)
    const tool = createReadMemoryTool("/memory", readTextFile)

    const result = await tool.execute({ name: "伏笔线索" })

    expect(readTextFile).toHaveBeenCalledTimes(1)
    expect(readTextFile).toHaveBeenCalledWith("/memory/foreshadowing-tracker.md")
    expect(result.match(/## 伏笔追踪记忆/g)).toHaveLength(1)
    expect(result).toContain("内容:foreshadowing-tracker.md")
  })
})
