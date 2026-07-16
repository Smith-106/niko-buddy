import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  detectRegression,
  scoreCandidate,
  selectBestCandidate,
  SLOP_REGRESSION_THRESHOLD,
  type CandidateVersion,
} from "./candidate-selector"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

function mkCandidate(content: string, retryCount: number): CandidateVersion {
  return { content, slopPenalty: scoreCandidate(content), retryCount }
}

describe("A19 借鉴点 #4 fix-loop 候选退化检测 (零 LLM 机械分, 复用 #1 slopScore)", () => {
  it("uses zero LLM calls (A19 硬验证: 无 streamChat/llm-client import 或 await invoke)", () => {
    const src = readSource("candidate-selector.ts")
    expect(src).not.toMatch(/from\s+["']@\/lib\/llm-client["']/)
    expect(src).not.toMatch(/await\s+streamChat\b/)
    expect(src).not.toMatch(/\bawait\s+invoke\b/)
  })

  it("scoreCandidate returns low penalty for clean prose, high for slop (复用 #1 slopScore)", () => {
    const clean = "他推开门，风灌了进来，凉意贴着脚踝。桌上的茶还温着，他没动。"
    const slop = "显然事实上这一切似乎仿佛。目光交汇的瞬间空气凝固心中五味杂陈。然而但是不过。眼神变得坚定。时间一分一秒过去。他既聪明又勤奋。"
    expect(scoreCandidate(clean)).toBeLessThan(scoreCandidate(slop))
    expect(scoreCandidate(slop)).toBeGreaterThanOrEqual(8)
  })

  it("detectRegression returns regressed=false when curr slop <= prev + threshold (正常迭代/改进)", () => {
    const prev = mkCandidate("clean prose", 0)
    const curr = mkCandidate("clean prose v2", 1)
    // 同等或改进 → 不退化
    const result = detectRegression(prev, curr)
    expect(result.regressed).toBe(false)
    expect(result.keep).toBe(curr)
    expect(result.reason).toBe("")
  })

  it("detectRegression returns regressed=true + keep=prev when curr slop > prev + threshold (退化回退)", () => {
    // 构造退化: prev clean (slop 0), curr heavy slop (slop 10)
    const prev: CandidateVersion = { content: "clean", slopPenalty: 0, retryCount: 0 }
    const curr: CandidateVersion = { content: "slop", slopPenalty: 10, retryCount: 1 }
    const result = detectRegression(prev, curr, SLOP_REGRESSION_THRESHOLD)
    expect(result.regressed).toBe(true)
    expect(result.keep).toBe(prev) // 回退前版
    expect(result.reason).toContain("返修退化")
    expect(result.reason).toContain("回退前版")
  })

  it("detectRegression boundary: curr = prev + threshold exactly → NOT regressed (用 > 非 >=)", () => {
    // 边界: curr.slop = prev.slop + threshold (恰好等于), 用 > 不判退化
    const prev: CandidateVersion = { content: "p", slopPenalty: 4, retryCount: 0 }
    const curr: CandidateVersion = { content: "c", slopPenalty: 4 + SLOP_REGRESSION_THRESHOLD, retryCount: 1 }
    const result = detectRegression(prev, curr, SLOP_REGRESSION_THRESHOLD)
    expect(result.regressed).toBe(false)
    expect(result.keep).toBe(curr)
  })

  it("detectRegression boundary: curr = prev + threshold + 0.1 → regressed (刚超阈值)", () => {
    const prev: CandidateVersion = { content: "p", slopPenalty: 4, retryCount: 0 }
    const curr: CandidateVersion = { content: "c", slopPenalty: 4 + SLOP_REGRESSION_THRESHOLD + 0.1, retryCount: 1 }
    const result = detectRegression(prev, curr, SLOP_REGRESSION_THRESHOLD)
    expect(result.regressed).toBe(true)
    expect(result.keep).toBe(prev)
  })

  it("detectRegression uses default threshold SLOP_REGRESSION_THRESHOLD=2 when omitted", () => {
    // prev slop 4, curr slop 7 → 7 > 4+2=6 → 退化 (用默认 threshold)
    const prev: CandidateVersion = { content: "p", slopPenalty: 4, retryCount: 0 }
    const curr: CandidateVersion = { content: "c", slopPenalty: 7, retryCount: 1 }
    const result = detectRegression(prev, curr) // 不传 threshold, 用默认
    expect(result.regressed).toBe(true)
  })

  it("selectBestCandidate returns null for empty list", () => {
    expect(selectBestCandidate([])).toBeNull()
  })

  it("selectBestCandidate picks lowest slopPenalty (机械分最低优先, DD-2)", () => {
    const a: CandidateVersion = { content: "a", slopPenalty: 8, retryCount: 0 }
    const b: CandidateVersion = { content: "b", slopPenalty: 3, retryCount: 1 }
    const c: CandidateVersion = { content: "c", slopPenalty: 6, retryCount: 2 }
    expect(selectBestCandidate([a, b, c])).toBe(b) // slop 最低
  })

  it("selectBestCandidate ties broken by lowest retryCount (优先早期版本, DD-2)", () => {
    // 同 slop 分, 选 retryCount 最小 (早期)
    const late: CandidateVersion = { content: "late", slopPenalty: 5, retryCount: 3 }
    const early: CandidateVersion = { content: "early", slopPenalty: 5, retryCount: 1 }
    const mid: CandidateVersion = { content: "mid", slopPenalty: 5, retryCount: 2 }
    expect(selectBestCandidate([late, early, mid])).toBe(early)
  })

  it("selectBestCandidate returns single candidate as-is", () => {
    const only: CandidateVersion = { content: "only", slopPenalty: 7, retryCount: 0 }
    expect(selectBestCandidate([only])).toBe(only)
  })
})
