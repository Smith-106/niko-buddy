/**
 * prompt-artifacts.branch.spec.ts — 分支覆盖专项（覆盖率战役第九批）。
 * 增补 prompt-artifacts.spec.ts 未覆盖的分支臂：compare 版本段 ??/非数值段/双后缀、
 * resolve 未命中版本、coverage 守卫（非 gate-run / 无 payload / 非 LLM / 半血缘 /
 * 空 match）、lineage 守卫六路 null + pass 臂。
 */
import { describe, expect, it } from "vitest"
import {
  checkPromptLineageCoverage,
  comparePromptVersions,
  computePromptTemplateHash,
  createPromptArtifactRegistry,
  lineageOfGateRunEvent,
  registerPromptArtifact,
  resolvePromptArtifact,
  type PromptArtifact,
} from "./prompt-artifacts"
import {
  appendRunEvent,
  createRunEventLedger,
} from "./run-event-ledger"

function artifact(overrides: Partial<PromptArtifact> = {}): PromptArtifact {
  const template = overrides.template ?? "分支补覆盖模板{{x}}。"
  return {
    artifactId: overrides.artifactId ?? "pa-branch",
    version: overrides.version ?? "1.0.0",
    template,
    vars: overrides.vars ?? [],
    appliesTo: overrides.appliesTo ?? "gate:consistency",
    modelHint: overrides.modelHint,
    testRefs: overrides.testRefs ?? ["fixture-branch-1"],
    contentHash: overrides.contentHash ?? computePromptTemplateHash(template),
    createdAt: overrides.createdAt ?? "2026-09-12T00:00:00.000Z",
  }
}

describe("comparePromptVersions 未覆盖臂", () => {
  it("段数不等触发 ?? 空段：1.0 < 1.0.0，且反向 > 0", () => {
    expect(comparePromptVersions("1.0", "1.0.0")).toBeLessThan(0)
    expect(comparePromptVersions("1.0.0", "1.0")).toBeGreaterThan(0)
  })

  it("非数值段回退字典序：alpha < beta；相等段继续到 0", () => {
    expect(comparePromptVersions("alpha", "beta")).toBeLessThan(0)
    expect(comparePromptVersions("beta", "alpha")).toBeGreaterThan(0)
    expect(comparePromptVersions("alpha", "alpha")).toBe(0)
  })

  it("数值段 vs 非数值段走回退臂", () => {
    expect(comparePromptVersions("1", "beta")).toBeLessThan(0)
    expect(comparePromptVersions("beta", "1")).toBeGreaterThan(0)
  })

  it("正式段 > 预发布段：1.0.0 > 1.0.0-beta（sufA 为空真臂）", () => {
    expect(comparePromptVersions("1.0.0", "1.0.0-beta")).toBeGreaterThan(0)
  })

  it("双预发布后缀字典序双向", () => {
    expect(comparePromptVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0)
    expect(comparePromptVersions("1.0.0-beta", "1.0.0-alpha")).toBeGreaterThan(0)
    expect(comparePromptVersions("1.0.0-beta", "1.0.0-beta")).toBe(0)
  })
})

describe("resolvePromptArtifact 未命中版本臂", () => {
  it("指定不存在的 version → null（?? 右臂）", () => {
    const reg = registerPromptArtifact(createPromptArtifactRegistry(), artifact())
    expect(resolvePromptArtifact(reg, "pa-branch", "9.9.9")).toBeNull()
    expect(resolvePromptArtifact(reg, "pa-branch", "1.0.0")?.version).toBe("1.0.0")
  })
})

describe("checkPromptLineageCoverage 守卫臂", () => {
  it("非 gate-run / 无 payload / 非 LLM 一律跳过；半血缘进 unbound", () => {
    let ledger = createRunEventLedger()
    ledger = appendRunEvent(ledger, {
      seq: 0, eventId: "b-retrieval", ts: "2026-09-12T01:00:00.000Z",
      kind: "retrieval", actor: "judge", payload: { llmMediated: true },
    })
    ledger = appendRunEvent(ledger, {
      seq: 1, eventId: "b-nopayload", ts: "2026-09-12T01:00:00.000Z",
      kind: "gate-run", actor: "judge",
    })
    ledger = appendRunEvent(ledger, {
      seq: 2, eventId: "b-nonllm", ts: "2026-09-12T01:00:00.000Z",
      kind: "gate-run", actor: "judge", payload: { gate: "consistency", status: "fail" },
    })
    ledger = appendRunEvent(ledger, {
      seq: 3, eventId: "b-half-id", ts: "2026-09-12T01:00:00.000Z",
      kind: "gate-run", actor: "judge",
      promptArtifactId: "pa-branch",
      payload: { gate: "consistency", status: "fail", llmMediated: true },
    })
    ledger = appendRunEvent(ledger, {
      seq: 4, eventId: "b-half-ver", ts: "2026-09-12T01:00:00.000Z",
      kind: "gate-run", actor: "judge",
      promptArtifactVersion: "1.0.0",
      payload: { gate: "consistency", status: "fail", llmMediated: true },
    })
    const cov = checkPromptLineageCoverage(ledger)
    expect(cov.llmMediatedGateRuns).toBe(2)
    expect(cov.bound).toBe(0)
    expect(cov.unbound).toEqual([
      { seq: 3, eventId: "b-half-id" },
      { seq: 4, eventId: "b-half-ver" },
    ])
    expect(cov.rate).toBe(0)
  })

  it("空 match 对象与省略 match 等价（replayId 未定义臂）", () => {
    let ledger = createRunEventLedger()
    ledger = appendRunEvent(ledger, {
      seq: 0, eventId: "b-m0", ts: "2026-09-12T01:00:00.000Z",
      kind: "gate-run", actor: "judge", payload: { gate: "consistency", status: "fail", llmMediated: true },
    })
    expect(checkPromptLineageCoverage(ledger, {})).toEqual(checkPromptLineageCoverage(ledger))
  })
})

describe("lineageOfGateRunEvent 守卫六路 null + pass 臂", () => {
  it("六路非法输入 → null", () => {
    const reg = registerPromptArtifact(createPromptArtifactRegistry(), artifact())
    let ledger = createRunEventLedger()
    ledger = appendRunEvent(ledger, {
      seq: 0, eventId: "l-retrieval", ts: "2026-09-12T01:00:00.000Z",
      kind: "retrieval", actor: "judge", payload: { gate: "consistency", status: "pass" },
    })
    ledger = appendRunEvent(ledger, {
      seq: 1, eventId: "l-noids", ts: "2026-09-12T01:00:00.000Z",
      kind: "gate-run", actor: "judge", payload: { gate: "consistency", status: "pass", llmMediated: true },
    })
    ledger = appendRunEvent(ledger, {
      seq: 2, eventId: "l-novers", ts: "2026-09-12T01:00:00.000Z",
      kind: "gate-run", actor: "judge",
      promptArtifactId: "pa-branch",
      payload: { gate: "consistency", status: "pass", llmMediated: true },
    })
    ledger = appendRunEvent(ledger, {
      seq: 3, eventId: "l-nopayload", ts: "2026-09-12T01:00:00.000Z",
      kind: "gate-run", actor: "judge",
      promptArtifactId: "pa-branch", promptArtifactVersion: "1.0.0",
    })
    ledger = appendRunEvent(ledger, {
      seq: 4, eventId: "l-badgate", ts: "2026-09-12T01:00:00.000Z",
      kind: "gate-run", actor: "judge",
      promptArtifactId: "pa-branch", promptArtifactVersion: "1.0.0",
      payload: { gate: 123, status: "pass" },
    })
    ledger = appendRunEvent(ledger, {
      seq: 5, eventId: "l-badstatus", ts: "2026-09-12T01:00:00.000Z",
      kind: "gate-run", actor: "judge",
      promptArtifactId: "pa-branch", promptArtifactVersion: "1.0.0",
      payload: { gate: "consistency", status: "weird" },
    })
    for (const event of ledger.events) {
      expect(lineageOfGateRunEvent(event, reg)).toBeNull()
    }
  })

  it("status pass 走通（!== pass 假臂）并携带仓库 contentHash", () => {
    const reg = registerPromptArtifact(createPromptArtifactRegistry(), artifact())
    let ledger = createRunEventLedger()
    ledger = appendRunEvent(ledger, {
      seq: 0, eventId: "l-pass", ts: "2026-09-12T01:00:00.000Z",
      kind: "gate-run", actor: "judge",
      promptArtifactId: "pa-branch", promptArtifactVersion: "1.0.0",
      payload: { gate: "consistency", status: "pass", llmMediated: true },
    })
    const lineage = lineageOfGateRunEvent(ledger.events[0]!, reg)
    expect(lineage?.verdict).toBe("pass")
    expect(lineage?.artifactId).toBe("pa-branch")
    expect(lineage?.contentHash).toBe(artifact().contentHash)
  })
})
