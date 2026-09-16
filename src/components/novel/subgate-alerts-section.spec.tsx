/**
 * subgate-alerts-section.spec — 波2-E 子门/告警可见区组件测试（jsdom，G-14）。
 * 覆盖：注入账本渲染三类项（子门/告警/反事实）/ 空记录显式提示 / 磁盘装载
 * （deps 注入）/ 装载失败提示。
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import {
  appendRunEvents,
  createRunEventLedger,
  type RunEventInput,
  type RunEventLedgerStoreDeps,
} from "@/lib/novel"
import { SubgateAlertsSection } from "./subgate-alerts-section"

const TS = "2026-09-16T00:00:00.000Z"

afterEach(() => cleanup())

function stage(seq: number, payload: Record<string, unknown>, extra?: Partial<RunEventInput>): RunEventInput {
  return { seq, eventId: `stage:${seq}`, ts: TS, kind: "stage", actor: "system", payload, ...extra }
}

function memoryDeps(files: Map<string, string>): RunEventLedgerStoreDeps {
  return {
    readText: async (path) => files.get(path) ?? null,
    appendText: async (path, text) => {
      files.set(path, (files.get(path) ?? "") + text)
    },
  }
}

describe("SubgateAlertsSection（G-14 子门/告警可见区）", () => {
  it("注入账本：子门/告警/反事实三类项渲染 + 类别标签", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      stage(0, { subGate: "cross-form-derivation", verdict: "fail", form: "comic" }),
      stage(1, { alert: "voice-drift", drift: 0.8, chapterId: 3 }),
      stage(2, { counterfactual: { gate: "anti_ai", decisiveSourceIds: ["e1", "e2"] } }, { replayId: "rp" }),
    ])
    render(<SubgateAlertsSection projectId="p-1" ledger={ledger} />)
    const list = screen.getByTestId("subgate-alerts-list")
    expect(list).toBeTruthy()
    expect(screen.getByTestId("subgate-item-stage:2").textContent).toContain("反事实")
    expect(screen.getByTestId("subgate-item-stage:2").textContent).toContain("决定性证据=2")
    expect(screen.getByTestId("subgate-item-stage:0").textContent).toContain("子门")
    expect(screen.getByTestId("subgate-item-stage:0").textContent).toContain("裁定=fail (comic)")
    expect(screen.getByTestId("subgate-item-stage:1").textContent).toContain("告警")
    expect(screen.getByTestId("subgate-item-stage:1").textContent).toContain("漂移=0.8")
    cleanup()
  })

  it("空账本 → 显式暂无记录（零候选合法）；null 预览态同样", () => {
    render(<SubgateAlertsSection projectId="p-1" ledger={createRunEventLedger()} />)
    expect(screen.getByTestId("subgate-alerts-empty").textContent).toContain("暂无")
    cleanup()
    render(<SubgateAlertsSection projectId="p-1" ledger={null} />)
    expect(screen.getByTestId("subgate-alerts-empty")).toBeTruthy()
    cleanup()
  })

  it("磁盘装载（deps 注入 JSONL）→ 渲染；装载失败 → failed 提示", async () => {
    const files = new Map<string, string>()
    const lines = [stage(0, { subGate: "vis-cont", pairsChecked: 2, findings: [] })]
      .map((event) => JSON.stringify(event))
      .join("\n")
    files.set("C:/proj/p-2/.novel/run-events.jsonl", lines + "\n")
    render(<SubgateAlertsSection projectId="C:/proj/p-2" deps={memoryDeps(files)} />)
    await screen.findByTestId("subgate-alerts-list", undefined, { timeout: 2000 })
    expect(screen.getByTestId("subgate-item-stage:0").textContent).toContain("vis-cont")
    cleanup()

    const failing: RunEventLedgerStoreDeps = {
      readText: async () => {
        throw new Error("disk offline")
      },
      appendText: async () => {},
    }
    render(<SubgateAlertsSection projectId="p-3" deps={failing} />)
    await screen.findByTestId("subgate-alerts-failed", undefined, { timeout: 2000 })
    cleanup()
  })
})