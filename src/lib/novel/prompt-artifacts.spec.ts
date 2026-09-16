/**
 * prompt-artifacts.spec.ts — 波1 模块 20 提示词工件化 spec 锁定.
 *
 * 覆盖: FNV-1a 身份哈希确定性 + 版本不可变（同版本同 hash 幂等 / 异 hash 拒绝 /
 * 新版本追加 / 原仓库不变）+ 版本解析（最高版本语义）+ 门-提示词血缘绑定 +
 * checkPromptLineageCoverage（LLM 中介门 100% 携带 promptArtifact@version）.
 *
 * @license MIT © QMAI
 */

import { describe, expect, it } from "vitest"
import {
  PromptArtifactRegistryError,
  artifactToEventRefs,
  bindGateRunLineage,
  checkPromptLineageCoverage,
  comparePromptVersions,
  computePromptTemplateHash,
  createPromptArtifactRegistry,
  lineageOfGateRunEvent,
  missingTestRefs,
  registerPromptArtifact,
  resolvePromptArtifact,
  type PromptArtifact,
} from "./prompt-artifacts"
import {
  appendRunEvent,
  createRunEventLedger,
  type RunEventInput,
} from "./run-event-ledger"

function artifact(overrides: Partial<PromptArtifact> = {}): PromptArtifact {
  const template = overrides.template ?? "你是一名{{role}}评审，检查{{aspect}}。"
  return {
    artifactId: overrides.artifactId ?? "pa-consistency",
    version: overrides.version ?? "1.0.0",
    template,
    vars: overrides.vars ?? ["role", "aspect"],
    appliesTo: overrides.appliesTo ?? "gate:consistency",
    modelHint: overrides.modelHint,
    testRefs: overrides.testRefs ?? ["fixture-gate-1"],
    contentHash: overrides.contentHash ?? computePromptTemplateHash(template),
    createdAt: overrides.createdAt ?? "2026-09-12T00:00:00.000Z",
  }
}

function gateRunEvent(seq: number, opts: { llmMediated?: boolean; artifactId?: string; version?: string; eventId?: string }): RunEventInput {
  return {
    seq,
    eventId: opts.eventId ?? `grt-${seq}`,
    ts: "2026-09-12T01:00:00.000Z",
    kind: "gate-run",
    actor: "judge",
    promptArtifactId: opts.artifactId,
    promptArtifactVersion: opts.version,
    payload: { gate: "consistency", status: "fail", llmMediated: opts.llmMediated === true },
  }
}

describe("computePromptTemplateHash（同步确定性身份哈希）", () => {
  it("同输入恒同输出；异输入异输出", () => {
    const a = computePromptTemplateHash("评审模板 A")
    expect(a).toBe(computePromptTemplateHash("评审模板 A"))
    expect(a).not.toBe(computePromptTemplateHash("评审模板 B"))
    expect(a).toMatch(/^fnv1a-[0-9a-f]{8}-len\d+$/)
  })
})

describe("registerPromptArtifact（版本不可变 + 幂等）", () => {
  it("注册返回新仓库，原仓库不变且冻结", () => {
    const r0 = createPromptArtifactRegistry()
    const r1 = registerPromptArtifact(r0, artifact())
    expect(r0.artifacts).toHaveLength(0)
    expect(r1.artifacts).toHaveLength(1)
    expect(Object.isFrozen(r1)).toBe(true)
    expect(Object.isFrozen(r1.artifacts[0])).toBe(true)
    expect(r1.schemaVersion).toBe("prompt-artifacts/1.0")
  })

  it("同 (id,version) 同 hash → 幂等（返回原仓库）", () => {
    const r0 = createPromptArtifactRegistry()
    const a = artifact()
    const r1 = registerPromptArtifact(r0, a)
    expect(registerPromptArtifact(r1, { ...a, createdAt: "2026-09-13T00:00:00.000Z" })).toBe(r1)
  })

  it("同 (id,version) 异 hash → 版本不可变违反拒绝", () => {
    const r1 = registerPromptArtifact(createPromptArtifactRegistry(), artifact())
    expect(() =>
      registerPromptArtifact(r1, artifact({ template: "被篡改的模板", contentHash: "fnv1a-deadbeef-len5" })),
    ).toThrow(PromptArtifactRegistryError)
  })

  it("同 id 新版本 → 追加；schema 违反拒绝", () => {
    let r = registerPromptArtifact(createPromptArtifactRegistry(), artifact({ version: "1.0.0" }))
    r = registerPromptArtifact(r, artifact({ version: "1.1.0" }))
    expect(r.artifacts).toHaveLength(2)
    expect(() => registerPromptArtifact(r, { ...artifact(), artifactId: "" })).toThrow(
      PromptArtifactRegistryError,
    )
  })
})

describe("resolvePromptArtifact（最高版本语义）", () => {
  const r = [
    artifact({ version: "1.0.0" }),
    artifact({ version: "1.10.0" }),
    artifact({ version: "1.2.0" }),
  ].reduce((reg, a) => registerPromptArtifact(reg, a), createPromptArtifactRegistry())

  it("省略 version → 数值段序最高版本（1.10.0 > 1.2.0）", () => {
    expect(resolvePromptArtifact(r, "pa-consistency")?.version).toBe("1.10.0")
    expect(resolvePromptArtifact(r, "pa-consistency", "1.2.0")?.version).toBe("1.2.0")
    expect(resolvePromptArtifact(r, "nope")).toBeNull()
  })

  it("comparePromptVersions：数值段比较，非数值回退字典序", () => {
    expect(comparePromptVersions("1.2.0", "1.10.0")).toBeLessThan(0)
    expect(comparePromptVersions("2.0.0", "1.9.9")).toBeGreaterThan(0)
    expect(comparePromptVersions("1.0.0-beta", "1.0.0")).toBeLessThan(0)
    expect(comparePromptVersions("1.0.0", "1.0.0")).toBe(0)
  })
})

describe("门-提示词血缘（EB-1 必要条件）", () => {
  it("bindGateRunLineage 记录 verdict + 工件 id@version + contentHash", () => {
    const a = artifact()
    const lineage = bindGateRunLineage({ gate: "consistency", verdict: "fail", artifact: a })
    expect(lineage).toEqual({
      gate: "consistency",
      verdict: "fail",
      artifactId: a.artifactId,
      artifactVersion: a.version,
      contentHash: a.contentHash,
    })
    expect(artifactToEventRefs(a)).toEqual({
      promptArtifactId: "pa-consistency",
      promptArtifactVersion: "1.0.0",
    })
  })

  it("coverage：LLM 中介门 100% 绑定 → rate=1；缺血缘 → unbound 清单 + rate<1", () => {
    let ledger = createRunEventLedger()
    ledger = appendRunEvent(ledger, gateRunEvent(0, { llmMediated: true, artifactId: "pa-consistency", version: "1.0.0" }))
    ledger = appendRunEvent(ledger, gateRunEvent(1, { llmMediated: true }))
    const cov = checkPromptLineageCoverage(ledger)
    expect(cov.llmMediatedGateRuns).toBe(2)
    expect(cov.bound).toBe(1)
    expect(cov.unbound).toEqual([{ seq: 1, eventId: "grt-1" }])
    expect(cov.rate).toBe(0.5)
  })

  it("机械门（llmMediated 非 true）不参与血缘约束", () => {
    let ledger = createRunEventLedger()
    ledger = appendRunEvent(ledger, gateRunEvent(0, { llmMediated: false }))
    const cov = checkPromptLineageCoverage(ledger)
    expect(cov.llmMediatedGateRuns).toBe(0)
    expect(cov.rate).toBe(1)
  })

  it("replayId 过滤下血缘覆盖只看同链事件", () => {
    let ledger = createRunEventLedger()
    ledger = appendRunEvent(ledger, gateRunEvent(0, { llmMediated: true }))
    const unbound = { ...gateRunEvent(1, { llmMediated: true }), replayId: "rp-1" }
    ledger = appendRunEvent(ledger, unbound)
    const cov = checkPromptLineageCoverage(ledger, { replayId: "rp-1" })
    expect(cov.llmMediatedGateRuns).toBe(1)
    expect(cov.rate).toBe(0)
  })

  it("lineageOfGateRunEvent：从事件+仓库恢复血缘记录", () => {
    const reg = registerPromptArtifact(createPromptArtifactRegistry(), artifact())
    let ledger = createRunEventLedger()
    ledger = appendRunEvent(ledger, gateRunEvent(0, { llmMediated: true, artifactId: "pa-consistency", version: "1.0.0" }))
    const lineage = lineageOfGateRunEvent(ledger.events[0], reg)
    expect(lineage?.artifactId).toBe("pa-consistency")
    expect(lineage?.contentHash).toBe(artifact().contentHash)
    expect(lineageOfGateRunEvent(ledger.events[0], createPromptArtifactRegistry())?.contentHash).toBe("")
  })

  it("missingTestRefs 列出无回归挂点的工件", () => {
    let reg = registerPromptArtifact(createPromptArtifactRegistry(), artifact())
    reg = registerPromptArtifact(reg, artifact({ artifactId: "pa-title", version: "1.0.0", testRefs: [] }))
    expect(missingTestRefs(reg)).toEqual(["pa-title@1.0.0"])
  })
})