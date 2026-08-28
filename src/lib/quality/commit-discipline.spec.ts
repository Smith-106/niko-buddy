/**
 * commit-discipline.spec.ts — v2.6.7 D4 验收
 *
 * 覆盖：单章闭环粒度 / 跨章批量拒绝 / 正文记忆成对
 */
import { describe, expect, it } from "vitest"
import { checkCommitDiscipline, type CommitScope } from "./commit-discipline"

const singleChapter: CommitScope = {
  chapterIds: ["ch1"],
  touchesStatusJson: true,
  touchesCanonicalContent: true,
  touchesCanonicalMemory: true,
}

describe("D4 原子提交纪律 — 单章 Draft-first 闭环", () => {
  it("单章闭环合规（正文+记忆成对）", () => {
    const r = checkCommitDiscipline(singleChapter)
    expect(r.ok).toBe(true)
    expect(r.reasons).toHaveLength(0)
  })

  it("跨章批量拒绝（禁跨章提交）", () => {
    const r = checkCommitDiscipline({ ...singleChapter, chapterIds: ["ch1", "ch2"] })
    expect(r.ok).toBe(false)
    expect(r.reasons.join("; ")).toContain("禁跨章批量提交")
  })

  it("status.json 更新必须对应单章", () => {
    const r = checkCommitDiscipline({ ...singleChapter, chapterIds: ["ch1", "ch2"] })
    expect(r.reasons.join("; ")).toContain("status.json 更新必须对应单章闭环")
  })

  it("正文/记忆回填必须成对（防中间态）", () => {
    const r = checkCommitDiscipline({ ...singleChapter, touchesCanonicalMemory: false })
    expect(r.ok).toBe(false)
    expect(r.reasons.join("; ")).toContain("正式正文与正式记忆回填必须成对")
  })

  it("无章节声明拒绝", () => {
    const r = checkCommitDiscipline({ ...singleChapter, chapterIds: [] })
    expect(r.ok).toBe(false)
    expect(r.reasons.join("; ")).toContain("提交必须声明涉及章节")
  })
})
