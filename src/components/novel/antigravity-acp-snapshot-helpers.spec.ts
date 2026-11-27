// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest"
import { extractSnapshotJsonCandidate } from "./antigravity-acp-snapshot-helpers"

describe("extractSnapshotJsonCandidate", () => {
  it("extracts a valid fenced JSON ChapterSnapshot block with positive integer chapterNumber and detectedFields", () => {
    const reply = [
      "已读取第 3 章，结构化快照如下：",
      "```json",
      JSON.stringify(
        {
          chapterId: "chapter-3",
          chapterNumber: 3,
          summary: "林川夜探旧库房并发现暗账。",
          characters: ["林川", "沈砚"],
          newCanonFacts: ["旧库房地下藏有十年前的盐引记录"],
          foreshadowingChanges: ["新增伏笔：朱砂印-暗账末尾留有朱砂印"],
        },
        null,
        2,
      ),
      "```",
    ].join("\n")

    const candidate = extractSnapshotJsonCandidate(reply)
    expect(candidate).not.toBeNull()
    expect(candidate?.chapterNumber).toBe(3)
    expect(candidate?.detectedFields).toEqual(
      expect.arrayContaining([
        "chapterId",
        "chapterNumber",
        "summary",
        "characters",
        "newCanonFacts",
        "foreshadowingChanges",
      ]),
    )
    expect(JSON.parse(candidate!.rawJson)).toMatchObject({
      chapterNumber: 3,
      summary: "林川夜探旧库房并发现暗账。",
    })
  })

  it("supports snake_case chapter_number and string integers, while rejecting duplicate chapterNumber/chapter_number alone", () => {
    const snakeCase = [
      "```json",
      '{"chapter_number": "7", "summary": "第七章摘要", "events": ["城门封锁"]}',
      "```",
    ].join("\n")
    const match = extractSnapshotJsonCandidate(snakeCase)
    expect(match).not.toBeNull()
    expect(match?.chapterNumber).toBe(7)
    expect(match?.detectedFields).toEqual(expect.arrayContaining(["chapter_number", "summary", "events"]))

    // chapterNumber + chapter_number represent the same canonical slot -> < 2 distinct canonical fields
    const duplicateSlotOnly = '```json\n{"chapterNumber": 7, "chapter_number": 7}\n```'
    expect(extractSnapshotJsonCandidate(duplicateSlotOnly)).toBeNull()
  })

  it("picks the last valid fenced JSON match and skips trailing non-snapshot JSON blocks", () => {
    const reply = [
      "初版：",
      "```json",
      '{"chapterNumber": 2, "summary": "初版摘要", "characters": ["林川"]}',
      "```",
      "修订版：",
      "```json",
      '{"chapterNumber": 4, "summary": "最终修订摘要", "timelineEvents": ["子时起火"]}',
      "```",
      "附带工具状态：",
      "```json",
      '{"ok": true, "tool": "chapter.read"}',
      "```",
    ].join("\n")

    const candidate = extractSnapshotJsonCandidate(reply)
    expect(candidate).not.toBeNull()
    expect(candidate?.chapterNumber).toBe(4)
    expect(JSON.parse(candidate!.rawJson)).toMatchObject({
      chapterNumber: 4,
      summary: "最终修订摘要",
    })
  })

  it("extracts standalone JSON objects when no fenced JSON block matches and handles braces inside strings", () => {
    const reply = [
      "注意 { 前文先给一个示例：",
      '{"summary": "旧草稿 {带括号}", "events": ["旧事件"]}',
      "下面是最终结果：",
      '{"chapterNumber": 9, "summary": "终版 {含大括号与\\"引号\\"}", "characters": ["林川"]}',
    ].join("\n")

    const candidate = extractSnapshotJsonCandidate(reply)
    expect(candidate).not.toBeNull()
    expect(candidate?.chapterNumber).toBe(9)
    expect(JSON.parse(candidate!.rawJson)).toMatchObject({
      chapterNumber: 9,
      summary: '终版 {含大括号与"引号"}',
    })
  })

  it("returns chapterNumber: null when chapterNumber is missing or non-positive while other primary markers satisfy criteria", () => {
    const missingChapter = '```json\n{"summary": "无章号但合法", "characters": ["林川"]}\n```'
    const c1 = extractSnapshotJsonCandidate(missingChapter)
    expect(c1).not.toBeNull()
    expect(c1?.chapterNumber).toBeNull()

    const invalidChapter = '```json\n{"chapterNumber": 0, "summary": "零章号", "events": ["交手"]}\n```'
    const c2 = extractSnapshotJsonCandidate(invalidChapter)
    expect(c2).not.toBeNull()
    expect(c2?.chapterNumber).toBeNull()
  })

  it("rejects non-JSON fences, non-snapshot objects, single-field objects, missing primary markers, arrays, and malformed JSON", () => {
    // Non-JSON code fence
    expect(
      extractSnapshotJsonCandidate(
        '```typescript\n{"chapterNumber": 3, "summary": "ts code", "characters": []}\n```',
      ),
    ).toBeNull()
    // Fewer than 2 canonical fields
    expect(extractSnapshotJsonCandidate('```json\n{"summary": "仅单字段"}\n```')).toBeNull()
    // >= 2 canonical fields but 0 primary markers
    expect(
      extractSnapshotJsonCandidate('```json\n{"locations": ["京城"], "items": ["玉佩"]}\n```'),
    ).toBeNull()
    // Generic non-snapshot JSON
    expect(extractSnapshotJsonCandidate('{"status": "ok", "count": 3}')).toBeNull()
    // JSON array
    expect(extractSnapshotJsonCandidate('[{"chapterNumber": 1, "summary": "a"}]')).toBeNull()
    // Malformed / truncated JSON
    expect(
      extractSnapshotJsonCandidate('```json\n{"chapterNumber": 3, "summary": "未闭合\n```'),
    ).toBeNull()
    // Plain prose without JSON
    expect(extractSnapshotJsonCandidate("# 第三章 正文\n\n林川推开了院门。")).toBeNull()
  })
})
