#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * thrill 大纲层基线审计（零 LLM，纯机械）
 *
 * 用途：对整本大纲逐章跑 thrill 结构检查点，输出与历史基线同口径的统计。
 * 与 L9 六维文学评分（S1/S3，需 LLM）是**两件不同的事**，勿混用成本口径：
 *   - 本脚本：0 次 LLM 调用
 *   - L9 S1：8 章 × 6 维 × N=10 = 480 calls
 *   - 全书纯测量：162 × 6 × 5 = 4860 calls
 *
 * 历史基线（2026-10-28，改造前）：
 *   CHAPTERS:170 FULL_PASS:0 ANY_GAP:170
 *   missingTally: pressure_release 165 / protagonist_agency 141 / chapter_end_hook 167
 *   avg_pass_per_chapter: 2.22
 *
 * 用法：
 *   node --experimental-strip-types QMAI/scripts/thrill-outline-audit.mts
 *   node --experimental-strip-types QMAI/scripts/thrill-outline-audit.mts --json
 *   node --experimental-strip-types QMAI/scripts/thrill-outline-audit.mts --outline <path>
 *
 * 退出码：0 = 审计完成（不代表达标）；2 = 大纲文件不可读。
 */

import { readFileSync } from "node:fs"
import { auditOutlineThrillByChapter } from "../src/lib/novel/outline-thrill-checkpoints.ts"

const DEFAULT_OUTLINE = "C:/QM-BOOK/身体都是租的，你让我修仙？/QM/outlines/story-outline.md"

const args = process.argv.slice(2)
const asJson = args.includes("--json")
const outlineIdx = args.indexOf("--outline")
const outlinePath = outlineIdx >= 0 && args[outlineIdx + 1] ? args[outlineIdx + 1] : DEFAULT_OUTLINE

let text
try {
  text = readFileSync(outlinePath, "utf8")
} catch (err) {
  console.error(`无法读取大纲：${outlinePath}\n${String(err)}`)
  process.exit(2)
}

const result = auditOutlineThrillByChapter(text)
const gapChapters = result.chapters.filter((c) => c.gaps.length > 0)

if (asJson) {
  console.log(JSON.stringify({
    outlinePath,
    chapters: result.chapters.length,
    fullPassCount: result.fullPassCount,
    anyGapCount: gapChapters.length,
    averagePassPerChapter: Number(result.averagePassPerChapter.toFixed(2)),
    missingTally: result.missingTally,
    perChapter: result.chapters.map((c) => ({
      chapterNumber: c.chapterNumber,
      title: c.title,
      gaps: c.gaps,
    })),
  }, null, 2))
} else {
  console.log(`CHAPTERS:${result.chapters.length} FULL_PASS:${result.fullPassCount} ANY_GAP:${gapChapters.length}`)
  console.log(`avg_pass_per_chapter:${result.averagePassPerChapter.toFixed(2)}`)
  console.log(`missingTally:${JSON.stringify(result.missingTally)}`)
  if (gapChapters.length > 0) {
    const sample = gapChapters.slice(0, 5).map((c) => `ch${c.chapterNumber}[${c.gaps.join(",")}]`)
    console.log(`sample_gaps: ${sample.join(" | ")}`)
  }
}
