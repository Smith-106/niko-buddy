// SPDX-License-Identifier: MIT
// memoryJournal：测试专用内存 journal 依赖，写计数必须可观察。
import { describe, expect, it } from "vitest"

import { memoryJournal } from "./stage-output-journal-test-helpers"

describe("memoryJournal", () => {
  it("初始写计数为 0；写一次后写入计数与文件表同步", async () => {
    const journal = memoryJournal()
    expect(journal.writes).toBe(0)
    await journal.runtime.deps.writeFile("/tmp/x.jsonl", "line\n")
    expect(journal.writes).toBe(1)
    expect(journal.files.get("/tmp/x.jsonl")).toBe("line\n")
    expect(await journal.runtime.deps.read("/tmp/x.jsonl")).toBe("line\n")
  })
})
