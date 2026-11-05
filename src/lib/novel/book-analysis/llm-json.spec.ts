import { describe, expect, it } from "vitest"
import {
  extractJsonArrayCandidate,
  extractJsonObjectCandidate,
  isLlmRecord,
  llmStringField,
  parseLlmJsonArray,
  parseLlmJsonObject,
} from "./llm-json"

describe("llm-json", () => {
  it("提取 fence 内配平的 JSON object", () => {
    const raw = '说明如下：\n```json\n{"name":"顾司玥","description":"女主"}\n```\n完'
    expect(extractJsonObjectCandidate(raw)).toBe('{"name":"顾司玥","description":"女主"}')
  })

  it("用 jsonrepair 解析含裸换行的角色详情输出", () => {
    const raw = `
模型分析：
\`\`\`json
{
  "name": "顾司玥",
  "aliases": [],
  "category": "protagonist",
  "description": "外貌清冷
出身神秘",
  "personality": "克制",
  "motivation": "查明真相",
  "goals": ["活下去"],
  "fears": ["被抛弃"],
  "growthArc": "从疏离到信任",
  "behaviorPatterns": "先观察后行动",
  "speechStyle": "短句",
  "relationships": [],
  "keyEvents": [],
  "representativeQuotes": [
    {
      "chapterId": "ch-0001",
      "text": "她低声道：
“别跟着我。”"
    }
  ]
}
\`\`\`
`
    const parsed = parseLlmJsonObject(raw)
    expect(parsed).not.toBeNull()
    expect(parsed?.name).toBe("顾司玥")
    expect(String(parsed?.description)).toContain("外貌清冷")
    expect(Array.isArray(parsed?.representativeQuotes)).toBe(true)
  })

  it("用 jsonrepair 消化截断输出", () => {
    const raw = '{"name":"顾司玥","personality":"冷静且'
    const parsed = parseLlmJsonObject(raw)
    expect(parsed?.name).toBe("顾司玥")
    expect(String(parsed?.personality)).toContain("冷静")
  })
})

describe("W1 补强：isLlmRecord / llmStringField 类型谓词", () => {
  it("isLlmRecord 区分对象与数组/null/原始值", () => {
    expect(isLlmRecord({ a: 1 })).toBe(true)
    expect(isLlmRecord({})).toBe(true)
    expect(isLlmRecord([1])).toBe(false)
    expect(isLlmRecord(null)).toBe(false)
    expect(isLlmRecord("s")).toBe(false)
    expect(isLlmRecord(42)).toBe(false)
    expect(isLlmRecord(undefined)).toBe(false)
  })

  it("llmStringField 仅返回 string 字段，其余一律 undefined", () => {
    expect(llmStringField({ name: "顾司玥" }, "name")).toBe("顾司玥")
    expect(llmStringField({ name: 42 }, "name")).toBeUndefined()
    expect(llmStringField({ name: null }, "name")).toBeUndefined()
    expect(llmStringField({}, "name")).toBeUndefined()
  })
})

describe("W1 补强：extractJsonObjectCandidate 转义与截断", () => {
  it("尊重字符串内转义引号与括号（转义分支）", () => {
    const raw = 'prefix {"a": "x\\"y}z", "b": 1} suffix'
    expect(extractJsonObjectCandidate(raw)).toBe('{"a": "x\\"y}z", "b": 1}')
  })

  it("无花括号返回 null", () => {
    expect(extractJsonObjectCandidate("纯文本无括号")).toBeNull()
  })

  it("parseLlmJsonObject jsonrepair 亦无法修复时返回 null（控制字符）", () => {
    expect(parseLlmJsonObject('{"a": "' + String.fromCharCode(1) + '"}')).toBeNull()
  })
})

describe("W1 补强：extractJsonArrayCandidate / parseLlmJsonArray 全链路", () => {
  it("无方括号返回 null", () => {
    expect(extractJsonArrayCandidate("纯文本无括号")).toBeNull()
  })

  it("提取 fence 内配平的 JSON array", () => {
    const raw = '说明：\n```json\n[{"a":1},{"b":2}]\n```\n完'
    expect(extractJsonArrayCandidate(raw)).toBe('[{"a":1},{"b":2}]')
  })

  it("尊重字符串内转义与括号（转义分支）", () => {
    const raw = 'x ["a\\"b]c", 1] y'
    expect(extractJsonArrayCandidate(raw)).toBe('["a\\"b]c", 1]')
  })

  it("字符串内右括号不闭合数组（inString 跳过分支）", () => {
    expect(extractJsonArrayCandidate('x ["a]b", 1] y')).toBe('["a]b", 1]')
  })

  it("截断时返回从 [ 到末尾", () => {
    expect(extractJsonArrayCandidate("前言 [1, 2,")).toBe("[1, 2,")
  })

  it("parseLlmJsonArray 直接解析与 fence 解析", () => {
    expect(parseLlmJsonArray('[{"a":1}]')).toEqual([{ a: 1 }])
    expect(parseLlmJsonArray('结果：\n```json\n[1, 2, 3]\n```')).toEqual([1, 2, 3])
  })

  it("parseLlmJsonArray 无候选返回 null；尾逗号经 jsonrepair 修复", () => {
    expect(parseLlmJsonArray("没有括号")).toBeNull()
    expect(parseLlmJsonArray("[1, 2,]")).toEqual([1, 2])
  })

  it("parseLlmJsonArray 解析失败且 jsonrepair 亦失败时返回 null", () => {
    expect(parseLlmJsonArray('["' + String.fromCharCode(1) + '"]')).toBeNull()
  })

  it("parseLlmJsonArray 候选解析为非数组时经修复或返回 null", () => {
    // "[1," 非法 → tryParseArray fallthrough；jsonrepair 补全为 [1]
    expect(parseLlmJsonArray("[1,")).toEqual([1])
  })
})
