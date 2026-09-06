import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(async () => {}),
  writeFileAtomic: vi.fn(async (_p: string, _content: string) => {}),
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("ENOENT")
  }),
  deleteFile: vi.fn(async () => {}),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  writeFileAtomic: fsMocks.writeFileAtomic,
  readFile: fsMocks.readFile,
  deleteFile: fsMocks.deleteFile,
}))

import {
  computeFrameworkSignature,
  createBranchCanonBinding,
  detectBindingStaleness,
  loadBranchCanonBindings,
  pruneStaleBranchBindings,
  saveBranchCanonBindings,
} from "./framework-binding"
import type { BranchCanonBinding, FrameworkBinding, StoryFramework } from "./types"

function framework(overrides: Partial<StoryFramework> = {}): StoryFramework {
  return {
    id: "fw-1",
    title: "血月剑歌",
    premise: "少年剑客复仇",
    targetWords: 30000,
    sourceChapters: 10,
    simulationMode: "event-driven",
    nodes: [
      {
        index: 1,
        phase: "起",
        title: "雪夜入门",
        coreConflict: "师门背叛",
        involvedCharacters: ["张三"],
        goal: "入门",
        causeFromPrev: "",
        expectedOutcome: "拜师",
      },
      {
        index: 2,
        phase: "承",
        title: "青云试炼",
        coreConflict: "夺剑",
        involvedCharacters: ["李四"],
        goal: "试炼",
        causeFromPrev: "入门",
        expectedOutcome: "夺剑失败",
      },
    ],
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  }
}

const binding: FrameworkBinding = {
  frameworkId: "fw-1",
  frameworkTitle: "血月剑歌",
  targetChapterCount: 8,
  chapterAllocation: [
    { nodeIndex: 1, nodeTitle: "雪夜入门", startChapter: 1, endChapter: 4 },
    { nodeIndex: 2, nodeTitle: "青云试炼", startChapter: 5, endChapter: 8 },
  ],
  boundAt: "2026-09-01T00:00:00.000Z",
}

beforeEach(() => {
  fsMocks.readFile.mockReset()
  fsMocks.readFile.mockImplementation(async () => {
    throw new Error("ENOENT")
  })
  fsMocks.writeFileAtomic.mockClear()
})

describe("branch-canon-binding (64 号实施：分支正史绑定 + stale 半环)", () => {
  it("签名确定性：同框架同签名", () => {
    expect(computeFrameworkSignature(framework())).toBe(computeFrameworkSignature(framework()))
  })

  it("签名内容敏感：premise 变更 → 签名变更", () => {
    expect(computeFrameworkSignature(framework({ premise: "少年剑客寻亲" }))).not.toBe(
      computeFrameworkSignature(framework()),
    )
  })

  it("签名内容敏感：nodes 变更 → 签名变更", () => {
    const f = framework()
    f.nodes[0].coreConflict = "师门清洗"
    expect(computeFrameworkSignature(f)).not.toBe(computeFrameworkSignature(framework()))
  })

  it("createBranchCanonBinding：固化分支引用（Draft-first：显式 accept 才生成）", () => {
    const f = framework()
    const b = createBranchCanonBinding(f, "branch-1", {
      acceptedAt: "2026-09-02T00:00:00.000Z",
      canonStartChapter: 3,
    })
    expect(b.branchId).toBe("branch-1")
    expect(b.frameworkId).toBe("fw-1")
    expect(b.frameworkSignature).toBe(computeFrameworkSignature(f))
    expect(b.canonStartChapter).toBe(3)
  })

  it("stale 半环：框架签名变更 → 分支绑定 stale", () => {
    const f = framework()
    const branchBindings: BranchCanonBinding[] = [
      createBranchCanonBinding(f, "branch-1", { acceptedAt: "2026-09-02T00:00:00.000Z" }),
    ]
    const changed = framework({ premise: "少年剑客寻亲" })
    const s = detectBindingStaleness(binding, branchBindings, changed)
    expect(s.branchBindingStale).toBe(true)
    expect(s.reasons.some((r) => r.includes("签名变更"))).toBe(true)
  })

  it("stale 半环：框架 ID 不匹配 → 两环均 stale", () => {
    const f = framework()
    const other = framework({ id: "fw-2" })
    const s = detectBindingStaleness(binding, [createBranchCanonBinding(f, "b1")], other)
    expect(s.frameworkBindingStale).toBe(true)
    expect(s.branchBindingStale).toBe(true)
    expect(s.reasons.some((r) => r.includes("不匹配"))).toBe(true)
  })

  it("stale 半环：无激活绑定 → 框架绑定 stale，分支绑定不受牵连", () => {
    const f = framework()
    const s = detectBindingStaleness(null, [], f)
    expect(s.frameworkBindingStale).toBe(true)
    expect(s.branchBindingStale).toBe(false)
  })

  it("健康状态：绑定+分支均与当前框架一致 → 双环均不 stale", () => {
    const f = framework()
    const bb = [createBranchCanonBinding(f, "branch-1")]
    const s = detectBindingStaleness(binding, bb, f)
    expect(s.frameworkBindingStale).toBe(false)
    expect(s.branchBindingStale).toBe(false)
    expect(s.reasons).toEqual([])
  })

  it("prune：签名变更后修剪 → 保留同签名绑定，剔除 stale 引用", () => {
    const f = framework()
    const bb = [
      createBranchCanonBinding(f, "branch-keep"),
      createBranchCanonBinding(framework({ premise: "少年剑客寻亲" }), "branch-stale"),
    ]
    const pruned = pruneStaleBranchBindings(bb, f)
    expect(pruned.map((b) => b.branchId)).toEqual(["branch-keep"])
  })

  it("持久化 round-trip：save → load 一致", async () => {
    const f = framework()
    const bb = [createBranchCanonBinding(f, "branch-1")]
    let captured = ""
    fsMocks.writeFileAtomic.mockImplementation(async (_p: string, content: string) => {
      captured = content
    })
    await saveBranchCanonBindings("/proj", bb)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    fsMocks.readFile.mockImplementation(async () => captured)
    const loaded = await loadBranchCanonBindings("/proj")
    expect(loaded).toHaveLength(1)
    expect(loaded[0].branchId).toBe("branch-1")
  })

  it("load：损坏 JSON 降级 []", async () => {
    fsMocks.readFile.mockImplementation(async () => "{ nope")
    expect(await loadBranchCanonBindings("/proj")).toEqual([])
  })

  it("load：非数组 JSON 降级 []", async () => {
    fsMocks.readFile.mockImplementation(async () => '{"a":1}')
    expect(await loadBranchCanonBindings("/proj")).toEqual([])
  })

  it("纯性：detectBindingStaleness 不改输入", () => {
    const f = framework()
    const bb = [createBranchCanonBinding(f, "b1")]
    const bbSnapshot = JSON.stringify(bb)
    detectBindingStaleness(binding, bb, f)
    expect(JSON.stringify(bb)).toBe(bbSnapshot)
  })
})
