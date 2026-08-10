/**
 * Step 0 A/B 校准实验（20260806 swarm 共识）— 真实 LLM 通道（并发版）。
 *
 * 目标：在同一章节文本上对比 OLD（改动前，夹具快照）与 NEW（改动后，含
 * 量程声明 + 档位行为锚点 + 出口条款 + style-exemplars few-shot）六维审查
 * prompt 的分数中位数，用校准二分判据判定 9.0 缺口主要是评审偏差还是文本
 * 差距：
 *   - NEW 校准后中位数 ≥ 8.3 → 评审偏差主导（无需全文重写，仅定向重写）
 *   - NEW 校准后仍 ≤ 7.5   → 文本差距主导（需 plan-then-write 全文重写）
 *
 * 结构：12 个 it.concurrent（6 维 × 2 臂，每臂 3 采样），afterAll 聚合
 * 中位数 + 判定并写盘。墙钟时间 ≈ 3 × 单次调用延迟。
 *
 * 触发方式（key 不入 git，缺则 skip）：
 *   STEP0_REAL_LLM_KEY=... STEP0_REAL_LLM_BASE=... STEP0_REAL_LLM_MODEL=... \
 *     npx vitest run src/lib/novel/step0-ab-calibration.real-llm.spec.ts
 *
 * 输出：{QMAI}/../.workflow/harvest-staging/step0-ab-results.json（每维每臂
 * 3 采样 + 中位数 + 判定），控制台打印对照表。
 */
import { afterAll, describe, expect, it } from "vitest"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import {
  buildDimensionReviewPrompt,
  SIX_REVIEW_DIMENSIONS,
  SIX_REVIEW_DIMENSION_ORDER,
  type SixReviewDimensionKey,
} from "./dimension-review-adapter"
import {
  LITERARY_EXPERIMENT_DEFAULT_MODEL,
  LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL,
  createLiteraryExperimentProtocol,
  type LiteraryExperimentProtocol,
} from "./literary-experiment-protocol"
import {
  buildMeasurementFingerprint,
  formatMeasurementFingerprintSummary,
} from "./measurement-fingerprint"

const REAL_KEY = process.env.STEP0_REAL_LLM_KEY ?? ""
const REAL_BASE = process.env.STEP0_REAL_LLM_BASE ?? ""
// Default locked to literary-experiment protocol model (composer-2.5 often unavailable).
const REAL_MODEL = process.env.STEP0_REAL_LLM_MODEL ?? LITERARY_EXPERIMENT_DEFAULT_MODEL
// 里程碑/结案默认 N≥5 中位（FIX-3c 证实 N=3 偏乐观会翻判定）。
// 开发冒烟可用 STEP0_SAMPLES=3；结案与里程碑验收禁止用 N<5 作最终结论。
const SAMPLES = (() => {
  const raw = process.env.STEP0_SAMPLES
  if (raw == null || raw === "") return 5
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return 5
  return Math.min(10, Math.max(1, n))
})()
const FIXTURE = resolve("src/lib/novel/__fixtures__/step0-ab-prompts.json")
const RESULTS = resolve("../.workflow/harvest-staging/step0-ab-results.json")

const hasRealCreds = REAL_KEY.length > 0 && REAL_BASE.length > 0
const describeOrSkip = hasRealCreds ? describe : describe.skip

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function extractScore(text: string): number {
  const m = text.match(/"score"\s*:\s*([\d.]+)/)
  return m ? Number(m[1]) : NaN
}

describeOrSkip("Step 0 A/B 校准 — 旧/新 prompt 分数中位数对照", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    chapterText: string
    pack: Parameters<typeof buildDimensionReviewPrompt>[0]
    prompts: { old: Record<string, string> }
  }
  const llmConfig = {
    provider: "custom" as const,
    apiKey: REAL_KEY,
    model: REAL_MODEL,
    ollamaUrl: "",
    customEndpoint: REAL_BASE,
    apiMode: "chat_completions" as const,
    maxContextSize: 131072,
    reasoning: { mode: "off" as const },
  }

  // 每维每臂 3 采样的并发累加（afterAll 聚合）
  const scores: Record<string, { old: (number | null)[]; new: (number | null)[]; errors: string[] }> = {}
  for (const dim of SIX_REVIEW_DIMENSION_ORDER as SixReviewDimensionKey[]) {
    scores[dim] = { old: [], new: [], errors: [] }
  }

  const runArm = async (dim: SixReviewDimensionKey, arm: "old" | "new") => {
    const prompt =
      arm === "old" ? fixture.prompts.old[dim] : buildDimensionReviewPrompt(fixture.pack, fixture.chapterText, SIX_REVIEW_DIMENSIONS[dim])
    const sink = scores[dim][arm]
    for (let sample = 0; sample < SAMPLES; sample++) {
      const finalPrompt = `${prompt}\n\n只输出最终 JSON 对象（含 score、status、summary、issues），不要输出解释。`
      // 最多 3 次尝试（上游限流/空响应重试），旧臂未声明量程 → >10.5 视为 0-100 归一为 0-10
      let value: number | null = null
      for (let attempt = 1; attempt <= 3 && value === null; attempt++) {
        let content = ""
        try {
          await streamChat(
            llmConfig,
            [{ role: "user", content: finalPrompt }],
            {
              onToken: (t: string) => {
                content += t
              },
              onDone: () => undefined,
              onError: (e: Error) => {
                throw e
              },
            } satisfies StreamCallbacks,
            AbortSignal.timeout(300000),
            { temperature: 0.4, max_tokens: 2000 },
          )
          const raw = extractScore(content)
          if (!Number.isNaN(raw)) value = raw > 10.5 ? raw / 10 : raw
        } catch {
          // 重试
        }
        if (value === null && attempt < 3) {
          await new Promise((r) => setTimeout(r, 3000 * attempt))
        }
      }
      sink.push(value)
      if (value === null) scores[dim].errors.push(`[${arm}/s${sample}] no score after retries`)
      // eslint-disable-next-line no-console
      console.log(`[${arm}/${dim}/s${sample}] done`)
    }
  }

  // STEP0_AB_ONLY='character:old,pull:new' 定向补采样（默认全部）
  // 测量纪律：里程碑/Track B 诊断应 STEP0_DIAGNOSIS_NEW_ONLY=1 或 STEP0_AB_ONLY 仅 *:new——
  // fixture.prompts.old 仍为历史截断快照，禁止用 OLD 臂作全文窗结案对照。
  const diagnosisNewOnly = process.env.STEP0_DIAGNOSIS_NEW_ONLY === "1" || process.env.STEP0_DIAGNOSIS_NEW_ONLY === "true"
  const onlyPairs = (process.env.STEP0_AB_ONLY ?? "").split(",").filter(Boolean)
  const shouldRun = (dim: string, arm: string) => {
    if (diagnosisNewOnly && arm === "old") return false
    return onlyPairs.length === 0 || onlyPairs.includes(`${dim}:${arm}`)
  }
  for (const dim of SIX_REVIEW_DIMENSION_ORDER as SixReviewDimensionKey[]) {
    if (shouldRun(dim, "old")) it.concurrent(`[old] ${dim}`, () => runArm(dim, "old"), 1500000)
    if (shouldRun(dim, "new")) it.concurrent(`[new] ${dim}`, () => runArm(dim, "new"), 1500000)
  }

  afterAll(() => {
    // 定向补采样：与既有结果合并（仅覆盖本次运行的 dim/arm）
    let merged: Record<string, { old: (number | null)[]; new: (number | null)[]; errors: string[] }> = scores
    if (onlyPairs.length > 0) {
      try {
        const prev = JSON.parse(readFileSync(RESULTS, "utf8")) as { results: Record<string, { old: (number | null)[]; new: (number | null)[]; errors: string[] }> }
        merged = JSON.parse(JSON.stringify(prev.results))
        for (const d of SIX_REVIEW_DIMENSION_ORDER) {
          for (const arm of ["old", "new"] as const) {
            if (onlyPairs.includes(`${d}:${arm}`) && scores[d] && scores[d][arm].length > 0) {
              merged[d] = { ...merged[d], [arm]: scores[d][arm] }
            }
          }
        }
      } catch {
        merged = scores
      }
    }
    const mediansOf = (arm: "old" | "new") =>
      SIX_REVIEW_DIMENSION_ORDER.map((d) => median(merged[d][arm].filter((v): v is number => v !== null)))
    const overallOld = median(mediansOf("old"))
    const overallNew = median(mediansOf("new"))

    const results: Record<string, unknown> = {}
    for (const d of SIX_REVIEW_DIMENSION_ORDER) {
      const r = merged[d]
      results[d] = {
        old: r.old,
        new: r.new,
        oldMedian: median(r.old.filter((v): v is number => v !== null)),
        newMedian: median(r.new.filter((v): v is number => v !== null)),
        errors: r.errors,
      }
    }

    const protocol: LiteraryExperimentProtocol = createLiteraryExperimentProtocol({
      model: REAL_MODEL,
      samples: SAMPLES,
      mode: diagnosisNewOnly ? "NEW_only" : "AB_old_new",
      label: process.env.STEP0_LABEL || undefined,
      notes: [
        "product hard gate is Track A only — overall≥9 is not a ship criterion",
        diagnosisNewOnly
          ? "NEW-only diagnosis: OLD arm skipped by design"
          : "AB mode: OLD arm uses fixture.prompts.old snapshots (may be truncated history)",
      ],
    })
    if (SAMPLES < LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL) {
      // eslint-disable-next-line no-console
      console.warn(
        `[literary-experiment] samples=${SAMPLES} < seal minimum ${LITERARY_EXPERIMENT_MIN_SAMPLES_SEAL} — smoke only`,
      )
    }

    const fixturePack = (fixture as { pack?: import("./context-engine").ContextPack; chapterText?: string; packKind?: string }).pack
    const fixtureText = (fixture as { chapterText?: string }).chapterText ?? ""
    const measurementFingerprint =
      fixturePack != null
        ? buildMeasurementFingerprint({
            protocol,
            pack: fixturePack,
            chapterText: fixtureText,
            packKind: (fixture as { packKind?: string }).packKind,
          })
        : undefined
    if (measurementFingerprint) {
      // eslint-disable-next-line no-console
      console.log(`[measurement-fingerprint] ${formatMeasurementFingerprintSummary(measurementFingerprint)}`)
    }

    mkdirSync(dirname(RESULTS), { recursive: true })
    writeFileSync(
      RESULTS,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          model: REAL_MODEL,
          base: REAL_BASE,
          samples: SAMPLES,
          fixture: FIXTURE,
          protocol,
          window: protocol.window,
          diagnosisNewOnly,
          measurementFingerprint: measurementFingerprint ?? null,
          results,
          verdict: {
            overallOldMedian: overallOld,
            overallNewMedian: overallNew,
            delta: overallNew - overallOld,
            criterion: "newMedian >= 8.3 → 评审偏差主导；<= 7.5 → 文本差距主导",
            decision:
              overallNew >= 8.3
                ? "评审偏差主导（无需全文重写，仅定向重写）"
                : overallNew <= 7.5
                  ? "文本差距主导（plan-then-write 全文重写）"
                  : "边界区（需补充采样或人工裁定阈值）",
            productHardGate: false,
            overallGe9IsShipCriterion: false,
          },
        },
        null,
        2,
      ),
      "utf8",
    )

    // eslint-disable-next-line no-console
    console.log(
      SIX_REVIEW_DIMENSION_ORDER.map((d) => {
        const r = merged[d]
        const om = median(r.old.filter((v): v is number => v !== null))
        const nm = median(r.new.filter((v): v is number => v !== null))
        return `${d}: old ${r.old.map((v) => (v === null ? "x" : v)).join("/")} (med ${om}) → new ${r.new.map((v) => (v === null ? "x" : v)).join("/")} (med ${nm})`
      }).join("\n"),
    )
    // eslint-disable-next-line no-console
    console.log(`overall: old ${overallOld} → new ${overallNew} (delta ${(overallNew - overallOld).toFixed(2)})`)

    // NEW-only diagnosis (STEP0_DIAGNOSIS_NEW_ONLY) leaves old[] empty by design — require new samples only.
    const validDims = SIX_REVIEW_DIMENSION_ORDER.filter((d) =>
      diagnosisNewOnly
        ? merged[d].new.some((v) => v !== null)
        : merged[d].old.some((v) => v !== null) && merged[d].new.some((v) => v !== null),
    )
    expect(validDims.length).toBeGreaterThanOrEqual(2)
  })
})
