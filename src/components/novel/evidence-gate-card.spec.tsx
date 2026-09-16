// @vitest-environment jsdom
/**
 * EvidenceGateCards — EB-1 证据链卡片（纯展示）spec。
 * 覆盖：null 快照不渲染 / 三门渲染序 / 未评估不显示为通过 / fail 阻塞条 /
 * 血缘与证据数渲染 / 覆盖率行。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"
import { EvidenceGateCards } from "./evidence-gate-card"
import {
  appendRunEvents,
  buildEvidenceSnapshot,
  createRunEventLedger,
  recordGateRunEvents,
  type EvidenceSnapshot,
  type RunEventInput,
} from "@/lib/novel"

function stageEvent(seq: number): RunEventInput {
  return { seq, eventId: `e${seq}`, ts: "2026-09-12T00:00:00.000Z", kind: "stage", actor: "system" }
}

afterEach(() => cleanup())

describe("EvidenceGateCards（EB-1 展示层）", () => {
  it("null 快照不渲染", () => {
    const { container } = render(<EvidenceGateCards snapshot={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("全未评估：三门渲染为「未评估」，绝不渲染「通过」；无阻塞条", () => {
    const snapshot = buildEvidenceSnapshot({
      gateStatuses: { consistency: undefined, anti_ai: undefined, quality: undefined },
      ledger: createRunEventLedger(),
    })
    render(<EvidenceGateCards snapshot={snapshot} />)
    expect(screen.getAllByText("未评估")).toHaveLength(3)
    expect(screen.queryByText("通过")).toBeNull()
    expect(screen.queryByTestId("evidence-blocked-banner")).toBeNull()
  })

  it("P0 fail：阻塞条显示「被 P0 阻塞」；卡片显示「未通过」与血缘", () => {
    let ledger = createRunEventLedger()
    ledger = recordGateRunEvents(
      ledger,
      [{ gate: "consistency", status: "fail", score: 40 }],
      { ts: "2026-09-12T01:00:00.000Z", promptArtifactId: "pa-consistency", promptArtifactVersion: "1.0.0", replayId: "rp-1", evidenceRefs: ["e1", "e2", "e3"] },
    )
    const snapshot = buildEvidenceSnapshot({
      gateStatuses: { consistency: "fail", anti_ai: "pass", quality: "pass" },
      ledger,
    })
    render(<EvidenceGateCards snapshot={snapshot} />)
    expect(screen.getByTestId("evidence-blocked-banner").textContent).toContain("被 P0 阻塞")
    expect(screen.getByTestId("evidence-card-consistency").textContent).toContain("未通过")
    expect(screen.getByTestId("evidence-card-consistency").textContent).toContain("pa-consistency@1.0.0")
    expect(screen.getByTestId("evidence-card-consistency").textContent).toContain("证据 3")
    // anti_ai 有裁定但无事件 → UI 显示「未评估」（R-04）
    expect(screen.getByTestId("evidence-card-anti_ai").textContent).toContain("未评估")
  })

  it("覆盖率与 token 归因行渲染", () => {
    let ledger = createRunEventLedger()
    ledger = recordGateRunEvents(
      ledger,
      [{ gate: "consistency", status: "pass" }],
      { ts: "2026-09-12T01:00:00.000Z" },
    )
    ledger = appendRunEvents(ledger, [{ ...stageEvent(1), budgetCost: { tokens: 500 } }])
    const snapshot: EvidenceSnapshot = buildEvidenceSnapshot({
      gateStatuses: { consistency: "pass", anti_ai: "pass", quality: "pass" },
      ledger,
    })
    render(<EvidenceGateCards snapshot={snapshot} />)
    const container = screen.getByTestId("evidence-gate-cards")
    expect(container.textContent).toContain("33%")
    expect(container.textContent).toContain("token 500")
  })
})