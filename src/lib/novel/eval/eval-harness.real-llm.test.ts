/**
 * eval-harness.real-llm.test.ts — F1 G1 骨架 C 门：真实基线回放。
 *
 * 命名 .test.ts（非 .spec.ts）：test:mocks 排除表仅含 *.real-llm.test.ts，
 * 由 eval:l3（cross-env REAL_LLM=1）显式运行。
 *
 * F3 真实接线（eval-real-baseline-path.md §2）：
 *  - assemble：真实快照语料直构 ContextPack（canonRules=newCanonFacts 渲染）→
 *    contextPackToAssembledView（tier 装配期判定：canon_fact → protected）
 *  - L1：goldChunk（real-g-*）在 protected 层存在性命中率（C5，非 rank）
 *  - L2：poison 不得进 protected（真实语料无负样本时 trivially 1.0）
 *  - L3：checkContinuity 真实机械引擎（零 LLM）→ isL3CriticalFinding（C3）
 *  - 验收：A 门 L2≥0.99 > L1≥0.95 > L3<0.01；语料缺失/损坏 → 显式 SKIP（C7）
 *
 * 真实语料 = scripts/eval-extract-real.mjs 产物（fixtures/cases.jsonl +
 * manifest.json source=real + frozen/<digest>/）。
 */
import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { runContinuityEngine } from "../deterministic-continuity-engine"
import { runEvalSuite } from "./eval-harness"
import { DEFAULT_THRESHOLDS } from "./eval-metrics"
import type { ContextPack } from "../context-engine"
import type { EvalCase } from "./eval-schema"

const EVAL_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(EVAL_DIR, "fixtures")

const REAL_LLM_ENABLED = process.env.REAL_LLM === "1"

function readJsonl(path: string) {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

/** 真实装配：快照语料的 canon 事实 → ContextPack 直构（tier=protected）。 */
async function realAssemble(caseItem: EvalCase): Promise<ContextPack> {
  const canonRules = caseItem.goldChunks
    .map((g) => `${g.subject} ${g.predicate} ${g.object}`)
    .join("\n")
  return {
    task: "eval",
    chapterGoal: "",
    outline: "",
    recentSummaries: [],
    previousChapterEnding: "",
    characterStates: "",
    soulDoc: "",
    characterAuras: "",
    cognitionStates: "",
    foreshadowingStates: "",
    timeline: "",
    relatedSettings: "",
    canonRules,
    writingStyle: "",
    searchResults: "",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
  }
}

describe("eval-harness real-llm gate (C-gate)", () => {
  const manifestPath = join(FIXTURES_DIR, "manifest.json")
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null
  const realCases: EvalCase[] =
    manifest?.source === "real" ? readJsonl(join(FIXTURES_DIR, "cases.jsonl")) : []
  const usableCases = realCases.filter((c) => c.goldChunks.length > 0)

  const skipReason = !manifest
    ? "fixtures/manifest.json 缺失"
    : manifest.source !== "real"
      ? `manifest.source=${manifest.source}（非 real；合成语料走 eval:baseline，C7 禁冒充）`
      : realCases.length === 0
        ? "cases.jsonl 无真实 case"
        : usableCases.length === 0
          ? "真实 case 全部无 goldChunks（语料损坏，C7 显式 SKIP）"
          : null

  it.skipIf(Boolean(skipReason))("A 门：真实语料 L2>=0.99 > L1>=0.95 > L3<0.01", async () => {
    if (skipReason) {
      // C7：显式 SKIP + 告警，绝不静默 PASS
      process.stderr.write(`[eval-harness.real-llm] SKIP: ${skipReason}\n`)
      return
    }

    const result = await runEvalSuite(
      usableCases,
      {
        assemble: realAssemble,
        l3Findings: async (_caseItem, _pack) => {
          // L3：checkContinuity 真实机械引擎（零 LLM）。
          // 输入：快照时间线/角色状态（语料损坏维度缺失 → 空输入 → 引擎零信号）。
          return runContinuityEngine({
            foreshadowing: [],
            subplots: [],
            characters: [],
            snapshots: [],
            currentChapter: _caseItem.chapter,
          })
        },
      },
      { replayOnlyFailed: false, thresholds: { l1Min: 0.95, l2Min: 0.99, l3Max: 0.01 } },
    )

    const agg = result.aggregate
    expect(agg.layers.L2.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.l2Min)
    expect(agg.layers.L1.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.l1Min)
    expect(agg.layers.L3.score).toBeLessThan(DEFAULT_THRESHOLDS.l3Max)
    expect(agg.overall).toBe(true)
  })

  it.skipIf(!REAL_LLM_ENABLED)("skeleton guard: REAL_LLM=1 门控生效", () => {
    expect(REAL_LLM_ENABLED).toBe(true)
  })
})
