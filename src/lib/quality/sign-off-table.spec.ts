/**
 * sign-off-table.spec.ts — v2.6.10 D6 验收
 *
 * 覆盖：结论摘要≥50 字 / 异议栏 / 签字表齐全
 */
import { describe, expect, it } from "vitest"
import {
  CONCLUSION_MIN_LEN,
  evidenceRelevance,
  validateSignOff,
  verifySignOffTable,
  type SignOffEntry,
} from "./sign-off-table"

const validEntry: SignOffEntry = {
  editorId: "e1",
  role: "structure",
  sampleBand: "top10",
  conclusion: "本章结构完整，伏笔回收自然，节奏控制得当，人物动机交代清楚，建议保留当前处理方式并继续观察后续章节的呼应效果。",
  objection: "none",
  evidenceQuote: "本章伏笔回收自然，结构完整，节奏得当",
  ts: "2026-08-28T00:00:00.000Z",
}

describe("D6 签字表 — 防只签不评", () => {
  it("结论摘要≥50 字 + 异议栏 → 通过", () => {
    expect(validateSignOff(validEntry).ok).toBe(true)
  })

  it("结论摘要<50 字拒绝（防只签不评）", () => {
    const r = validateSignOff({ ...validEntry, conclusion: "好" })
    expect(r.ok).toBe(false)
    expect(r.reasons.join("; ")).toContain("结论摘要不足")
    expect(CONCLUSION_MIN_LEN).toBe(50)
  })

  it("异议栏未填拒绝", () => {
    const r = validateSignOff({ ...validEntry, objection: "" })
    expect(r.ok).toBe(false)
    expect(r.reasons.join("; ")).toContain("异议栏必填")
  })

  it("引用与结论不相关拒绝（防拷贝无关原文——蓄意形式化签字）", () => {
    const r = validateSignOff({ ...validEntry, evidenceQuote: "他今天去集市买了菜，顺便看了场戏" })
    expect(r.ok).toBe(false)
    expect(r.reasons.join("; ")).toContain("引用与结论不相关")
  })

  it("引用相关性：相关引用通过", () => {
    expect(evidenceRelevance("本章伏笔回收自然，结构完整", "本章结构完整，伏笔回收自然")).toBe(true)
  })
})

describe("D6 签字表 — 齐全校验", () => {
  it("top/bottom 各至少 1 条有效签字 → 齐全", () => {
    const r = verifySignOffTable([
      validEntry,
      { ...validEntry, sampleBand: "bottom10", evidenceQuote: "本章结尾略显仓促，过渡段落需补充，衔接需自然", conclusion: "本章结尾处理略显仓促，建议补充过渡段落以平滑收束，同时注意与下一章开头的衔接是否自然流畅，并检查人物情绪铺垫是否足够支撑后续转折。" },
    ])
    expect(r.complete).toBe(true)
  })

  it("缺 bottom10 签字 → 不齐全", () => {
    const r = verifySignOffTable([validEntry])
    expect(r.complete).toBe(false)
    expect(r.missing).toContain("缺 bottom10 签字")
  })
})
