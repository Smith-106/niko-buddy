/** C4 冒烟覆盖：src/lib/novel/anti-ai-corpus-fs.ts（自动生成，核心行为由专项 spec 加深） */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"
import { resolveDefaultCorpusRoot, loadCorpusLayer } from "./anti-ai-corpus-fs"
describe("anti-ai-corpus-fs.ts smoke", () => {
  it("resolveDefaultCorpusRoot() executes", async () => {
    await (resolveDefaultCorpusRoot() as unknown as Promise<unknown>)
  })
  it("exports loadCorpusLayer", () => {
    expect(loadCorpusLayer).toBeDefined()
  })
})

describe("loadCorpusLayer 读失败跳过", () => {
  it("单个语料文件读不出时记 warn 并跳过，其余样本照常返回", () => {
    const root = mkdtempSync(join(tmpdir(), "corpus-"))
    try {
      const dir = join(root, "human", "batch-1")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "xianxia-001.txt"), "样本正文")
      // 目录伪装成 .txt：readFileSync 抛 EISDIR，走 catch
      mkdirSync(join(dir, "xianxia-002.txt"))
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

      const samples = loadCorpusLayer(root, "human", "1")

      expect(samples.map((s) => s.file)).toEqual(["xianxia-001.txt"])
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("loadCorpusLayer 目录与 json 过滤", () => {
  it("层目录不存在记 warn 并跳过；.json 金标准被跳过不进入样本", () => {
    const root = mkdtempSync(join(tmpdir(), "corpus-"))
    try {
      const dir = join(root, "ai", "batch-9")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "yanqing-001.txt"), "正文")
      writeFileSync(join(dir, "structure.json"), "{}")
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

      const samples = loadCorpusLayer(root, "ai", ["9", "missing"])

      expect(samples.map((s) => s.file)).toEqual(["yanqing-001.txt"])
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
