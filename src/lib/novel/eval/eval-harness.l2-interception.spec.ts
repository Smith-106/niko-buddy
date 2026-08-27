/**
 * eval-harness.l2-interception.spec.ts — crossbook 毒丸端到端拦截测试（合成注入）。
 *
 * 三模型共识 plan 落点（MODE: write，只新建本文件）：
 *  - 复用 runEvalCase（./eval-harness），assemble 基于 realAssemble 形态
 *    （goldChunks → canonRules 字符串），注入/排除/former 三变体分别覆写
 *    canonRules / searchResults / characterStates(+formerFacts)。
 *  - 毒丸来源 = 真实 fixtures/cases.jsonl（readJsonl，取首条
 *    poisonType=crossbook_leak 毒丸）；fixtures 缺失或无毒丸 → describe.skipIf
 *    显式 SKIP（C7 不静默 PASS）。
 *  - case 构造 source: "synthetic"（C7：不触碰 manifest.source==="real" 路径）。
 *  - layerContainsTriple 是 substring includes 三段 AND；毒丸 subject 复用真实
 *    前缀（chapter-<他书>-<章号>）避免与宿主 gold 子串碰撞。
 *  - 不引入随机；确定性。不改 eval-harness/eval-metrics/eval-adapters/real-llm.test。
 */
import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { runEvalCase } from "./eval-harness"
import type { ContextPack } from "../context-engine"
import type { TemporalFact } from "../temporal-memory"
import type { EvalCase, PoisonChunk } from "./eval-schema"

const EVAL_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(EVAL_DIR, "fixtures")

function readJsonl(path: string): EvalCase[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalCase)
}

/** 三元组 → "subject predicate object" 文本。 */
function tripleText(subject: string, predicate: string, object: string): string {
  return `${subject} ${predicate} ${object}`
}

/** goldChunks → canonRules 字符串（realAssemble 形态）。 */
function goldCanonRules(caseItem: EvalCase): string {
  return caseItem.goldChunks
    .map((g) => tripleText(g.subject, g.predicate, g.object))
    .join("\n")
}

/** realAssemble 形态的空 ContextPack 基底（除 canonRules 外全部空）。 */
const EMPTY_PACK: ContextPack = {
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
  canonRules: "",
  writingStyle: "",
  searchResults: "",
  graphSearchResults: "",
  mustDo: "",
  mustAvoid: "",
  nextChapterAdvice: "",
  revisionDirectives: "",
}

/** 由真实毒丸源 case 派生 synthetic case（C7：source 显式标 synthetic）。 */
function buildSyntheticCase(source: EvalCase, poisonChunks: PoisonChunk[], id: string): EvalCase {
  return {
    id,
    chapter: source.chapter,
    query: source.query,
    goldChunks: source.goldChunks,
    poisonChunks,
    expectedLayer: "protected",
    source: "synthetic",
  }
}

const allCases = readJsonl(join(FIXTURES_DIR, "cases.jsonl"))
const poisonSourceCase = allCases.find(
  (c) => Array.isArray(c.poisonChunks) && c.poisonChunks.some((p) => p.poisonType === "crossbook_leak"),
)
const crossbookPoison = poisonSourceCase?.poisonChunks?.find((p) => p.poisonType === "crossbook_leak")

/** former_as_current 合成毒丸（subject 用真实跨书前缀 chapter-十日终焉-1，避免 gold 碰撞）。 */
const formerPoison: PoisonChunk = {
  id: "syn-former-p-0",
  subject: "chapter-十日终焉-1",
  predicate: "former_state",
  object: "十年前的旧城邦尚存于地表",
  poisonType: "former_as_current",
  expectedLanding: "former",
}

const formerFact: TemporalFact = {
  id: "syn-former-f-0",
  subject: formerPoison.subject,
  predicate: formerPoison.predicate,
  object: formerPoison.object,
  validFrom: 1,
  validUntil: 3,
  former: true,
  source: "synthetic",
}

const skipReason =
  allCases.length === 0
    ? "fixtures/cases.jsonl 缺失或为空（C7 显式 SKIP）"
    : !poisonSourceCase || !crossbookPoison
      ? "cases.jsonl 无 crossbook_leak 毒丸（C7 显式 SKIP）"
      : null

if (skipReason) {
  process.stderr.write(`[eval-harness.l2-interception] SKIP: ${skipReason}\n`)
}

describe.skipIf(Boolean(skipReason))("eval-harness L2 crossbook interception (合成注入)", () => {
  it("注入变体：毒丸三元组追加进 canonRules → L2 计 1 条 leak 且 fail；L1 正交通过", async () => {
    const poison = crossbookPoison!
    const caseItem = buildSyntheticCase(poisonSourceCase!, [poison], "syn-crossbook-l2-inject")
    const injected = tripleText(poison.subject, poison.predicate, poison.object)

    const result = await runEvalCase(caseItem, {
      assemble: async (ci) => ({
        ...EMPTY_PACK,
        canonRules: `${goldCanonRules(ci)}\n${injected}`,
      }),
    })

    const { L1, L2 } = result.layers
    // L1 正交：goldChunks 全部仍命中 protected（毒丸注入不影响 L1）。
    expect(L1.score).toBeGreaterThanOrEqual(0.95)
    // L2：毒丸进入 protectedCurrent → 1 条 leak，score < 0.99，A 门 fail。
    expect(L2.score).toBeLessThan(0.99)
    expect(L2.detail.leaks).toBe(1)
    expect(L2.pass).toBe(false)
  })

  it("排除变体：毒丸三元组写入 searchResults（不映射 protected 层）→ L2 满分", async () => {
    const poison = crossbookPoison!
    const caseItem = buildSyntheticCase(poisonSourceCase!, [poison], "syn-crossbook-l2-exclude")
    const injected = tripleText(poison.subject, poison.predicate, poison.object)

    const result = await runEvalCase(caseItem, {
      assemble: async (ci) => ({
        ...EMPTY_PACK,
        canonRules: goldCanonRules(ci),
        searchResults: injected,
      }),
    })

    const { L2 } = result.layers
    expect(L2.score).toBe(1.0)
    expect(L2.pass).toBe(true)
    expect(L2.detail.leaks).toBe(0)
  })

  it("former 分支：former_as_current 落 protectedCurrent 且落 protectedFormer → 豁免生效", async () => {
    const caseItem = buildSyntheticCase(poisonSourceCase!, [formerPoison], "syn-crossbook-l2-former")
    const formerTriple = tripleText(formerPoison.subject, formerPoison.predicate, formerPoison.object)

    const result = await runEvalCase(caseItem, {
      assemble: async (ci) => ({
        ...EMPTY_PACK,
        canonRules: goldCanonRules(ci),
        // 三元组同时进 protectedCurrent（characterStates）与 protectedFormer（formerFacts）。
        characterStates: formerTriple,
        formerFacts: [formerFact],
      }),
    })

    const { L2 } = result.layers
    expect(L2.score).toBe(1.0)
    expect(L2.pass).toBe(true)
    expect(L2.detail.leaks).toBe(0)

    // 对照：同三元组进 protectedCurrent 但未落 protectedFormer → 应计 1 条 leak
    // （证明豁免分支确实被命中，而非毒丸根本不在 protected 层的空洞 PASS）。
    const withoutFormer = await runEvalCase(caseItem, {
      assemble: async (ci) => ({
        ...EMPTY_PACK,
        canonRules: goldCanonRules(ci),
        characterStates: formerTriple,
      }),
    })
    expect(withoutFormer.layers.L2.detail.leaks).toBe(1)
    expect(withoutFormer.layers.L2.score).toBeLessThan(0.99)
  })
})
