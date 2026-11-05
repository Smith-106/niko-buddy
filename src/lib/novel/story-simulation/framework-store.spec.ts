/**
 * 深度行为测试：framework-store
 *
 * 覆盖 Markdown 序列化 / 反序列化、框架 CRUD 与推演结果存取的真实行为
 * （返回值、落盘内容、副作用、降级路径），替换原 C4 空壳 spec。
 *
 * 依赖注入声明：本 spec 用内存文件表替换 `@/commands/fs` 的 5 个文件操作
 * （createDirectory / writeFileAtomic / readFile / deleteFile / listDirectory），
 * 生产代码未做任何改动。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import type {
  RumorEvent,
  SimulationDebugTrace,
  SimulationReport,
  SimulationResumePoint,
  StoryDraft,
  StoryFramework,
  StoryNode,
  TimelineEvent,
} from "./types"
import type { SerializedSimulationSnapshot } from "./simulation-serializer"

// ── 内存文件系统（vi.hoisted：mock 工厂执行时即可用） ──
const fsState = vi.hoisted(() => {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const failReads = new Set<string>()

  const listFrom = (dir: string): FileNode[] => {
    const prefix = `${dir}/`
    const names = new Set<string>()
    for (const path of [...files.keys(), ...dirs]) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (!rest) continue
      names.add(rest.split("/")[0])
    }
    if (names.size === 0 && !dirs.has(dir)) {
      throw new Error(`ENOENT: ${dir}`)
    }
    const nodes: FileNode[] = []
    for (const name of names) {
      const path = `${prefix}${name}`
      const isDir =
        dirs.has(path) || [...files.keys()].some((f) => f.startsWith(`${path}/`))
      nodes.push({ name, path, is_dir: isDir })
    }
    return nodes
  }

  return { files, dirs, failReads, listFrom }
})

const frontmatterState = vi.hoisted(() => ({ throws: false }))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    createDirectory: vi.fn(async (path: string) => {
      fsState.dirs.add(path)
    }),
    writeFileAtomic: vi.fn(async (path: string, content: string) => {
      fsState.files.set(path, content)
    }),
    readFile: vi.fn(async (path: string) => {
      if (fsState.failReads.has(path)) throw new Error(`EACCES: ${path}`)
      const content = fsState.files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    }),
    deleteFile: vi.fn(async (path: string) => {
      if (!fsState.files.delete(path)) throw new Error(`ENOENT: ${path}`)
    }),
    listDirectory: vi.fn(async (path: string) => fsState.listFrom(path)),
  }
})

vi.mock("@/lib/frontmatter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontmatter")>()
  return {
    ...actual,
    parseFrontmatter: (content: string) => {
      if (frontmatterState.throws) throw new Error("frontmatter boom")
      return actual.parseFrontmatter(content)
    },
  }
})

import {
  deleteFramework,
  deleteSimulationResult,
  loadFrameworks,
  loadSimulationResults,
  saveFramework,
  saveSimulationResult,
} from "./framework-store"

const PROJECT = "/proj"
const SIM_ROOT = `${PROJECT}/.niko-buddy/simulations`
const FRAMEWORKS_DIR = `${SIM_ROOT}/frameworks`
const RESULTS_DIR = `${SIM_ROOT}/results`

function makeNode(overrides: Partial<StoryNode> = {}): StoryNode {
  return {
    index: 1,
    phase: "起",
    title: "雪夜入门",
    coreConflict: "师门背叛",
    involvedCharacters: ["张三", "李四"],
    goal: "拜师成功",
    causeFromPrev: "故事开端",
    expectedOutcome: "踏入山门",
    ...overrides,
  }
}

function makeFramework(overrides: Partial<StoryFramework> = {}): StoryFramework {
  return {
    id: "fw-1",
    title: "血月剑歌",
    premise: "少年剑客复仇",
    targetWords: 30000,
    simulationMode: "hybrid",
    sourceChapters: 10,
    nodes: [makeNode()],
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  }
}

function makeReport(overrides: Partial<SimulationReport> = {}): SimulationReport {
  return {
    frameworkId: "fw-1",
    mode: "hybrid",
    characterAnalyses: [
      {
        characterId: "c1",
        name: "张三",
        behaviors: [],
        stateChanges: [],
        consistencyScore: 0.82,
      },
    ],
    branches: [
      {
        title: "分支甲",
        summary: "摘要甲",
        keyEvents: [],
        probability: "high",
        pros: "",
        cons: "",
        recommendation: true,
      },
      {
        title: "分支乙",
        summary: "摘要乙",
        keyEvents: [],
        probability: "low",
        pros: "",
        cons: "",
        recommendation: false,
      },
    ],
    recommendation: "",
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  }
}

beforeEach(() => {
  fsState.files.clear()
  fsState.dirs.clear()
  fsState.failReads.clear()
  frontmatterState.throws = false
})

/**
 * resultId 由 `result-${Date.now()}` 生成：同一毫秒内的两次保存会互相覆盖。
 * 需要两条独立结果的用例用单调时钟固定住 id，避免依赖真实毫秒推进。
 */
async function withMonotonicClock<T>(fn: () => Promise<T>): Promise<T> {
  let tick = 1_700_000_000_000
  const spy = vi.spyOn(Date, "now").mockImplementation(() => ++tick)
  try {
    return await fn()
  } finally {
    spy.mockRestore()
  }
}

describe("saveFramework：Markdown 序列化", () => {
  it("写入 frameworks/<id>.md，初始化三个仿真目录，并对 YAML 值做转义", async () => {
    const fw = makeFramework({
      title: '血色 "剑" \\ 歌',
      shortTitle: "血月",
      premise: "",
      userIdea: undefined,
      nodes: [makeNode({ index: 3, title: "终局" }), makeNode({ index: 1, title: "开端" })],
    })

    await saveFramework(PROJECT, fw)

    const md = fsState.files.get(`${FRAMEWORKS_DIR}/${fw.id}.md`)
    expect(md).toBeDefined()
    // 引号与反斜杠都被转义，反序列化才不会破坏 YAML
    expect(md).toContain('title: "血色 \\"剑\\" \\\\ 歌"')
    expect(md).toContain('shortTitle: "血月"')
    expect(md).toContain('userIdea: ""')
    // premise 为空 → 占位文案
    expect(md).toContain("## 前提\n\n（无前提）")
    // 节点按 index 升序落盘（输入是 3,1）
    expect(md!.indexOf("### 节点 1 【起】 开端")).toBeLessThan(
      md!.indexOf("### 节点 3 【起】 终局"),
    )
    expect(md).toContain("- 涉及角色：张三、李四")
    // ensureSimulationDirs 建齐 frameworks / results / bindings
    expect(fsState.dirs.has(`${SIM_ROOT}/frameworks`)).toBe(true)
    expect(fsState.dirs.has(`${SIM_ROOT}/results`)).toBe(true)
    expect(fsState.dirs.has(`${SIM_ROOT}/bindings`)).toBe(true)
  })

  it("Windows 反斜杠项目路径被归一化为正斜杠", async () => {
    await saveFramework(String.raw`C:\proj`, makeFramework())
    expect(fsState.files.has("C:/proj/.niko-buddy/simulations/frameworks/fw-1.md")).toBe(true)
  })
})

describe("loadFrameworks：反序列化与排序", () => {
  it("save → load 完整还原框架（含短标题 / 用户思路 / 多节点 / 角色分隔符）", async () => {
    const fw = makeFramework({
      shortTitle: "血月",
      userIdea: "复仇主线，强调师门内斗",
      nodes: [
        makeNode({ index: 1 }),
        makeNode({
          index: 2,
          phase: "承",
          title: "青云试炼",
          coreConflict: "夺剑之争",
          involvedCharacters: ["王五"],
          goal: "通过试炼",
          causeFromPrev: "踏入山门",
          expectedOutcome: "夺剑失败",
        }),
      ],
    })

    await saveFramework(PROJECT, fw)
    const loaded = await loadFrameworks(PROJECT)

    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toEqual(fw)
  })

  it("按 createdAt 降序返回；跳过子目录与非 .md 文件", async () => {
    // 写入顺序 mid → old → new，强制排序器两个比较方向都走到
    await saveFramework(
      PROJECT,
      makeFramework({ id: "mid", createdAt: "2026-03-01T00:00:00.000Z" }),
    )
    await saveFramework(
      PROJECT,
      makeFramework({ id: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
    )
    await saveFramework(
      PROJECT,
      makeFramework({ id: "new", createdAt: "2026-05-01T00:00:00.000Z" }),
    )
    fsState.files.set(`${FRAMEWORKS_DIR}/notes.txt`, "不是框架")
    fsState.dirs.add(`${FRAMEWORKS_DIR}/archive`)

    const loaded = await loadFrameworks(PROJECT)
    expect(loaded.map((f) => f.id)).toEqual(["new", "mid", "old"])
  })

  it("createdAt 相同时顺序稳定（比较结果 0）", async () => {
    await saveFramework(PROJECT, makeFramework({ id: "a" }))
    await saveFramework(PROJECT, makeFramework({ id: "b" }))
    const loaded = await loadFrameworks(PROJECT)
    expect(loaded.map((f) => f.id)).toEqual(["a", "b"])
  })

  it("框架目录不存在 → 空数组", async () => {
    expect(await loadFrameworks(PROJECT)).toEqual([])
  })

  it("单个文件读取失败 → 跳过该文件，其余照常返回", async () => {
    await saveFramework(PROJECT, makeFramework({ id: "ok" }))
    fsState.files.set(`${FRAMEWORKS_DIR}/broken.md`, "---\nid: broken\n---")
    fsState.failReads.add(`${FRAMEWORKS_DIR}/broken.md`)

    const loaded = await loadFrameworks(PROJECT)
    expect(loaded.map((f) => f.id)).toEqual(["ok"])
  })

  it("frontmatter 解析抛错 → 该文件降级为跳过（不中断整批加载）", async () => {
    await saveFramework(PROJECT, makeFramework({ id: "ok" }))
    frontmatterState.throws = true

    expect(await loadFrameworks(PROJECT)).toEqual([])
  })

  it("缺字段 / 非法值 / 异常节点块 → 全部走默认值与健壮解析", async () => {
    fsState.files.set(
      `${FRAMEWORKS_DIR}/raw-a.md`,
      [
        "---",
        'type: "story-framework"',
        'sourceChapters: "abc"',
        "targetWords: 12",
        'simulationMode: "bogus"',
        "---",
        "",
        "## 前提说明",
        "",
        "缺失字段时的前提正文。",
        "",
        "## 故事节点",
        "",
        "### 附录",
        "",
        "### 节点甲【承】",
        "- 核心冲突: 无序号节点",
        "- 涉及角色:",
        "- 目标 A",
        "- 未知键：忽略",
        "- 承接前因：起始",
        "- 预期结果：转折",
        "正文说明不是列表行",
        "",
        "### 节点 2",
        "- 涉及角色：张三,李四，王五、赵六",
        "- 目标：正面",
        "",
        "### 节点 1 【起】",
        "",
      ].join("\n"),
    )

    const [fw] = await loadFrameworks(PROJECT)

    // 无 id → 用文件名兜底；无 title → 默认标题；无 shortTitle/userIdea → undefined
    expect(fw.id).toBe("raw-a")
    expect(fw.title).toBe("未命名框架")
    expect(fw.shortTitle).toBeUndefined()
    expect(fw.userIdea).toBeUndefined()
    // "## 前提说明" 以「前提」开头 → 前缀匹配命中
    expect(fw.premise).toBe("缺失字段时的前提正文。")
    // sourceChapters 非数字 → 0；targetWords 正常解析
    expect(fw.sourceChapters).toBe(0)
    expect(fw.targetWords).toBe(12)
    // 非法 mode → hybrid
    expect(fw.simulationMode).toBe("hybrid")
    // createdAt 缺失 → 现取 ISO 时间
    expect(Number.isNaN(Date.parse(fw.createdAt))).toBe(false)

    // 3 个节点块；"### 附录" 不是节点块被跳过
    expect(fw.nodes).toHaveLength(3)
    // 「节点甲【承】」无数字 → index 用文档顺序 1；【承】生效；无标题段 → 回退为整行标题
    expect(fw.nodes[0]).toEqual({
      index: 1,
      phase: "承",
      title: "节点甲【承】",
      coreConflict: "无序号节点",
      involvedCharacters: [],
      goal: "",
      causeFromPrev: "起始",
      expectedOutcome: "转折",
    })
    // 无【阶段】→ 默认「起」；无标题分隔符 → 整行即标题；分隔符覆盖逗号/顿号/半角
    expect(fw.nodes[1]).toMatchObject({
      index: 2,
      phase: "起",
      title: "节点 2",
      involvedCharacters: ["张三", "李四", "王五", "赵六"],
      goal: "正面",
    })
    // 只有「节点 1 【起】」→ 三个标题兜底分支全部走到
    expect(fw.nodes[2]).toMatchObject({
      index: 1,
      phase: "起",
      title: "未命名节点",
    })
  })

  it("frontmatter 值为数组时按「, 」拼接；空数组短标题降级为 undefined", async () => {
    fsState.files.set(
      `${FRAMEWORKS_DIR}/raw-b.md`,
      ["---", 'title: ["数组", "标题"]', "shortTitle: []", "---", "", "无章节正文"].join("\n"),
    )

    const [fw] = await loadFrameworks(PROJECT)
    expect(fw.title).toBe("数组, 标题")
    expect(fw.shortTitle).toBeUndefined()
    // 无「前提」/「故事节点」章节 → 空前提 + 空节点
    expect(fw.premise).toBe("")
    expect(fw.nodes).toEqual([])
  })

  it("文件名退化为空（.md）时生成合成 id", async () => {
    fsState.files.set(`${FRAMEWORKS_DIR}/.md`, "无 frontmatter 的正文")

    const [fw] = await loadFrameworks(PROJECT)
    expect(fw.id).toMatch(/^fw-\d+$/)
    expect(fw.title).toBe("未命名框架")
  })
})

describe("deleteFramework", () => {
  it("删除框架文件与全部关联推演结果（目录项跳过）", async () => {
    await saveFramework(PROJECT, makeFramework({ id: "fw-1" }))
    const [resultA, resultB] = await withMonotonicClock(async () => [
      await saveSimulationResult(PROJECT, "fw-1", makeReport()),
      await saveSimulationResult(
        PROJECT,
        "fw-1",
        makeReport({ createdAt: "2026-09-03T00:00:00.000Z" }),
      ),
    ])
    // 结果目录下的子目录不应触发删除
    fsState.dirs.add(`${RESULTS_DIR}/fw-1/nested`)

    expect(resultA).not.toBe(resultB)
    expect(fsState.files.has(`${FRAMEWORKS_DIR}/fw-1.md`)).toBe(true)

    await deleteFramework(PROJECT, "fw-1")

    expect(fsState.files.has(`${FRAMEWORKS_DIR}/fw-1.md`)).toBe(false)
    expect(fsState.files.has(`${RESULTS_DIR}/fw-1/${resultA}.json`)).toBe(false)
    expect(fsState.files.has(`${RESULTS_DIR}/fw-1/${resultA}.md`)).toBe(false)
    expect(fsState.files.has(`${RESULTS_DIR}/fw-1/${resultB}.json`)).toBe(false)
  })

  it("框架与结果目录都不存在时静默成功（幂等）", async () => {
    await expect(deleteFramework(PROJECT, "missing")).resolves.toBeUndefined()
  })
})

describe("saveSimulationResult", () => {
  it("写入 JSON 全字段与人类可读 MD（推荐缺失 / 分支推荐标记 / 草稿章节）", async () => {
    const report = makeReport()
    const draft: StoryDraft = {
      branchId: "branch-1",
      frameworkId: "fw-1",
      chapters: [{ title: "第一章", content: "正文", correspondingNode: 1 }],
      totalWords: 120,
      createdAt: "2026-09-02T01:00:00.000Z",
    }
    const timelineEvents: TimelineEvent[] = [
      {
        id: "e1",
        round: 1,
        nodeIndex: 1,
        actorId: "c1",
        actorName: "张三",
        actionType: "observe",
        content: "观察四周",
        observableBy: ["c1"],
        impacts: [],
        timestamp: "2026-09-02T02:00:00.000Z",
      },
    ]
    const snapshot: SerializedSimulationSnapshot = {
      agents: [],
      state: { currentRound: 1, timelineEvents: [], activeAgents: {}, worldState: {} },
    }
    const rumors: RumorEvent[] = [
      {
        id: "r1",
        round: 1,
        nodeIndex: 1,
        sourceId: null,
        content: "传闻",
        distortion: 0.2,
        observableBy: ["c1"],
        believedBy: ["c1"],
        verifiedBy: [],
        timestamp: "2026-09-02T03:00:00.000Z",
        generation: 0,
      },
    ]
    const debugTraces: SimulationDebugTrace[] = [
      {
        id: "t1",
        type: "round-plan",
        nodeIndex: 1,
        nodeTitle: "雪夜入门",
        round: 1,
        candidateAgents: [],
        selectedAgents: [],
        blackboard: {
          allAgentCount: 1,
          activeAgentCount: 1,
          totalEventCount: 1,
          publicEventCount: 1,
          rumorCount: 0,
        },
        visibilityByAgent: [],
        rumors: [],
        activeAgents: new Map(),
        timestamp: "2026-09-02T04:00:00.000Z",
      },
    ]
    const resume: SimulationResumePoint = { nextNodeIndex: 2, nextRound: 3, timelineEvents: [] }

    const resultId = await saveSimulationResult(
      PROJECT,
      "fw-1",
      report,
      draft,
      timelineEvents,
      snapshot,
      rumors,
      debugTraces,
      { status: "partial", partialReason: "模型中断", resume },
    )

    expect(resultId).toMatch(/^result-\d+$/)
    expect(fsState.dirs.has(`${RESULTS_DIR}/fw-1`)).toBe(true)

    const json = JSON.parse(fsState.files.get(`${RESULTS_DIR}/fw-1/${resultId}.json`)!)
    expect(json.report).toEqual(report)
    expect(json.draft).toEqual(draft)
    expect(json.timelineEvents).toEqual(timelineEvents)
    expect(json.agentSnapshot).toEqual(snapshot)
    expect(json.rumors).toEqual(rumors)
    expect(json.debugTraces[0].id).toBe("t1")
    expect(json.status).toBe("partial")
    expect(json.partialReason).toBe("模型中断")
    expect(json.resume).toEqual(resume)

    const md = fsState.files.get(`${RESULTS_DIR}/fw-1/${resultId}.md`)!
    expect(md).toContain("# 推演结果")
    expect(md).toContain("- 框架ID：fw-1")
    expect(md).toContain("- 仿真模式：hybrid")
    // report.recommendation 为空 → 占位
    expect(md).toContain("（无推荐）")
    expect(md).toContain("### 分支甲")
    expect(md).toContain("- 概率：high")
    // 仅 recommendation=true 的分支带「推荐：是」
    expect(md.match(/- 推荐：是/g)).toHaveLength(1)
    expect(md).toContain("### 张三")
    expect(md).toContain("- 一致性评分：0.82")
    expect(md).toContain("## 草稿")
    expect(md).toContain("- 总字数：120")
    expect(md).toContain("### 第一章（对应节点 1）")

    // 读回：结构化字段（status / partialReason / resume / draft / snapshot）不被降级
    const [reread] = await loadSimulationResults(PROJECT, "fw-1")
    expect(reread.id).toBe(resultId)
    expect(reread.report).toEqual(report)
    expect(reread.draft).toEqual(draft)
    expect(reread.timelineEvents).toEqual(timelineEvents)
    expect(reread.agentSnapshot).toEqual(snapshot)
    expect(reread.rumors).toEqual(rumors)
    expect(reread.debugTraces?.[0].id).toBe("t1")
    expect(reread.status).toBe("partial")
    expect(reread.partialReason).toBe("模型中断")
    expect(reread.resume).toEqual(resume)
  })

  it("可选参数全部缺省 → JSON 用 null / [] / complete，MD 不含草稿段", async () => {
    const resultId = await saveSimulationResult(
      PROJECT,
      "fw-1",
      makeReport({ recommendation: "走分支甲" }),
    )

    const json = JSON.parse(fsState.files.get(`${RESULTS_DIR}/fw-1/${resultId}.json`)!)
    expect(json.draft).toBeNull()
    expect(json.timelineEvents).toEqual([])
    expect(json.agentSnapshot).toBeNull()
    expect(json.rumors).toEqual([])
    expect(json.debugTraces).toEqual([])
    expect(json.status).toBe("complete")
    expect(json.partialReason).toBeNull()
    expect(json.resume).toBeNull()

    const md = fsState.files.get(`${RESULTS_DIR}/fw-1/${resultId}.md`)!
    expect(md).not.toContain("## 草稿")
    expect(md).toContain("走分支甲")
  })
})

describe("loadSimulationResults", () => {
  it("按 report.createdAt 降序返回，并归一化缺省字段", async () => {
    const [march, february, april] = await withMonotonicClock(async () => [
      await saveSimulationResult(
        PROJECT,
        "fw-1",
        makeReport({ createdAt: "2026-03-01T00:00:00.000Z" }),
      ),
      await saveSimulationResult(
        PROJECT,
        "fw-1",
        makeReport({ createdAt: "2026-02-01T00:00:00.000Z" }),
      ),
      await saveSimulationResult(
        PROJECT,
        "fw-1",
        makeReport({ createdAt: "2026-04-01T00:00:00.000Z" }),
      ),
    ])

    const loaded = await loadSimulationResults(PROJECT, "fw-1")

    expect(loaded.map((r) => r.id)).toEqual([april, march, february])
    expect(loaded[0].status).toBe("complete")
    expect(loaded[0].draft).toBeNull()
    expect(loaded[0].agentSnapshot).toBeNull()
    expect(loaded[0].timelineEvents).toEqual([])
    expect(loaded[0].rumors).toEqual([])
    expect(loaded[0].debugTraces).toEqual([])
    expect(loaded[0].partialReason).toBeNull()
    expect(loaded[0].resume).toBeNull()
  })

  it("report.createdAt 相同时顺序稳定（比较结果 0）", async () => {
    const ids = await withMonotonicClock(async () => [
      await saveSimulationResult(PROJECT, "fw-1", makeReport()),
      await saveSimulationResult(PROJECT, "fw-1", makeReport()),
    ])

    const loaded = await loadSimulationResults(PROJECT, "fw-1")
    expect(loaded.map((r) => r.id)).toEqual(ids)
  })

  it("跳过非 .json / 损坏 JSON / 无 report 的载荷 / 子目录", async () => {
    const ok = await saveSimulationResult(PROJECT, "fw-1", makeReport())
    const dir = `${RESULTS_DIR}/fw-1`
    fsState.files.set(`${dir}/broken.json`, "{ 不是 JSON")
    fsState.files.set(`${dir}/no-report.json`, '{"other":1}')
    fsState.files.set(`${dir}/null.json`, "null")
    fsState.files.set(`${dir}/readme.md`, "说明")
    fsState.dirs.add(`${dir}/nested`)

    const loaded = await loadSimulationResults(PROJECT, "fw-1")

    expect(loaded.map((r) => r.id)).toEqual([ok])
  })

  it("结果目录不存在 → 空数组", async () => {
    expect(await loadSimulationResults(PROJECT, "fw-404")).toEqual([])
  })

  it("缺字段 JSON 载荷 → 缺省字段归一化（timelineEvents / rumors / debugTraces / status 走 ?? 兜底）", async () => {
    const report = makeReport()
    // 手工构造最小载荷：只有 report，其余字段全部缺失（saveSimulationResult
    // 总是显式写入这些字段，所以只有外部手写 JSON 能走到 ?? 右侧兜底分支）
    fsState.files.set(`${RESULTS_DIR}/fw-1/minimal.json`, JSON.stringify({ report }))

    const loaded = await loadSimulationResults(PROJECT, "fw-1")

    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe("minimal")
    expect(loaded[0].report).toEqual(report)
    expect(loaded[0].draft).toBeNull()
    expect(loaded[0].timelineEvents).toEqual([])
    expect(loaded[0].agentSnapshot).toBeNull()
    expect(loaded[0].rumors).toEqual([])
    expect(loaded[0].debugTraces).toEqual([])
    expect(loaded[0].status).toBe("complete")
    expect(loaded[0].partialReason).toBeNull()
    expect(loaded[0].resume).toBeNull()
  })
})

describe("deleteSimulationResult", () => {
  it("删除 JSON 与 MD 两份文件", async () => {
    const resultId = await saveSimulationResult(PROJECT, "fw-1", makeReport())
    const dir = `${RESULTS_DIR}/fw-1`

    await deleteSimulationResult(PROJECT, "fw-1", resultId)

    expect(fsState.files.has(`${dir}/${resultId}.json`)).toBe(false)
    expect(fsState.files.has(`${dir}/${resultId}.md`)).toBe(false)
  })

  it("两份文件都不存在时静默成功（幂等）", async () => {
    await expect(
      deleteSimulationResult(PROJECT, "fw-1", "result-missing"),
    ).resolves.toBeUndefined()
  })
})
