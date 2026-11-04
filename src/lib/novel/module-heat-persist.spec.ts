// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// A-04 读盘侧加固的**直接**单测（RV-010：上一版只在 store 层经 hydrate 间接覆盖，
// 纯函数与「容器字段原样透传」的契约没有任何断言）。

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: vi.fn(),
  fileExists: vi.fn(),
  createDir: vi.fn(),
  renameFile: vi.fn(),
  removeFile: vi.fn(),
}))

import { loadHeatSnapshot } from "./module-heat-persist"

const PROJECT = "C:/QM-BOOK/demo"

function snapshot(hits: unknown[]) {
  return JSON.stringify({
    fileVersion: 1,
    sessionStartedAt: 1_700_000_000_000,
    savedAt: 1_700_000_100_000,
    hits,
  })
}

beforeEach(() => {
  mocks.readFile.mockReset()
})

describe("loadHeatSnapshot 读盘侧过滤（A-04）", () => {
  it("坏条目被丢弃，好条目原样保留", async () => {
    mocks.readFile.mockResolvedValue(
      snapshot([
        { path: "src/lib/novel/campaign-runner.ts", at: 1, ok: true },
        "not-an-object",
        null,
        { path: "", at: 2, ok: true },
        { path: "a.ts", at: Number.NaN, ok: true },
        { path: "src/lib/novel/chapter-pipeline.ts", at: 3, ok: false, ms: 12, detail: "ch3" },
      ]),
    )
    const loaded = await loadHeatSnapshot(PROJECT)
    expect(loaded?.hits).toEqual([
      { path: "src/lib/novel/campaign-runner.ts", at: 1, ok: true },
      { path: "src/lib/novel/chapter-pipeline.ts", at: 3, ok: false, ms: 12, detail: "ch3" },
    ])
  })

  it("容器字段原样透传（fileVersion / sessionStartedAt / savedAt 一个都不能丢）", async () => {
    mocks.readFile.mockResolvedValue(snapshot([]))
    const loaded = await loadHeatSnapshot(PROJECT)
    expect(loaded).toEqual({
      fileVersion: 1,
      sessionStartedAt: 1_700_000_000_000,
      savedAt: 1_700_000_100_000,
      hits: [],
    })
  })

  it("全部条目都非法时仍返回合法快照（空 hits），而不是 null", async () => {
    // 若返回 null，hydrate 会当成「没有快照」而跳过回填标记；返回空快照才是「读过且没可用数据」。
    mocks.readFile.mockResolvedValue(snapshot([{ path: 1 }, { at: 2 }]))
    const loaded = await loadHeatSnapshot(PROJECT)
    expect(loaded).not.toBeNull()
    expect(loaded?.hits).toEqual([])
    expect(loaded?.fileVersion).toBe(1)
  })

  it("RV-003：detail 为对象 / ms 非数值的条目被丢弃（否则渲染时抛 Objects are not valid as a React child）", async () => {
    mocks.readFile.mockResolvedValue(
      snapshot([
        { path: "a.ts", at: 1, ok: true, detail: { nested: 1 } },
        { path: "b.ts", at: 2, ok: true, ms: { nested: 1 } },
        { path: "c.ts", at: 3, ok: true, ms: Number.POSITIVE_INFINITY },
        { path: "d.ts", at: 4, ok: true, detail: ["x"] },
        { path: "ok.ts", at: 5, ok: true, ms: 7, detail: "fine" },
      ]),
    )
    const loaded = await loadHeatSnapshot(PROJECT)
    expect(loaded?.hits).toEqual([{ path: "ok.ts", at: 5, ok: true, ms: 7, detail: "fine" }])
  })

  it("ok 非布尔也丢弃（aggregateHeat 用它分支统计）", async () => {
    mocks.readFile.mockResolvedValue(
      snapshot([
        { path: "a.ts", at: 1 },
        { path: "b.ts", at: 2, ok: "true" },
        { path: "c.ts", at: 3, ok: false },
      ]),
    )
    const loaded = await loadHeatSnapshot(PROJECT)
    expect(loaded?.hits).toEqual([{ path: "c.ts", at: 3, ok: false }])
  })

  it("fileVersion 不是 1 → 整份拒读（契约未变）", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ fileVersion: 2, hits: [] }))
    expect(await loadHeatSnapshot(PROJECT)).toBeNull()
  })

  it("hits 不是数组 → 整份拒读", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ fileVersion: 1, hits: {} }))
    expect(await loadHeatSnapshot(PROJECT)).toBeNull()
  })

  it("读取失败 / JSON 损坏 → null，不抛", async () => {
    mocks.readFile.mockRejectedValue(new Error("ENOENT"))
    expect(await loadHeatSnapshot(PROJECT)).toBeNull()
    mocks.readFile.mockResolvedValue("{not json")
    expect(await loadHeatSnapshot(PROJECT)).toBeNull()
  })
})
