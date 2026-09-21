import { describe, expect, it } from "vitest"

import {
  appendCapabilityTrace,
  capabilityTraceFilePath,
  readCapabilityTraces,
  type CapabilityTraceDeps,
} from "./capability-trace-store"

function memFs() {
  const files = new Map<string, string>()
  const deps: CapabilityTraceDeps = {
    readFile: async (p) => files.get(p) ?? "",
    writeFile: async (p, c) => { files.set(p, c) },
    fileExists: async (p) => files.has(p),
    createDirectory: async () => {},
  }
  return { files, deps }
}

function rec(query = "润色本章"): Omit<Parameters<typeof appendCapabilityTrace>[1], "at"> {
  return {
    query,
    intent: "polish_chapter",
    mode: "standard",
    retrieved: ["a", "b"],
    filteredOut: [{ id: "c", reason: "mode 不匹配" }],
    planned: [{ id: "a", name: "A", kind: "user_skill", permission: "auto", reason: "先查" }],
    outcome: "success",
  }
}

describe("capability-trace-store", () => {
  it("append 写一行 JSONL 到 .novel/capability-traces/trace.jsonl", async () => {
    const { files, deps } = memFs()
    await appendCapabilityTrace("proj1", rec(), deps)
    const file = capabilityTraceFilePath("proj1")
    expect(file).toBe("proj1/.novel/capability-traces/trace.jsonl")
    expect(files.has(file)).toBe(true)
    const lines = files.get(file)!.trim().split("\n")
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.intent).toBe("polish_chapter")
    expect(parsed.outcome).toBe("success")
    expect(parsed.at).toBeGreaterThan(0)
  })

  it("连续 append 追加新行（append-only）", async () => {
    const { deps } = memFs()
    await appendCapabilityTrace("p", rec("第一次"), deps)
    await appendCapabilityTrace("p", rec("第二次"), deps)
    const all = await readCapabilityTraces("p", deps)
    expect(all).toHaveLength(2)
    expect(all[0].query).toBe("第一次")
    expect(all[1].query).toBe("第二次")
  })

  it("query 超 2000 字截断", async () => {
    const { deps } = memFs()
    await appendCapabilityTrace("p", rec("x".repeat(3000)), deps)
    const all = await readCapabilityTraces("p", deps)
    expect(all[0].query.length).toBeLessThan(2100)
    expect(all[0].query).toContain("truncated")
  })

  it("IO 失败吞错不抛出（旁路观测不阻断主链）", async () => {
    const bad: CapabilityTraceDeps = {
      readFile: async () => { throw new Error("io") },
      writeFile: async () => { throw new Error("io") },
      fileExists: async () => { throw new Error("io") },
      createDirectory: async () => { throw new Error("io") },
    }
    await expect(appendCapabilityTrace("p", rec(), bad)).resolves.toBeUndefined()
    await expect(readCapabilityTraces("p", bad)).resolves.toEqual([])
  })

  it("损坏行跳过 + 空文件返回空", async () => {
    const { files, deps } = memFs()
    const file = capabilityTraceFilePath("p")
    files.set(file, '{"a":1}\nnot-json\n{"a":2}\n')
    const all = await readCapabilityTraces("p", deps)
    expect(all).toHaveLength(2)
  })
})
