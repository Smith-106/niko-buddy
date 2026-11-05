/**
 * report-export 真实行为测试（原位重写 C4 空壳）。
 * 覆盖：完整报告各章节渲染 / 最小报告省略分支 / 文件名清洗与时间戳 /
 * 概率与动作标签映射（含未知透传）/ 时间线分组排序与缺失节点 / 文件写入 mock。
 * 文件写入一律 mock，不触碰真实文件系统。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDirectory, writeFileAtomic } from "@/commands/fs"
import type {
  AgentActionType,
  SimulationReport,
  StoryFramework,
  TimelineEvent,
} from "./types"
import { exportReport } from "./report-export"

vi.mock("@/commands/fs", () => ({
  createDirectory: vi.fn(async () => undefined),
  writeFileAtomic: vi.fn(async () => undefined),
}))

const mockedMkdir = vi.mocked(createDirectory)
const mockedWrite = vi.mocked(writeFileAtomic)

function framework(overrides: Partial<StoryFramework> = {}): StoryFramework {
  return {
    id: "fw-1",
    title: "测试框架长标题内容",
    premise: "一个关于勇气的故事",
    targetWords: 10000,
    simulationMode: "hybrid",
    sourceChapters: 2,
    nodes: [
      {
        index: 0,
        phase: "起",
        title: "开端",
        coreConflict: "冲突",
        involvedCharacters: ["阿明"],
        goal: "立人",
        causeFromPrev: "",
        expectedOutcome: "出发",
      },
      {
        index: 1,
        phase: "承",
        title: "转折",
        coreConflict: "冲突2",
        involvedCharacters: [],
        goal: "转折",
        causeFromPrev: "",
        expectedOutcome: "抉择",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function report(overrides: Partial<SimulationReport> = {}): SimulationReport {
  return {
    frameworkId: "fw-1",
    mode: "hybrid",
    characterAnalyses: [
      {
        characterId: "c-aming",
        name: "阿明",
        behaviors: [{ node: "开端", action: "拔剑", motivation: "守护" }],
        stateChanges: ["从胆怯到坚定"],
        consistencyScore: 88,
      },
    ],
    branches: [
      {
        title: "勇者之路",
        summary: "迎难而上",
        keyEvents: ["拔剑", "欢呼"],
        probability: "high",
        pros: "燃",
        cons: "险",
        recommendation: true,
      },
      {
        title: "隐退之线",
        summary: "急流勇退",
        keyEvents: [],
        probability: "medium",
        pros: "",
        cons: "",
        recommendation: false,
      },
      {
        title: "未知之线",
        summary: "难以评估",
        keyEvents: [],
        probability: "low",
        pros: "",
        cons: "",
        recommendation: false,
      },
    ],
    recommendation: "建议走勇者线",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function timelineEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "ev-1",
    round: 0,
    nodeIndex: 0,
    actorId: "c-aming",
    actorName: "阿明",
    actionType: "speak",
    content: "我来断后！",
    observableBy: ["c-aming"],
    impacts: [],
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function writtenContent(): string {
  expect(mockedWrite).toHaveBeenCalledTimes(1)
  return String(mockedWrite.mock.calls[0]?.[1] ?? "")
}

function writtenPath(): string {
  return String(mockedWrite.mock.calls[0]?.[0] ?? "")
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("exportReport 完整报告", () => {
  it("渲染全部章节并返回清洗后的文件路径", async () => {
    const filePath = await exportReport(
      "C:\\proj",
      framework({ shortTitle: "短标题" }),
      report(),
      [
        timelineEvent({ id: "ev-b", nodeIndex: 1, round: 1, actionType: "confront", targetName: "阿红", content: "对峙！" }),
        timelineEvent({}),
      ],
    )

    expect(mockedMkdir).toHaveBeenCalledTimes(1)
    expect(String(mockedMkdir.mock.calls[0]?.[0])).toContain(".niko-buddy/simulations/exports")
    expect(filePath).toContain("推演报告_短标题_")
    expect(filePath.endsWith(".md")).toBe(true)
    // 时间戳中的 : . 已被替换
    expect(filePath).not.toMatch(/:\d\d\./)
    expect(writtenPath()).toBe(filePath)

    const content = writtenContent()
    expect(content).toContain("# 故事推演报告：测试框架长标题内容")
    expect(content).toContain("> 仿真模式：hybrid")
    expect(content).toContain("> 目标字数：10000")
    expect(content).toContain("> 简短标题：短标题")
    expect(content).toContain("## 故事前提")
    expect(content).toContain("一个关于勇气的故事")
    expect(content).toContain("## 综合推荐")
    expect(content).toContain("建议走勇者线")
    // 时间线：按节点排序，动作标签映射，轮次+1，目标箭头
    expect(content).toContain("## 剧情事件时间线")
    const node0 = content.indexOf("### 节点1【起】开端")
    const node1 = content.indexOf("### 节点2【承】转折")
    expect(node0).toBeGreaterThan(-1)
    expect(node1).toBeGreaterThan(node0)
    expect(content).toContain("- **R1** 阿明 对话：我来断后！")
    expect(content).toContain("- **R2** 阿明 对抗 → 阿红：对峙！")
    // 角色分析
    expect(content).toContain("## 角色行为分析")
    expect(content).toContain("### 阿明")
    expect(content).toContain("- 一致性评分：88/100")
    expect(content).toContain("- [开端] 拔剑 — 动机：守护")
    expect(content).toContain("- 从胆怯到坚定")
    // 分支：概率映射 + 推荐标记 + 事件/优劣
    expect(content).toContain("## 故事走向分支")
    expect(content).toContain("### 分支1：勇者之路")
    expect(content).toContain("- 概率：高")
    expect(content).toContain("- **推荐分支**")
    expect(content).toContain("- 摘要：迎难而上")
    expect(content).toContain("  - 拔剑")
    expect(content).toContain("- 优势：燃")
    expect(content).toContain("- 风险：险")
    expect(content).toContain("- 概率：中")
    expect(content).toContain("- 概率：低")
  })

  it("无 shortTitle 时用完整标题命名并清洗非法字符、截断 30 字", async () => {
    const fw = framework({
      shortTitle: undefined,
      title: 'a/b:c*d?e"f<g>h|i长标题超长超长超长超长超长超长超长',
    })
    const filePath = await exportReport("C:\\proj", fw, report())
    // 非法字符全部被替换
    expect(filePath).toMatch(/推演报告_a_b_c_d_e_f_g_h_i/)
    const segments = filePath.split("/")
    const fileName = segments[segments.length - 1] ?? ""
    const titlePart = fileName.replace("推演报告_", "").split(/_\d{4}-/)[0] ?? ""
    expect(titlePart.length).toBeLessThanOrEqual(30)
    expect(writtenContent()).not.toContain("简短标题")
  })

  it("时间线引用缺失节点时 phase/title 回退为空", async () => {
    await exportReport("C:\\proj", framework(), report(), [
      // 刻意构造类型系统不允许的取值，验证导出时对未知 actionType 的回退
      timelineEvent({ nodeIndex: 9, actionType: "mystery-type" as unknown as AgentActionType, content: "异事" }),
    ])
    const content = writtenContent()
    expect(content).toContain("### 节点10【】")
    // 未知动作类型与未知概率透传原文
    expect(content).toContain("mystery-type")
  })

  it("未知概率透传原文", async () => {
    await exportReport(
      "C:\\proj",
      framework(),
      report({
        branches: [
          {
            title: "X",
            summary: "s",
            keyEvents: [],
            probability: "weird" as unknown as "high",
            pros: "",
            cons: "",
            recommendation: false,
          },
        ],
      }),
    )
    const content = writtenContent()
    expect(content).toContain("- 概率：weird")
    expect(content).not.toContain("推荐分支")
    expect(content).not.toContain("关键事件：")
    expect(content).not.toContain("优势：")
    expect(content).not.toContain("风险：")
  })
})

describe("exportReport 最小报告", () => {
  it("空 premise/推荐/时间线/分析/分支时省略对应章节", async () => {
    const filePath = await exportReport(
      "/proj",
      framework({ premise: "" }),
      report({ characterAnalyses: [], branches: [], recommendation: "" }),
    )
    expect(filePath).toContain("推演报告_")
    const content = writtenContent()
    expect(content).toContain("（无）")
    expect(content).not.toContain("## 综合推荐")
    expect(content).not.toContain("## 剧情事件时间线")
    expect(content).not.toContain("## 角色行为分析")
    expect(content).not.toContain("## 故事走向分支")
  })

  it("角色无行为与状态变化时省略子节", async () => {
    await exportReport(
      "/proj",
      framework(),
      report({
        characterAnalyses: [
          { characterId: "c-x", name: "小透明", behaviors: [], stateChanges: [], consistencyScore: 60 },
        ],
      }),
    )
    const content = writtenContent()
    expect(content).toContain("### 小透明")
    expect(content).toContain("- 一致性评分：60/100")
    expect(content).not.toContain("关键行为：")
    expect(content).not.toContain("状态变化：")
  })

  it("空 timelineEvents 数组视为无时间线", async () => {
    await exportReport("/proj", framework(), report(), [])
    expect(writtenContent()).not.toContain("## 剧情事件时间线")
  })
})
