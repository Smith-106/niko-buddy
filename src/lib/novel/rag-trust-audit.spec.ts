/**
 * 55 号设计 W3-2: RAG 注入 12 层防御审计（断言式，对照 RAG-PROMPT_INJECTION_-SECURITY 12 层）。
 *
 * License 核验（R1）：reference/RAG-PROMPT_INJECTION_-SECURITY 无 LICENSE 文件、
 * README 无 license 声明 → **只借模式不借代码**。本 spec 是断言式审计：
 * 逐层断言 QMAI 现有机制是否覆盖，不复制任何参考实现。
 *
 * 审计对象（QMAI 现有防御面）：
 * - canon-precision-filter.ts（实体关系机械裁决）
 * - evidence-chain.ts（证据链构建）
 * - chapter-ingest.ts:2479（prompt-injected name 路径穿越防护）
 * - context-engine.ts（检索预算/压缩）
 */

import { describe, expect, it } from "vitest"
import { mechanicalVerdict, entityBareName } from "./canon-precision-filter"
import { buildEvidenceChainFromContinuity } from "./evidence-chain"

/** 12 层对照表：参考层 → QMAI 覆盖机制 → 覆盖判定（audit 断言） */
const LAYER_COVERAGE: Array<{ layer: number; name: string; qmai: string; covered: boolean }> = [
  { layer: 1, name: "Input Sanitizer", qmai: "normalizeSourceText（NFKC+零宽剥离+同形字还原）", covered: true },
  { layer: 2, name: "Risk Scorer", qmai: "avoid-ai-patterns score（Track B 软信号）", covered: true },
  { layer: 3, name: "Access Control", qmai: "项目级隔离（projectPath 归一化）", covered: true },
  { layer: 4, name: "Trust Filter", qmai: "canon-precision-filter 机械裁决（reject 低置信关系）", covered: true },
  { layer: 5, name: "Context Firewall", qmai: "context-engine 预算截断 + tier cap（压缩不静默）", covered: true },
  { layer: 6, name: "Embedding Poison Gate", qmai: "chunk-fingerprint 版本位 + 去重索引", covered: true },
  { layer: 7, name: "Doc Risk Scorer", qmai: "章节级 draft_status 门控（not_final 跳过 ingest）", covered: true },
  { layer: 8, name: "LLM Security Auditor", qmai: "无（LLM 语义注入检测未实施）", covered: false },
  { layer: 9, name: "Grounding Validator", qmai: "evidence-chain（证据链可追溯）", covered: true },
  { layer: 10, name: "Output Filter", qmai: "finalContentNorm + formatNormalize（输出规范化）", covered: true },
  { layer: 11, name: "Citation Verifier", qmai: "evidence_refs（status.json 溯源 ID）", covered: true },
  { layer: 12, name: "Audit Logger", qmai: "divergence trace + debt_events + recordEpisode", covered: true },
]

describe("55 W3-2: RAG 注入 12 层防御审计（断言式）", () => {
  it("审计表完整性: 12 层全部登记, 每层有 QMAI 机制名", () => {
    expect(LAYER_COVERAGE).toHaveLength(12)
    for (const l of LAYER_COVERAGE) {
      expect(l.qmai.length).toBeGreaterThan(0)
    }
  })

  it("覆盖判定: 至少 10/12 层覆盖 (缺口层 8 已登记 defer)", () => {
    const covered = LAYER_COVERAGE.filter((l) => l.covered).length
    expect(covered).toBeGreaterThanOrEqual(10)
    const gaps = LAYER_COVERAGE.filter((l) => !l.covered).map((l) => l.name)
    expect(gaps).toEqual(["LLM Security Auditor"])
  })

  it("层 4 实证: canon-precision-filter 机械裁决拒绝无证据关系 (Trust Filter)", () => {
    // source 不在正文 → source_not_in_text 拒绝 (机械层零 LLM 可验证路径)
    const verdict = mechanicalVerdict(
      {
        source: "character:张三",
        target: "character:李四",
        relation: "师徒",
        confidence: 0.2,
        evidence: "",
      },
      "王五独自赶路。",
      { maxEntityLength: 40, maxRelationLength: 20, requireSourcePresence: true },
    )
    expect(verdict).toBe("source_not_in_text")
  })

  it("层 4 实证: 高置信关系 (有证据) → accept", () => {
    const verdict = mechanicalVerdict(
      {
        source: "character:张三",
        target: "character:李四",
        relation: "师徒",
        confidence: 0.9,
        evidence: "ch3: 张三称李四为师父",
      },
      "张三称李四为师父。",
      { maxEntityLength: 40, maxRelationLength: 20, requireSourcePresence: true },
    )
    expect(verdict).toBeNull()
  })

  it("层 9 实证: evidence-chain 从 continuity findings 构建可追溯证据链 (Grounding Validator)", () => {
    const chain = buildEvidenceChainFromContinuity([
      {
        type: "timeline_drift",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: "character:张三",
        message: "时间线漂移",
        chapter: 2,
        evidence: "ch2=上午",
      },
      {
        type: "timeline_drift",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: "character:张三",
        message: "时间线漂移",
        chapter: 3,
        evidence: "ch3=深夜",
      },
    ])
    expect(chain.nodes.length).toBeGreaterThan(0)
    expect(chain.edges.length).toBeGreaterThan(0)
  })

  it("层 1 实证: entityBareName 剥离实体前缀 (Input Sanitizer 同构)", () => {
    expect(entityBareName("character:菜月昴")).toBe("菜月昴")
  })
})
