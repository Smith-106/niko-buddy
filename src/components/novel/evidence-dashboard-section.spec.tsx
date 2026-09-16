/**
 * evidence-dashboard-section.spec — 波2-D 首页仪表盘证据区组件测试（jsdom）。
 * 覆盖：注入账本渲染三门卡（P0 fail 阻塞条+未通过）/ 全未评估（空账本诚实面）/
 * 磁盘装载（deps 注入 memoryDeps）/ 装载失败 → 未评估不臆造 / null 预览态。
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { appendRunEvents, createRunEventLedger, type RunEventInput } from "@/lib/novel"
import type { RunEventLedgerStoreDeps } from "@/lib/novel"
import { EvidenceDashboardSection } from "./evidence-dashboard-section"

const TS = "2026-09-16T00:00:00.000Z"

function gateRun(seq: number, gate: string, status: "pass" | "fail" | "skipped", extra?: Partial<RunEventInput>): RunEventInput {
  return {
    seq,
    eventId: `gate-run:${seq}:${gate}`,
    ts: TS,
    kind: "gate-run",
    actor: "system",
    payload: { gate, status },
    ...extra,
  }
}

function ledgerWith(...events: RunEventInput[]) {
  return appendRunEvents(createRunEventLedger(), events)
}

afterEach(() => cleanup())

function memoryDeps(files: Map<string, string>): RunEventLedgerStoreDeps {
  return {
    readText: async (path) => files.get(path) ?? null,
    appendText: async (path, text) => {
      files.set(path, (files.get(path) ?? "") + text)
    },
  }
}

describe("EvidenceDashboardSection（首页证据区接线）", () => {
  it("注入账本：P0 fail 渲染阻塞条 + 未通过卡 + 覆盖率", () => {
    const ledger = ledgerWith(
      gateRun(0, "consistency", "fail", { evidenceRefs: ["w:1"] }),
      gateRun(1, "anti_ai", "pass"),
      gateRun(2, "quality", "pass"),
    )
    render(<EvidenceDashboardSection projectId="p-1" ledger={ledger} />)
    expect(screen.getByTestId("evidence-gate-cards")).toBeTruthy()
    expect(screen.getByTestId("evidence-blocked-banner").textContent).toContain("P0")
    expect(screen.getByTestId("evidence-card-consistency").textContent).toContain("未通过")
    expect(screen.getByTestId("evidence-card-anti_ai").textContent).toContain("通过")
  })

  it("空账本注入：三门未评估（R-04 诚实面）、无阻塞条", () => {
    render(<EvidenceDashboardSection projectId="p-1" ledger={createRunEventLedger()} />)
    expect(screen.getByTestId("evidence-card-consistency").textContent).toContain("未评估")
    expect(screen.queryByTestId("evidence-blocked-banner")).toBeNull()
  })

  it("磁盘装载（deps 注入）：JSONL 文件 → 渲染门状态", async () => {
    const files = new Map<string, string>()
    const lines = [
      gateRun(0, "consistency", "pass"),
      gateRun(1, "anti_ai", "fail", { bookId: "b1" }),
      gateRun(2, "quality", "skipped"),
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")
    files.set("C:/proj/p-2/.novel/run-events.jsonl", lines + "\n")
    render(<EvidenceDashboardSection projectId="C:/proj/p-2" deps={memoryDeps(files)} />)
    // 异步装载后断言（findBy*）
    const cards = await screen.findByTestId("evidence-gate-cards", undefined, { timeout: 2000 })
    expect(cards).toBeTruthy()
    expect(screen.getByTestId("evidence-blocked-banner").textContent).toContain("P1")
    expect(screen.getByTestId("evidence-card-consistency").textContent).toContain("通过")
    expect(screen.getByTestId("evidence-card-anti_ai").textContent).toContain("未通过")
  })

  it("装载失败 → 未评估语义（INV-7 诚实面，不臆造通过）", async () => {
    const failing: RunEventLedgerStoreDeps = {
      readText: async () => {
        throw new Error("disk offline")
      },
      appendText: async () => {},
    }
    render(<EvidenceDashboardSection projectId="p-3" deps={failing} />)
    await screen.findByTestId("evidence-card-consistency", undefined, { timeout: 2000 })
    expect(screen.getByTestId("evidence-card-consistency").textContent).toContain("未评估")
    expect(screen.queryByTestId("evidence-blocked-banner")).toBeNull()
  })
})