/**
 * framework-binding 行为测试（原 C4 空壳已删除，此文件为真实专项测试）。
 *
 * 覆盖 AI 会话绑定全链路：
 * - saveBinding 章节分配：均分 / 余数前置 / 排序 / 空节点 / 目标章数小于节点数
 * - loadBinding：命中 / 缺失 / 损坏 / 缺 frameworkId / null
 * - clearBinding：删除与缺失容错
 * - buildBindingContext：单章与区间渲染、缺节点标签、无分配行、要求段落
 * - 分支正史绑定 + stale 半环：签名确定性与敏感性、绑定创建、stale 判定、修剪
 * - 分支绑定持久化：round-trip / 损坏与非数组降级
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(async () => {}),
  writeFileAtomic: vi.fn(async (_p: string, _content: string) => {}),
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("ENOENT")
  }),
  deleteFile: vi.fn(async () => {}),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    createDirectory: fsMocks.createDirectory,
    writeFileAtomic: fsMocks.writeFileAtomic,
    readFile: fsMocks.readFile,
    deleteFile: fsMocks.deleteFile,
  }
})

import {
  buildBindingContext,
  clearBinding,
  computeFrameworkSignature,
  createBranchCanonBinding,
  detectBindingStaleness,
  loadBinding,
  loadBranchCanonBindings,
  pruneStaleBranchBindings,
  saveBinding,
  saveBranchCanonBindings,
} from "./framework-binding"
import type {
  BranchCanonBinding,
  FrameworkBinding,
  StoryFramework,
  StoryNode,
} from "./types"

function node(index: number, phase: StoryNode["phase"] = "起", title?: string): StoryNode {
  return {
    index,
    phase,
    title: title ?? `节点${index}`,
    coreConflict: `冲突${index}`,
    involvedCharacters: [],
    goal: `目标${index}`,
    causeFromPrev: index === 0 ? "故事开端" : "承接",
    expectedOutcome: `结局${index}`,
  }
}

function framework(overrides: Partial<StoryFramework> = {}): StoryFramework {
  return {
    id: "fw-1",
    title: "血月剑歌",
    premise: "少年剑客复仇",
    targetWords: 30000,
    sourceChapters: 10,
    simulationMode: "event-driven",
    nodes: [node(0, "起"), node(1, "承"), node(2, "转"), node(3, "合")],
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  }
}

const ACTIVE_SUFFIX = ".niko-buddy/simulations/bindings/active-binding.json"
const CANON_SUFFIX = ".niko-buddy/simulations/bindings/branch-canon.json"

beforeEach(() => {
  fsMocks.createDirectory.mockClear()
  fsMocks.writeFileAtomic.mockClear()
  fsMocks.deleteFile.mockClear()
  fsMocks.readFile.mockReset()
  fsMocks.readFile.mockImplementation(async () => {
    throw new Error("ENOENT")
  })
})

describe("saveBinding 章节分配", () => {
  it("10 章分给 4 节点：余数优先补给前面的节点", async () => {
    const binding = await saveBinding("/proj", framework(), 10)
    expect(binding.frameworkId).toBe("fw-1")
    expect(binding.frameworkTitle).toBe("血月剑歌")
    expect(binding.targetChapterCount).toBe(10)
    expect(binding.chapterAllocation).toEqual([
      { nodeIndex: 0, nodeTitle: "节点0", startChapter: 1, endChapter: 3 },
      { nodeIndex: 1, nodeTitle: "节点1", startChapter: 4, endChapter: 6 },
      { nodeIndex: 2, nodeTitle: "节点2", startChapter: 7, endChapter: 8 },
      { nodeIndex: 3, nodeTitle: "节点3", startChapter: 9, endChapter: 10 },
    ])
    expect(Number.isNaN(Date.parse(binding.boundAt))).toBe(false)
  })

  it("整除时每节点均分且写入绑定文件", async () => {
    let writtenPath = ""
    let writtenContent = ""
    fsMocks.writeFileAtomic.mockImplementationOnce(async (p: string, content: string) => {
      writtenPath = p
      writtenContent = content
    })
    const binding = await saveBinding("/proj", framework(), 8)
    expect(binding.chapterAllocation).toEqual([
      { nodeIndex: 0, nodeTitle: "节点0", startChapter: 1, endChapter: 2 },
      { nodeIndex: 1, nodeTitle: "节点1", startChapter: 3, endChapter: 4 },
      { nodeIndex: 2, nodeTitle: "节点2", startChapter: 5, endChapter: 6 },
      { nodeIndex: 3, nodeTitle: "节点3", startChapter: 7, endChapter: 8 },
    ])
    expect(fsMocks.createDirectory).toHaveBeenCalledWith(
      "/proj/.niko-buddy/simulations/bindings",
    )
    expect(writtenPath).toBe(`/proj/${ACTIVE_SUFFIX}`)
    expect(JSON.parse(writtenContent)).toEqual(binding)
  })

  it("乱序节点按 index 排序后再分配", async () => {
    const fw = framework({ nodes: [node(2, "转"), node(0, "起"), node(1, "承")] })
    const binding = await saveBinding("/proj", fw, 3)
    expect(binding.chapterAllocation.map((a) => a.nodeIndex)).toEqual([0, 1, 2])
    expect(binding.chapterAllocation[0]).toMatchObject({ startChapter: 1, endChapter: 1 })
  })

  it("空节点列表：分配为空但仍写入文件", async () => {
    const binding = await saveBinding("/proj", framework({ nodes: [] }), 5)
    expect(binding.chapterAllocation).toEqual([])
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
  })

  it("目标章数小于节点数：后排节点零分配", async () => {
    const binding = await saveBinding("/proj", framework({ nodes: [node(0), node(1), node(2)] }), 2)
    expect(binding.chapterAllocation).toEqual([
      { nodeIndex: 0, nodeTitle: "节点0", startChapter: 1, endChapter: 1 },
      { nodeIndex: 1, nodeTitle: "节点1", startChapter: 2, endChapter: 2 },
      { nodeIndex: 2, nodeTitle: "节点2", startChapter: 3, endChapter: 2 },
    ])
  })

  it("路径含反斜杠时归一化为正斜杠", async () => {
    await saveBinding("C:\\proj", framework(), 4)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      `C:/proj/${ACTIVE_SUFFIX}`,
      expect.any(String),
    )
  })
})

describe("loadBinding", () => {
  const stored: FrameworkBinding = {
    frameworkId: "fw-1",
    frameworkTitle: "血月剑歌",
    targetChapterCount: 8,
    chapterAllocation: [
      { nodeIndex: 0, nodeTitle: "节点0", startChapter: 1, endChapter: 4 },
      { nodeIndex: 1, nodeTitle: "节点1", startChapter: 5, endChapter: 8 },
    ],
    boundAt: "2026-09-01T00:00:00.000Z",
  }

  it("命中：返回解析后的绑定并按归一化路径读取", async () => {
    fsMocks.readFile.mockImplementationOnce(async () => JSON.stringify(stored))
    const loaded = await loadBinding("/proj")
    expect(loaded).toEqual(stored)
    expect(fsMocks.readFile).toHaveBeenCalledWith(`/proj/${ACTIVE_SUFFIX}`)
  })

  it("文件缺失：返回 null", async () => {
    expect(await loadBinding("/proj")).toBeNull()
  })

  it("损坏 JSON：返回 null", async () => {
    fsMocks.readFile.mockImplementationOnce(async () => "{ nope")
    expect(await loadBinding("/proj")).toBeNull()
  })

  it("缺少 frameworkId：返回 null", async () => {
    fsMocks.readFile.mockImplementationOnce(async () => "{}")
    expect(await loadBinding("/proj")).toBeNull()
  })

  it("内容为 null：返回 null", async () => {
    fsMocks.readFile.mockImplementationOnce(async () => "null")
    expect(await loadBinding("/proj")).toBeNull()
  })
})

describe("clearBinding", () => {
  it("删除激活绑定文件", async () => {
    await clearBinding("/proj")
    expect(fsMocks.deleteFile).toHaveBeenCalledWith(`/proj/${ACTIVE_SUFFIX}`)
  })

  it("文件不存在也不抛错", async () => {
    fsMocks.deleteFile.mockRejectedValueOnce(new Error("ENOENT"))
    await expect(clearBinding("/proj")).resolves.toBeUndefined()
  })
})

describe("buildBindingContext", () => {
  const binding: FrameworkBinding = {
    frameworkId: "fw-1",
    frameworkTitle: "血月剑歌",
    targetChapterCount: 8,
    chapterAllocation: [
      { nodeIndex: 0, nodeTitle: "节点0", startChapter: 1, endChapter: 4 },
      { nodeIndex: 1, nodeTitle: "节点1", startChapter: 5, endChapter: 8 },
    ],
    boundAt: "2026-09-01T00:00:00.000Z",
  }

  it("渲染标题、目标章数、区间行与要求段落", () => {
    const text = buildBindingContext(binding, framework())
    expect(text).toContain("# 故事框架绑定")
    expect(text).toContain("框架标题：血月剑歌")
    expect(text).toContain("目标章节数：8")
    expect(text).toContain("- 第1-4章 → 【起】节点0")
    expect(text).toContain("- 第5-8章 → 【承】节点1")
    expect(text).toContain("请严格遵循上述故事框架推进剧情")
    expect(text).toContain("保持各节点核心冲突与预期结果的连贯性")
  })

  it("起止相同的分配渲染为单章", () => {
    const single: FrameworkBinding = {
      ...binding,
      chapterAllocation: [{ nodeIndex: 0, nodeTitle: "节点0", startChapter: 3, endChapter: 3 }],
    }
    expect(buildBindingContext(single, framework())).toContain("- 第3章 → 【起】节点0")
  })

  it("零分配渲染为无章节分配", () => {
    const zero: FrameworkBinding = {
      ...binding,
      chapterAllocation: [{ nodeIndex: 2, nodeTitle: "节点2", startChapter: 3, endChapter: 2 }],
    }
    const fw = framework({ nodes: [node(0), node(1), node(2, "转")] })
    expect(buildBindingContext(zero, fw)).toContain("- 无章节分配 → 【转】节点2")
  })

  it("分配指向不存在的节点：不带阶段标签但保留标题", () => {
    const ghost: FrameworkBinding = {
      ...binding,
      chapterAllocation: [{ nodeIndex: 99, nodeTitle: "幽灵节点", startChapter: 1, endChapter: 2 }],
    }
    const text = buildBindingContext(ghost, framework())
    expect(text).toContain("- 第1-2章 → 幽灵节点")
    expect(text).not.toContain("【")
  })
})

describe("框架签名与分支正史绑定", () => {
  it("签名确定性：同框架同签名", () => {
    expect(computeFrameworkSignature(framework())).toBe(computeFrameworkSignature(framework()))
  })

  it("签名内容敏感：premise 与 nodes 变更均改变签名", () => {
    const base = computeFrameworkSignature(framework())
    expect(computeFrameworkSignature(framework({ premise: "少年剑客寻亲" }))).not.toBe(base)
    const changed = framework()
    changed.nodes[0].coreConflict = "师门清洗"
    expect(computeFrameworkSignature(changed)).not.toBe(base)
  })

  it("createBranchCanonBinding：显式 opt 固化 canonStartChapter", () => {
    const f = framework()
    const b = createBranchCanonBinding(f, "branch-1", {
      acceptedAt: "2026-09-02T00:00:00.000Z",
      canonStartChapter: 3,
    })
    expect(b.branchId).toBe("branch-1")
    expect(b.frameworkId).toBe("fw-1")
    expect(b.frameworkSignature).toBe(computeFrameworkSignature(f))
    expect(b.acceptedAt).toBe("2026-09-02T00:00:00.000Z")
    expect(b.canonStartChapter).toBe(3)
  })

  it("createBranchCanonBinding：缺省 acceptedAt 为 ISO 时间且不带 canonStartChapter", () => {
    const b = createBranchCanonBinding(framework(), "branch-9")
    expect(Number.isNaN(Date.parse(b.acceptedAt))).toBe(false)
    expect("canonStartChapter" in b).toBe(false)
  })
})

describe("detectBindingStaleness 半环", () => {
  const binding: FrameworkBinding = {
    frameworkId: "fw-1",
    frameworkTitle: "血月剑歌",
    targetChapterCount: 8,
    chapterAllocation: [
      { nodeIndex: 0, nodeTitle: "节点0", startChapter: 1, endChapter: 4 },
    ],
    boundAt: "2026-09-01T00:00:00.000Z",
  }

  it("健康状态：双环均不 stale", () => {
    const f = framework()
    const s = detectBindingStaleness(binding, [createBranchCanonBinding(f, "b1")], f)
    expect(s.frameworkBindingStale).toBe(false)
    expect(s.branchBindingStale).toBe(false)
    expect(s.reasons).toEqual([])
  })

  it("无激活绑定：仅框架环 stale", () => {
    const s = detectBindingStaleness(null, [], framework())
    expect(s.frameworkBindingStale).toBe(true)
    expect(s.branchBindingStale).toBe(false)
    expect(s.reasons.some((r) => r.includes("无激活框架绑定"))).toBe(true)
  })

  it("框架 ID 不匹配：两环均 stale", () => {
    const f = framework()
    const s = detectBindingStaleness(
      binding,
      [createBranchCanonBinding(f, "b1")],
      framework({ id: "fw-2" }),
    )
    expect(s.frameworkBindingStale).toBe(true)
    expect(s.branchBindingStale).toBe(true)
    expect(s.reasons.some((r) => r.includes("不匹配"))).toBe(true)
  })

  it("框架签名变更：分支环 stale 并点名分支", () => {
    const f = framework()
    const bb = [createBranchCanonBinding(f, "branch-1")]
    const s = detectBindingStaleness(binding, bb, framework({ premise: "少年剑客寻亲" }))
    expect(s.frameworkBindingStale).toBe(false)
    expect(s.branchBindingStale).toBe(true)
    expect(s.reasons.some((r) => r.includes("branch-1") && r.includes("签名变更"))).toBe(true)
  })

  it("绑定分支引用了其他框架：分支环 stale", () => {
    const other = framework({ id: "fw-2" })
    const s = detectBindingStaleness(
      binding,
      [createBranchCanonBinding(other, "branch-x")],
      framework(),
    )
    expect(s.branchBindingStale).toBe(true)
    expect(s.reasons.some((r) => r.includes("branch-x"))).toBe(true)
  })

  it("空分配绑定不计 stale（由上层处理）", () => {
    const empty: FrameworkBinding = { ...binding, chapterAllocation: [] }
    const s = detectBindingStaleness(empty, [], framework())
    expect(s.frameworkBindingStale).toBe(false)
    expect(s.reasons).toEqual([])
  })
})

describe("pruneStaleBranchBindings", () => {
  it("仅保留同框架同签名的绑定", () => {
    const f = framework()
    const bb: BranchCanonBinding[] = [
      createBranchCanonBinding(f, "keep"),
      createBranchCanonBinding(framework({ premise: "少年剑客寻亲" }), "stale-sig"),
      createBranchCanonBinding(framework({ id: "fw-2" }), "stale-id"),
    ]
    expect(pruneStaleBranchBindings(bb, f).map((b) => b.branchId)).toEqual(["keep"])
  })

  it("不改动输入数组", () => {
    const f = framework()
    const bb = [createBranchCanonBinding(f, "b1")]
    const snapshot = JSON.stringify(bb)
    pruneStaleBranchBindings(bb, f)
    expect(JSON.stringify(bb)).toBe(snapshot)
  })
})

describe("分支绑定持久化", () => {
  it("save → load round-trip 一致", async () => {
    const bb = [createBranchCanonBinding(framework(), "branch-1")]
    let captured = ""
    fsMocks.writeFileAtomic.mockImplementationOnce(async (_p: string, content: string) => {
      captured = content
    })
    await saveBranchCanonBindings("/proj", bb)
    expect(fsMocks.createDirectory).toHaveBeenCalledWith(
      "/proj/.niko-buddy/simulations/bindings",
    )
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      `/proj/${CANON_SUFFIX}`,
      expect.any(String),
    )
    fsMocks.readFile.mockImplementationOnce(async () => captured)
    const loaded = await loadBranchCanonBindings("/proj")
    expect(loaded).toHaveLength(1)
    expect(loaded[0].branchId).toBe("branch-1")
    expect(loaded[0].frameworkSignature).toBe(computeFrameworkSignature(framework()))
  })

  it("load 缺失 / 损坏 / 非数组均降级为空数组", async () => {
    expect(await loadBranchCanonBindings("/proj")).toEqual([])
    fsMocks.readFile.mockImplementationOnce(async () => "{ nope")
    expect(await loadBranchCanonBindings("/proj")).toEqual([])
    fsMocks.readFile.mockImplementationOnce(async () => '{"a":1}')
    expect(await loadBranchCanonBindings("/proj")).toEqual([])
  })
})
