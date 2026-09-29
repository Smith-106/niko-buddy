// @vitest-environment node
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// snapshot-paths.spec — F4-3（Round-3 评估）拆分产物单测：
// 快照路径簇 + snapshotToMarkdown（与 chapter-ingest 内联实现语义一致）。

import { describe, expect, it } from "vitest"
import {
  snapshotFilePrefix,
  snapshotHistoryDir,
  snapshotHistoryFileName,
  snapshotJsonPath,
  snapshotMarkdownPath,
  snapshotSourceFileNameCandidates,
  snapshotToMarkdown,
} from "./snapshot-paths"
import type { ChapterSnapshot } from "./chapter-ingest"

describe("snapshot-paths (F4-3 split)", () => {
  it("路径簇：正文章节 3 位补零；负数走 outline 前缀", () => {
    expect(snapshotFilePrefix(3)).toBe("003")
    expect(snapshotFilePrefix(-1)).toBe("outline-001")
    expect(snapshotJsonPath("/p", 3)).toBe("/p/.novel/snapshots/003.snapshot.json")
    expect(snapshotMarkdownPath("/p", 3)).toBe("/p/.novel/snapshots/003.snapshot.md")
    expect(snapshotHistoryDir("/p", 3)).toBe("/p/.novel/snapshots/history/003")
    expect(snapshotHistoryFileName()).toMatch(/\.snapshot\.json$/)
    expect(snapshotSourceFileNameCandidates(3)).toContain("003.snapshot.json")
  })

  it("snapshotToMarkdown：空快照全（无）占位 + 结尾钩子兜底", () => {
    const snap = {
      chapterNumber: 3,
      summary: "雾夜入宅",
      characters: [], locations: [], organizations: [], items: [], events: [],
      characterStateChanges: [], relationshipChanges: [], knowledgeChanges: [],
      foreshadowingChanges: [], newCanonFacts: [], timelineEvents: [],
      conflicts: [], endingHook: "", graphNodes: [], graphEdges: [],
    } as unknown as ChapterSnapshot
    const md = snapshotToMarkdown(snap)
    expect(md).toContain("# 第3章 快照")
    expect(md).toContain("雾夜入宅")
    expect(md).toContain("（无）")
  })
})
