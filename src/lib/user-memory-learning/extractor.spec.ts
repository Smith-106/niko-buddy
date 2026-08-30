import { describe, expect, it } from "vitest"
import {
  buildUserMemoryExtractionPrompt,
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
