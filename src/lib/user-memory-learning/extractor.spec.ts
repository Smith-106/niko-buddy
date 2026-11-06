import { describe, expect, it, vi } from "vitest"
import {
  buildUserMemoryExtractionPrompt,
  computeUserMessageHash,
  parseUserMemoryExtraction,
} from "./extractor"

describe("user memory extractor", () => {
  it("提取提示明确排除一次性章节参数和敏感信息", () => {
    const prompt = buildUserMemoryExtractionPrompt("根据第1、3、5章生成后面四章")

    expect(prompt).toContain("不要保存具体章节号")
    expect(prompt).toContain("密码")
    expect(prompt).toContain("跨任务复用")
  })

  it("解析时过滤包含具体章节号的一次性规则", () => {
    const result = parseUserMemoryExtraction(JSON.stringify({
      memories: [
        {
          rule: "根据第1、3、5章生成后面四章。",
          category: "workflow_preference",
          surfaces: ["chapter-writing"],
          confidence: 0.9,
          evidence_summary: "本次任务参数",
        },
        {
          rule: "续写时重视用户指定章节之间的剧情承接。",
          category: "workflow_preference",
          surfaces: ["chapter-writing"],
          confidence: 0.84,
          evidence_summary: "用户要求参考非连续章节",
        },
      ],
    }))

    expect(result).toHaveLength(1)
    expect(result[0]?.rule).toContain("剧情承接")
  })

  it("过滤包含密钥和密码的候选记忆", () => {
    const result = parseUserMemoryExtraction(JSON.stringify({
      memories: [{
        rule: "用户的 API Key 是 sk-secret123。",
        category: "manual",
        surfaces: ["all"],
        confidence: 1,
        evidence_summary: "用户提供了密钥",
      }],
    }))

    expect(result).toEqual([])
  })

  it("过滤包含邮箱或手机号的候选记忆", () => {
    const result = parseUserMemoryExtraction(JSON.stringify({
      memories: [
        {
          rule: "联系邮箱是 writer@example.com。",
          category: "manual",
          surfaces: ["all"],
          confidence: 1,
          evidence_summary: "用户提供了联系方式",
        },
        {
          rule: "用户手机号是 13800138000。",
          category: "manual",
          surfaces: ["all"],
          confidence: 1,
          evidence_summary: "用户提供了联系方式",
        },
      ],
    }))

    expect(result).toEqual([])
  })

  it("过滤地址、身份、医疗和财务隐私候选", () => {
    const result = parseUserMemoryExtraction(JSON.stringify({ memories: [
      { rule: "用户住址是北京市朝阳区建国路88号。", category: "manual", surfaces: ["all"], confidence: 1, evidence_summary: "家庭住址" },
      { rule: "用户患有糖尿病。", category: "manual", surfaces: ["all"], confidence: 1, evidence_summary: "医疗信息" },
      { rule: "用户月收入是三万元。", category: "manual", surfaces: ["all"], confidence: 1, evidence_summary: "财务信息" },
      { rule: "用户真实姓名是张三。", category: "manual", surfaces: ["all"], confidence: 1, evidence_summary: "身份信息" },
    ] }))

    expect(result).toEqual([])
  })
})

describe("user memory extractor 分支覆盖", () => {
  it("无 JSON 时返回空数组", () => {
    expect(parseUserMemoryExtraction("这里没有 JSON")).toEqual([])
    expect(parseUserMemoryExtraction("}{")).toEqual([])
  })

  it("括号成对但内容不是 JSON → 解析失败回空数组（不抛）", () => {
    // start/end 定位成功 → JSON.parse 抛 → catch 兑空。
    // 缺了这层兜底，模型返回脏输出（截断/注释/尾逗号）会直接冲垮提取链路。
    expect(parseUserMemoryExtraction("{memories: [1,2,]}")).toEqual([])
    expect(parseUserMemoryExtraction("```json\n{ \"memories\": [ }\n```")).toEqual([])
  })

  it("memories 缺失或非数组时返回空数组", () => {
    expect(parseUserMemoryExtraction("{}")).toEqual([])
    expect(parseUserMemoryExtraction(JSON.stringify({ memories: {} }))).toEqual([])
  })

  it("跳过非对象和非法字段的候选", () => {
    const result = parseUserMemoryExtraction(JSON.stringify({
      memories: [
        null,
        "not-an-object",
        42,
        { rule: 123, category: "manual", surfaces: ["all"], confidence: 1, evidence_summary: "x" },
        { rule: "回答时先给结论。", category: "unknown-cat", surfaces: ["all"], confidence: 1, evidence_summary: "x" },
      ],
    }))

    expect(result).toEqual([])
  })

  it("过短或超长的规则会被过滤", () => {
    const result = parseUserMemoryExtraction(JSON.stringify({
      memories: [
        { rule: "太短", category: "manual", surfaces: ["all"], confidence: 1, evidence_summary: "x" },
        { rule: `回答${"啊".repeat(600)}。`, category: "manual", surfaces: ["all"], confidence: 1, evidence_summary: "x" },
      ],
    }))

    expect(result).toEqual([])
  })

  it("缺失 evidence 与 surfaces 时使用默认值", () => {
    const result = parseUserMemoryExtraction(JSON.stringify({
      memories: [{
        rule: "回答时先给结论并保持简洁。",
        category: "interaction_preference",
        evidence_summary: 123,
      }],
    }))

    expect(result).toHaveLength(1)
    expect(result[0]?.evidenceSummary).toBe("")
    expect(result[0]?.surfaces).toEqual(["all"])
    expect(result[0]?.confidence).toBe(0.5)
  })

  it("computeUserMessageHash 对空白归一化且稳定", async () => {
    const a = await computeUserMessageHash("回答时先给结论")
    const b = await computeUserMessageHash("  回答时先给结论  ")
    const c = await computeUserMessageHash("保持简洁")

    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(b).toBe(a)
    expect(c).not.toBe(a)
  })

  it("无 subtle 时回退到 fnv1a 哈希", async () => {
    vi.stubGlobal("crypto", undefined)
    try {
      const hash = await computeUserMessageHash("回答时先给结论")
      expect(hash).toMatch(/^fnv1a:[0-9a-f]{8}$/)
      expect(await computeUserMessageHash("回答时先给结论")).toBe(hash)
      expect(await computeUserMessageHash("保持简洁")).not.toBe(hash)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("subtle 缺失时回退到 fnv1a 哈希", async () => {
    vi.stubGlobal("crypto", {})
    try {
      const hash = await computeUserMessageHash("回答时先给结论")
      expect(hash).toMatch(/^fnv1a:[0-9a-f]{8}$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
