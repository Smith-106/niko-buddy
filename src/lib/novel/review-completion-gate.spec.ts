import { describe, expect, it } from "vitest"
import {
  checkReviewCompletionGate,
  computeChapterHash,
  countLocatedFindings,
} from "./review-completion-gate"

const located = (evidence: string, severity = "warning") => ({ severity, message: "m", evidence })
const BODY = "第一章 雨夜。他推开门，锈钥匙掉在地上。第二章 清晨。她捡起钥匙，钥匙锈迹斑斑。第三章 午间。清晨的光照进屋子。"

describe("53 P1-3 review-completion-gate (critic 防伪完成门)", () => {
  it("countLocatedFindings: 定位证据 (数字位置 + ≥10 字符原文引用) 才计数", () => {
    const ev = "第2段：他推开门，锈钥匙掉在地上。" // 有数字 + 正文引用
    expect(countLocatedFindings([located(ev)], BODY)).toBe(1)
    // 无数字定位 → 0
    expect(countLocatedFindings([located("他推开门，锈钥匙掉在地上。")], BODY)).toBe(0)
    // 证据过短 (<10) → 0
    expect(countLocatedFindings([located("短证据")], BODY)).toBe(0)
  })

  it("≥3 定位发现 → passed", () => {
    const r = checkReviewCompletionGate({
      chapterHash: "h1",
      results: [
        located("第1段：他推开门，锈钥匙掉在地上。"),
        located("第2段：她捡起钥匙，钥匙锈迹斑斑。"),
        located("第3段：第三章午间。清晨的光照进屋子。"),
      ],
      chapterBody: BODY,
    })
    expect(r.passed).toBe(true)
    expect(r.locatedFindings).toBeGreaterThanOrEqual(3)
  })

  it("2 条定位发现 → INSUFFICIENT_FINDINGS (含 issue)", () => {
    const r = checkReviewCompletionGate({
      chapterHash: "h1",
      results: [
        located("第1段：他推开门，锈钥匙掉在地上。"),
        located("第2段：她捡起钥匙，钥匙锈迹斑斑。"),
      ],
      chapterBody: BODY,
    })
    expect(r.passed).toBe(false)
    expect(r.failures).toContain("INSUFFICIENT_FINDINGS")
  })

  it("全 pass 断言 + 0 定位发现 → HOLLOW_PASS (空 PASS 自夸失败)", () => {
    const r = checkReviewCompletionGate({
      chapterHash: "h1",
      results: [{ severity: "info", message: "全部通过", evidence: "" }],
      chapterBody: BODY,
    })
    expect(r.passed).toBe(false)
    expect(r.failures).toContain("HOLLOW_PASS")
  })

  it("chapterHash 不匹配 → STALE_ARTIFACT (章被改旧审查作废)", () => {
    const r = checkReviewCompletionGate({
      chapterHash: "new-hash",
      boundChapterHash: "old-hash",
      results: [
        located("第1段：他推开门，锈钥匙掉在地上。"),
        located("第2段：她捡起钥匙，钥匙锈迹斑斑。"),
        located("第3段：第三章午间。清晨的光照进屋子。"),
      ],
      chapterBody: BODY,
    })
    expect(r.passed).toBe(false)
    expect(r.failures).toContain("STALE_ARTIFACT")
  })

  it("真干净章节豁免: cleanExemption + 全 pass → 不判 HOLLOW_PASS", () => {
    const r = checkReviewCompletionGate({
      chapterHash: "h1",
      results: [{ severity: "info", message: "无问题", evidence: "" }],
      chapterBody: BODY,
      cleanExemption: true,
    })
    expect(r.passed).toBe(true)
  })

  it("computeChapterHash 与 checkpoint-digest 同源 (SHA-256 hex)", async () => {
    const h = await computeChapterHash("某章节内容")
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })
})
