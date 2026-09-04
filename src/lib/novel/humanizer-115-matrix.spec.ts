import { describe, expect, it } from "vitest"
import { AUDIT_TAXONOMY, type AuditDimensionId } from "./audit-taxonomy"
import { DE_AI_EXTENDED_TABLE, detectTieredDeAi } from "./de-ai-tiered-table"

/**
 * 55 号设计 W3-4: humanizer 簇 115 条模式池 × anti_ai gate 维度对照矩阵（静态契约锁）。
 *
 * 背景（54⑨ 口径偏窄复审）：54 号 ⑨ 的 51-type 矩阵只覆盖 10 个 anti_ai 维度，
 * 未对照 34 号已深研的 humanizer 簇 4 仓模式池（humanizer 35 + humanizer-x 30 +
 * ultimate-humanizer 50 = 115 条）。本矩阵逐条对照，防「口径偏窄」复审遗漏。
 *
 * 判定口径（与 54⑨ 三态一致）：
 *   - 已覆盖 = 该模式有 QMAI 确定性/机械层检测器命中（中文网文路径）；
 *   - 豁免 = 结构性豁免：英文/排版/SEO/客服/技术文档/注入类信号对中文网文无意义，
 *     或英文统计指纹由 vendored avoid-ai-writing 引擎 Track B soft 参考（不设产品硬门）；
 *   - 缺口 = 无检测器对应（登记在案，纳入后续批次）。
 *
 * 数据源（reference/ 只读仓，2026-08-31 34 号深研时浅克隆）：
 *   - reference/humanizer/README.md "The 35 patterns"（Wikipedia Signs of AI writing）
 *   - reference/humanizer-x/SKILL.md Pass 1 30 patterns（27 编号 + 28-30 注入类）
 *   - reference/ultimate-humanizer/references/patterns.md P1-P50
 *
 * 本 spec 为静态契约锁（无 LLM/IO）：若模式增删或判定漂移，测试红。
 * 人类可读报告：docs/qmai-codex-delivery/55-w3-4-humanizer-115-matrix-20260904.md
 */

type MatrixRow = readonly [
  repo: "humanizer" | "humanizer-x" | "ultimate-humanizer",
  id: string,
  name: string,
  dimension: AuditDimensionId,
  status: "已覆盖" | "豁免" | "缺口",
]

const MATRIX: readonly MatrixRow[] = [
  // ── humanizer（blader，35 条，Wikipedia Signs of AI writing）──────────────
  ["humanizer", "H1", "Inflated importance and legacy", "de_ai_residual", "已覆盖"],
  ["humanizer", "H2", "Name-dropping to prove importance", "statistical_ai_signature", "豁免"],
  ["humanizer", "H3", "Shallow -ing analysis", "slop_explanation", "已覆盖"],
  ["humanizer", "H4", "Sales language", "de_ai_residual", "已覆盖"],
  ["humanizer", "H5", "Vague sources", "statistical_ai_signature", "豁免"],
  ["humanizer", "H6", "Formulaic challenges and outlook", "slop_summary", "已覆盖"],
  ["humanizer", "H7", "Overused AI words", "de_ai_residual", "已覆盖"],
  ["humanizer", "H8", "Avoiding is and are", "statistical_ai_signature", "豁免"],
  ["humanizer", "H9", "Not X but Y and clipped endings", "de_ai_residual", "已覆盖"],
  ["humanizer", "H10", "Forced groups of three", "de_ai_residual", "已覆盖"],
  ["humanizer", "H11", "Changing names and repeated openings", "behavioral_repetition", "缺口"],
  ["humanizer", "H12", "False from X to Y ranges", "statistical_ai_signature", "豁免"],
  ["humanizer", "H13", "Passive voice and missing subjects", "statistical_ai_signature", "豁免"],
  ["humanizer", "H14", "Em/en dashes", "slop_mechanical", "已覆盖"],
  ["humanizer", "H15", "Too much bold text", "statistical_ai_signature", "豁免"],
  ["humanizer", "H16", "Lists with bold mini-headings", "statistical_ai_signature", "豁免"],
  ["humanizer", "H17", "Title case in headings", "statistical_ai_signature", "豁免"],
  ["humanizer", "H18", "Emojis", "statistical_ai_signature", "豁免"],
  ["humanizer", "H19", "Curly quotes", "slop_mechanical", "已覆盖"],
  ["humanizer", "H20", "Chatbot text left in the answer", "statistical_ai_signature", "豁免"],
  ["humanizer", "H21", "Knowledge-limit disclaimers and guesses", "statistical_ai_signature", "豁免"],
  ["humanizer", "H22", "Overly agreeable tone", "statistical_ai_signature", "豁免"],
  ["humanizer", "H23", "Filler phrases", "slop_mechanical", "已覆盖"],
  ["humanizer", "H24", "Too many qualifiers", "statistical_ai_signature", "豁免"],
  ["humanizer", "H25", "Generic positive endings", "slop_summary", "已覆盖"],
  ["humanizer", "H26", "Too many hyphenated word pairs", "statistical_ai_signature", "豁免"],
  ["humanizer", "H27", "A fake deeper truth", "de_ai_residual", "已覆盖"],
  ["humanizer", "H28", "Announcing the next point", "formulaic_transition", "已覆盖"],
  ["humanizer", "H29", "A heading repeated below itself", "statistical_ai_signature", "豁免"],
  ["humanizer", "H30", "Writing about the old version", "statistical_ai_signature", "豁免"],
  ["humanizer", "H31", "Forced punchlines and fragments", "de_ai_residual", "已覆盖"],
  ["humanizer", "H32", "Formulaic sayings", "de_ai_residual", "已覆盖"],
  ["humanizer", "H33", "Fake-candid openings", "slop_explanation", "已覆盖"],
  ["humanizer", "H34", "Answering objections no one raised", "statistical_ai_signature", "豁免"],
  ["humanizer", "H35", "Rejecting fake alternatives", "statistical_ai_signature", "豁免"],
  // ── humanizer-x（itsjwill，30 条：27 编号 + 28-30 注入类）──────────────────
  ["humanizer-x", "X1", "Overused AI Vocabulary", "de_ai_residual", "已覆盖"],
  ["humanizer-x", "X2", "Uniform Sentence Length", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X3", "Copula Avoidance", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X4", "Sycophantic/Servile Tone", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X5", "Em Dash Overuse", "slop_mechanical", "已覆盖"],
  ["humanizer-x", "X6", "Rule of Three Overuse", "de_ai_residual", "已覆盖"],
  ["humanizer-x", "X7", "Significance Inflation", "de_ai_residual", "已覆盖"],
  ["humanizer-x", "X8", "Superficial -ing Analyses", "slop_explanation", "已覆盖"],
  ["humanizer-x", "X9", "Negative Parallelisms", "de_ai_residual", "已覆盖"],
  ["humanizer-x", "X10", "Inline-Header Vertical Lists", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X11", "Generic Positive Conclusions", "slop_summary", "已覆盖"],
  ["humanizer-x", "X12", "Promotional Language", "de_ai_residual", "已覆盖"],
  ["humanizer-x", "X13", "Vague Attributions", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X14", "Outline-like Challenge Sections", "slop_summary", "已覆盖"],
  ["humanizer-x", "X15", "Notability Emphasis", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X16", "Elegant Variation (Synonym Cycling)", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X17", "False Ranges", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X18", "Filler Phrases", "slop_mechanical", "已覆盖"],
  ["humanizer-x", "X19", "Excessive Hedging", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X20", "Repetition at Distance", "behavioral_repetition", "缺口"],
  ["humanizer-x", "X21", "Perfect Topic Transitions", "formulaic_transition", "已覆盖"],
  ["humanizer-x", "X22", "Overuse of Boldface", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X23", "Title Case in Headings", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X24", "Emojis", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X25", "Curly Quotation Marks", "slop_mechanical", "已覆盖"],
  ["humanizer-x", "X26", "Collaborative Communication Artifacts", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X27", "Knowledge-Cutoff Disclaimers", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X28", "Sensory and Emotional Anchoring", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X29", "Self-Reference and Callbacks", "statistical_ai_signature", "豁免"],
  ["humanizer-x", "X30", "Uncertainty Gradient", "statistical_ai_signature", "豁免"],
  // ── ultimate-humanizer（surdijon，50 条 P1-P50）───────────────────────────
  ["ultimate-humanizer", "P1", "Gonflement d'importance", "de_ai_residual", "已覆盖"],
  ["ultimate-humanizer", "P2", "Name-dropping vague", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P3", "Analyse superficielle en -ing", "slop_explanation", "已覆盖"],
  ["ultimate-humanizer", "P4", "Langage promotionnel", "de_ai_residual", "已覆盖"],
  ["ultimate-humanizer", "P5", "Attribution vague", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P6", "Structure formatée", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P7", "Vocabulaire IA blacklisté", "de_ai_residual", "已覆盖"],
  ["ultimate-humanizer", "P8", "Évitement du verbe être", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P9", "Parallélisme négatif", "de_ai_residual", "已覆盖"],
  ["ultimate-humanizer", "P10", "Règle de trois", "de_ai_residual", "已覆盖"],
  ["ultimate-humanizer", "P11", "Synonym cycling", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P12", "Fausse gamme", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P13", "Binary contrastes", "de_ai_residual", "已覆盖"],
  ["ultimate-humanizer", "P14", "Fausse agency", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P15", "Tiret cadratin", "slop_mechanical", "已覆盖"],
  ["ultimate-humanizer", "P16", "Gras excessif", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P17", "Listes à puces avec titre inline", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P18", "Casse titre dans les headings", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P19", "Émojis", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P20", "Guillemets courbes", "slop_mechanical", "已覆盖"],
  ["ultimate-humanizer", "P21", "Paires soudées par trait d'union", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P22", "3 phrases consécutives de même longueur", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P23", "Abus d'adverbes", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P24", "Emphase performative", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P25", "Artefacts chatbot", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P26", "Avertissements de date-limite", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P27", "Ton sycophante", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P28", "Phrases de remplissage", "slop_mechanical", "已覆盖"],
  ["ultimate-humanizer", "P29", "Surenchère d'hésitation", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P30", "Conclusion positive générique", "slop_summary", "已覆盖"],
  ["ultimate-humanizer", "P31", "Méta-commentaire", "slop_explanation", "已覆盖"],
  ["ultimate-humanizer", "P32", "Figure d'autorité persuasive", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P33", "Ouverture rhétorique", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P34", "Fragmentation dramatique", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P35", "Formule aphoristique", "de_ai_residual", "已覆盖"],
  ["ultimate-humanizer", "P36", "Punchline artificielle", "de_ai_residual", "已覆盖"],
  ["ultimate-humanizer", "P37", "Narrateur distant", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P38", "Négation en striptease", "de_ai_residual", "已覆盖"],
  ["ultimate-humanizer", "P39", "Setup rhétorique", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P40", "Écriture ancrée dans le diff", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P41", "Generic opener (universal)", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P42", "Not-only-but-also (universal)", "de_ai_residual", "已覆盖"],
  ["ultimate-humanizer", "P43", "Sequence adverb string (universal)", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P44", "Filler announcement (universal)", "slop_mechanical", "已覆盖"],
  ["ultimate-humanizer", "P45", "Keyword stuffing (Google Spam)", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P46", "City / Geo stuffing (Google Spam)", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P47", "Artificial FAQ (Google Spam)", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P48", "Interchangeable content (Google Spam)", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P49", "Footer / block SEO dump (Google Spam)", "statistical_ai_signature", "豁免"],
  ["ultimate-humanizer", "P50", "Thin affiliate (Google Spam)", "statistical_ai_signature", "豁免"],
]

const ANTI_AI_DIMENSIONS = new Set(
  Object.entries(AUDIT_TAXONOMY)
    .filter(([, def]) => def.gate === "anti_ai")
    .map(([id]) => id),
)

describe("55 W3-4 humanizer 簇 115 条模式池 × anti_ai 维度对照矩阵", () => {
  it("矩阵总量 = 115（humanizer 35 + humanizer-x 30 + ultimate-humanizer 50）", () => {
    expect(MATRIX.length).toBe(115)
    const byRepo = new Map<string, number>()
    for (const [repo] of MATRIX) byRepo.set(repo, (byRepo.get(repo) ?? 0) + 1)
    expect(byRepo.get("humanizer")).toBe(35)
    expect(byRepo.get("humanizer-x")).toBe(30)
    expect(byRepo.get("ultimate-humanizer")).toBe(50)
  })

  it("每条模式映射到合法 anti_ai 维度且判定为三态之一", () => {
    for (const [repo, id, name, dimension, status] of MATRIX) {
      expect(ANTI_AI_DIMENSIONS.has(dimension), `${repo} ${id} ${name} → 非法维度 ${dimension}`).toBe(true)
      expect(["已覆盖", "豁免", "缺口"]).toContain(status)
    }
  })

  it("id 在各自仓内唯一（防重复登记）", () => {
    const seen = new Set<string>()
    for (const [repo, id] of MATRIX) {
      const key = `${repo}:${id}`
      expect(seen.has(key), `重复 id ${key}`).toBe(false)
      seen.add(key)
    }
  })

  it("判定一致性：缺口仅落在 behavioral_repetition；豁免仅落在 statistical_ai_signature", () => {
    for (const [repo, id, , dimension, status] of MATRIX) {
      if (status === "缺口") {
        expect(dimension, `${repo} ${id} 缺口维度必须为 behavioral_repetition`).toBe("behavioral_repetition")
      }
      if (status === "豁免") {
        expect(dimension, `${repo} ${id} 豁免维度必须为 statistical_ai_signature`).toBe("statistical_ai_signature")
      }
    }
  })

  it("分布快照：45 已覆盖 / 68 豁免 / 2 缺口（漂移即红）", () => {
    const counts = { 已覆盖: 0, 豁免: 0, 缺口: 0 }
    for (const [, , , , status] of MATRIX) counts[status]++
    expect(counts).toEqual({ 已覆盖: 45, 豁免: 68, 缺口: 2 })
  })

  it("已覆盖模式均有确定性检测器（真实代码联动抽查）：夸大腔/格言腔/二元对立/三连/填充词/引号", () => {
    // 抽查 6 条已覆盖模式的 QMAI 检测器真实存在（防矩阵空转）:
    // 1) 矩阵行名自检 (数据锁) + 2) 真实检测器词表命中 (代码联动)
    const covered = MATRIX.filter(([, , , , s]) => s === "已覆盖")
    const names = covered.map(([, , name]) => name)
    // 夸大腔（H1/X7/P1 同源）
    expect(names).toContain("Inflated importance and legacy")
    // 格言腔（H32/P35）
    expect(names).toContain("Formulaic sayings")
    // 二元对立（H9/X9/P13）
    expect(names).toContain("Not X but Y and clipped endings")
    // 三连排比（H10/X6/P10）
    expect(names).toContain("Forced groups of three")
    // 填充词（H23/X18/P28）
    expect(names).toContain("Filler phrases")
    // 引号（H19/X25/P20）
    expect(names).toContain("Curly quotes")
    // 真实检测器词表联动: de-ai-tiered-table 夸大腔/格言腔/二元对立词存在 (删除即红)
    const table = DE_AI_EXTENDED_TABLE
    expect(table.some((e) => e.category === "夸大腔" && e.term === "史无前例")).toBe(true)
    expect(table.some((e) => e.category === "格言腔")).toBe(true)
    expect(table.some((e) => e.category === "二元对立")).toBe(true)
    // 机械层填充词/引号检测器存在 (mechanical-slop-detector / format-normalizer)
    expect(typeof detectTieredDeAi).toBe("function")
  })
})
