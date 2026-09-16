/**
 * visual-lineage.spec — 波3-A 视觉血缘约定（appliesTo=module:visual）测试。
 * 覆盖：appliesTo 约定复核（挂错面 fail-loud）/ 血缘 schema（来源 ≥1 + 版本
 * 字符串）/ 构建 id 唯一 + 深冻结 / 证据链 refs / 事件落账 / 空血缘零事件。
 */
import { describe, expect, it } from "vitest"
import { PROMPT_ARTIFACT_SCHEMA } from "./prompt-artifacts"
import {
  assertVisualAppliesTo,
  buildVisualLineage,
  VisualLineageError,
  visualLineageEvents,
  visualLineageEvidenceRefs,
  VISUAL_APPLIES_TO,
  VISUAL_ASSET_LINEAGE_SCHEMA,
  type VisualAssetLineage,
} from "./visual-lineage"
import { appendRunEvents, createRunEventLedger, sliceRunEvents } from "./run-event-ledger"

const TS = "2026-09-16T00:00:00.000Z"

function visualPromptArtifact() {
  return PROMPT_ARTIFACT_SCHEMA.parse({
    artifactId: "prompt-visual-character",
    version: "v3",
    template: "依据 {{entryId}} 的 auraSeeds 生成角色立绘",
    appliesTo: "module:visual",
    contentHash: "hash-visual-1",
  })
}

const lineage: VisualAssetLineage = {
  assetId: "asset-hero-01",
  promptArtifactId: "prompt-visual-character",
  promptArtifactVersion: "v3",
  sourceEntryIds: ["arch-hero", "world-sample-7"],
}

describe("assertVisualAppliesTo（appliesTo=module:visual 约定）", () => {
  it("视觉面工件通过；挂错面（gate:/stage:）fail-loud", () => {
    expect(() => assertVisualAppliesTo(visualPromptArtifact())).not.toThrow()
    const wrong = PROMPT_ARTIFACT_SCHEMA.parse({
      artifactId: "prompt-gate-p0",
      version: "v1",
      template: "x",
      appliesTo: "gate:consistency",
      contentHash: "hash-1",
    })
    expect(() => assertVisualAppliesTo(wrong)).toThrow(/module:visual/)
    expect(VISUAL_APPLIES_TO).toBe("module:visual")
  })
})

describe("buildVisualLineage（构建出口）", () => {
  it("schema 校验 + 资产 id 唯一 + 深冻结；来源条目 ≥1 强制", () => {
    const lineages = buildVisualLineage({ lineages: [lineage, { ...lineage, assetId: "asset-hero-02", sourceEntryIds: ["arch-hero"] }] })
    expect(lineages).toHaveLength(2)
    expect(Object.isFrozen(lineages[0])).toBe(true)
    expect(() => buildVisualLineage({ lineages: [lineage, lineage] })).toThrow(/重复/)
    expect(() =>
      VISUAL_ASSET_LINEAGE_SCHEMA.parse({ ...lineage, sourceEntryIds: [] }),
    ).toThrow()
    expect(() =>
      VISUAL_ASSET_LINEAGE_SCHEMA.parse({ ...lineage, promptArtifactVersion: "" }),
    ).toThrow()
  })

  it("证据链 refs：visual + prompt@version + entry 逐条可点开", () => {
    expect(visualLineageEvidenceRefs(lineage)).toEqual([
      "visual:asset-hero-01",
      "prompt:prompt-visual-character@v3",
      "entry:arch-hero",
      "entry:world-sample-7",
    ])
  })
})

describe("visualLineageEvents（事件落账）", () => {
  it("kind=stage + payload.visualLineage + 逐资产证据链；空血缘零事件", () => {
    const events = visualLineageEvents({ lineages: [lineage], ts: TS })
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe("stage")
    expect((events[0]?.payload as { visualLineage?: boolean; count?: number }).count).toBe(1)
    expect(events[0]?.evidenceRefs).toContain("prompt:prompt-visual-character@v3")
    expect(visualLineageEvents({ lineages: [], ts: TS })).toHaveLength(0)
  })

  it("空 ts fail-loud；落账后 stage 切片回读可追溯", () => {
    expect(() => visualLineageEvents({ lineages: [lineage], ts: "" })).toThrow(VisualLineageError)
    const ledger = appendRunEvents(
      createRunEventLedger(),
      visualLineageEvents({ lineages: [lineage], ts: TS }).map((event, i) => ({ ...event, seq: i, eventId: `stage:${i}` }) as never),
    )
    const stages = sliceRunEvents(ledger, { kind: "stage" })
    expect(stages).toHaveLength(1)
    expect((stages[0]?.payload as { assets?: { assetId?: string }[] }).assets?.[0]?.assetId).toBe("asset-hero-01")
  })
})