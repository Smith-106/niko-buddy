/**
 * evidence-dashboard-section.spec — 波2-D 首页仪表盘证据区组件测试（jsdom）。
 * 覆盖：注入账本渲染三门卡（P0 fail 阻塞条+未通过）/ 全未评估（空账本诚实面）/
 * 磁盘装载（deps 注入 memoryDeps）/ 装载失败 → 未评估不臆造 / null 预览态。
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
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
// ── statements 补测：显式 null 预览态 + 切换 projectId 后的陈旧装载隔离 ──
type DeferredRead = {
  path: string
  resolve: (value: string | null) => void
  reject: (error: unknown) => void
}

function deferredDeps() {
  const pending: DeferredRead[] = []
  const deps: RunEventLedgerStoreDeps = {
    readText: (path) =>
      new Promise<string | null>((resolve, reject) => {
        pending.push({ path, resolve, reject })
      }),
    appendText: async () => {},
  }
  return { deps, pending }
}

const jsonl = (...events: RunEventInput[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n"

describe("EvidenceDashboardSection — 预览态与陈旧装载隔离", () => {
  it("显式 ledger=null：不读磁盘、不落装载中/失败态（预览态）", async () => {
    const readText = vi.fn(async () => {
      throw new Error("预览态不应触盘")
    })
    render(
      <EvidenceDashboardSection
        projectId="p-preview"
        ledger={null}
        deps={{ readText, appendText: async () => {} }}
      />,
    )
    // 预览态：跳过磁盘装载，effect 完成后不再显示“装载中”，也不显示失败面/门卡
    await waitFor(() => expect(screen.queryByTestId("evidence-dashboard-loading")).toBeNull())
    expect(screen.getByTestId("evidence-dashboard-section")).toBeTruthy()
    expect(screen.queryByTestId("evidence-gate-cards")).toBeNull()
    expect(screen.queryByTestId("evidence-dashboard-failed")).toBeNull()
    expect(readText).not.toHaveBeenCalled()
  })

  it("切换 projectId 后旧装载才返回：不覆盖新账本", async () => {
    const { deps, pending } = deferredDeps()
    const { rerender } = render(<EvidenceDashboardSection projectId="p-slow" deps={deps} />)
    await waitFor(() => expect(pending).toHaveLength(1))

    rerender(<EvidenceDashboardSection projectId="p-fast" deps={deps} />)
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[1]?.path).toContain("p-fast")

    // 新项目先返回：anti_ai 通过
    await act(async () => {
      pending[1]?.resolve(jsonl(gateRun(0, "anti_ai", "pass")))
    })
    await screen.findByTestId("evidence-gate-cards")
    expect(screen.getByTestId("evidence-card-anti_ai").textContent).toContain("通过")

    // 旧项目后返回：consistency 通过——必须被 cancelled 守卫丢弃
    await act(async () => {
      pending[0]?.resolve(jsonl(gateRun(0, "consistency", "pass")))
    })
    expect(screen.getByTestId("evidence-card-anti_ai").textContent).toContain("通过")
    expect(screen.getByTestId("evidence-card-consistency").textContent).toContain("未评估")
  })

  it("切换 projectId 后旧装载才失败：不把首页翻成失败态", async () => {
    const { deps, pending } = deferredDeps()
    const { rerender } = render(<EvidenceDashboardSection projectId="p-slow" deps={deps} />)
    await waitFor(() => expect(pending).toHaveLength(1))

    rerender(<EvidenceDashboardSection projectId="p-fast" deps={deps} />)
    await waitFor(() => expect(pending).toHaveLength(2))

    await act(async () => {
      pending[1]?.resolve(jsonl(gateRun(0, "quality", "pass")))
    })
    await screen.findByTestId("evidence-gate-cards")
    expect(screen.getByTestId("evidence-card-quality").textContent).toContain("通过")

    await act(async () => {
      pending[0]?.reject(new Error("stale boom"))
    })
    expect(screen.queryByTestId("evidence-dashboard-failed")).toBeNull()
    expect(screen.getByTestId("evidence-card-quality").textContent).toContain("通过")
  })
})

describe("EvidenceDashboardSection — 生产 deps 路径", () => {
  it("未注入 deps：走生产 deps（读不到账本 → 空账本诚实面）", async () => {
    render(<EvidenceDashboardSection projectId="p-prod" />)
    // jsdom 无 Tauri fs：生产 deps 的 readText 把读取异常吞成 null → 空账本
    // → 三门「未评估」而非「通过」，也不落失败面（失败面只给 store 契约上抛）
    const cards = await screen.findByTestId("evidence-gate-cards", undefined, { timeout: 5000 })
    expect(cards).toBeTruthy()
    expect(screen.getByTestId("evidence-card-consistency").textContent).toContain("未评估")
    expect(screen.getByTestId("evidence-card-anti_ai").textContent).toContain("未评估")
    expect(screen.queryByTestId("evidence-dashboard-failed")).toBeNull()
    expect(screen.queryByTestId("evidence-blocked-banner")).toBeNull()
  }, 15000)
})
