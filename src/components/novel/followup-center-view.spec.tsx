// @vitest-environment jsdom
/**
 * followup-center-view.spec — 导演跟进中心视图组件测试（jsdom）。
 * 覆盖：空态诚实面（followup-empty，不渲染任务/阻塞区）/ 返修分组与单条
 * 完成-忽略 / 阻塞队列 gate-优先级-blockedBy + 阻塞横幅 / 批量操作
 * （一键完成全部待处理、清空已解决含章节审查条目）/ 章节审查条目渲染与
 * 标记完成 / 磁盘装载（deps 注入）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import {
  appendRunEvents,
  createRunEventLedger,
  type RunEventInput,
  type RunEventLedgerStoreDeps,
} from "@/lib/novel"
import { useReviewStore, type NovelReviewEntry, type ReviewItem } from "@/stores/review-store"
import { FollowupCenterView } from "./followup-center-view"

const TS = "2026-09-16T00:00:00.000Z"

afterEach(() => cleanup())

beforeEach(() => {
  useReviewStore.setState({ items: [], novelReviewEntries: [] })
})

function gateRun(seq: number, gate: string, status: "pass" | "fail" | "skipped"): RunEventInput {
  return {
    seq,
    eventId: `gate-run:${seq}:${gate}`,
    ts: TS,
    kind: "gate-run",
    actor: "system",
    payload: { gate, status },
  }
}

function makeItem(id: string, title: string, resolved: boolean): ReviewItem {
  return {
    id,
    type: "suggestion",
    title,
    description: `${title}说明`,
    options: [{ label: "接受", action: "accept" }],
    resolved,
    createdAt: 1700000000000,
  }
}

function makeEntry(id: string, chapterNumber: number, resolved: boolean): NovelReviewEntry {
  return {
    id,
    chapterNumber,
    results: [
      {
        severity: "error",
        type: "continuity",
        message: "时间线矛盾",
        evidence: "第三章开头…",
        relatedMemory: "",
        suggestion: "补一段过渡",
      },
    ],
    createdAt: TS,
    resolved,
  }
}

describe("FollowupCenterView（导演跟进中心）", () => {
  it("空态：返修与阻塞均为空 → 诚实空态，不渲染任务/阻塞区", () => {
    render(<FollowupCenterView projectPath="test-proj" ledger={createRunEventLedger()} />)
    expect(screen.getByTestId("followup-center-view")).toBeTruthy()
    expect(screen.getByTestId("followup-empty").textContent).toContain("暂无跟进任务")
    expect(screen.queryByTestId("followup-items")).toBeNull()
    expect(screen.queryByTestId("followup-blocking")).toBeNull()
  })

  it("返修分组：待处理/已解决分组渲染，单条完成/忽略直写 store", () => {
    useReviewStore.setState({
      items: [makeItem("item-a", "补写第三章过渡", false), makeItem("item-b", "统一人物称谓", true)],
    })
    render(<FollowupCenterView projectPath="test-proj" ledger={createRunEventLedger()} />)
    expect(screen.getByTestId("followup-items").textContent).toContain("待处理")
    expect(screen.getByTestId("followup-item-item-a")).toBeTruthy()
    expect(screen.getByTestId("followup-item-item-b").textContent).toContain("已解决")

    fireEvent.click(screen.getByTestId("followup-resolve-item-a"))
    expect(useReviewStore.getState().items.find((item) => item.id === "item-a")?.resolved).toBe(true)

    fireEvent.click(screen.getByTestId("followup-dismiss-item-b"))
    expect(useReviewStore.getState().items.some((item) => item.id === "item-b")).toBe(false)
  })

  it("阻塞队列：gate/优先级/blockedBy 按 P0→P1 渲染 + 阻塞横幅，通过门不进队列", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "consistency", "fail"),
      gateRun(1, "anti_ai", "fail"),
      gateRun(2, "quality", "pass"),
    ])
    render(<FollowupCenterView projectPath="test-proj" ledger={ledger} />)
    expect(screen.getByTestId("followup-blocking")).toBeTruthy()
    expect(screen.getByTestId("followup-blocked-banner").textContent).toContain("一致性")
    expect(screen.queryByTestId("followup-empty")).toBeNull()

    const p0 = screen.getByTestId("followup-blocking-item-consistency").textContent ?? ""
    expect(p0).toContain("P0")
    expect(p0).toContain("首要阻塞")
    const p1 = screen.getByTestId("followup-blocking-item-anti_ai").textContent ?? ""
    expect(p1).toContain("P1")
    expect(p1).toContain("被一致性门阻塞")
    expect(screen.queryByTestId("followup-blocking-item-quality")).toBeNull()
  })

  it("批量操作：一键完成全部待处理 + 清空已解决（含章节审查条目）", () => {
    useReviewStore.setState({
      items: [makeItem("item-a", "补过渡", false), makeItem("item-b", "修错字", false)],
      novelReviewEntries: [makeEntry("entry-1", 3, false)],
    })
    render(<FollowupCenterView projectPath="test-proj" ledger={createRunEventLedger()} />)

    fireEvent.click(screen.getByTestId("followup-resolve-all"))
    const afterResolve = useReviewStore.getState()
    expect(afterResolve.items.every((item) => item.resolved)).toBe(true)
    expect(afterResolve.novelReviewEntries.every((entry) => entry.resolved)).toBe(true)

    fireEvent.click(screen.getByTestId("followup-clear-resolved"))
    const cleared = useReviewStore.getState()
    expect(cleared.items).toHaveLength(0)
    expect(cleared.novelReviewEntries).toHaveLength(0)
    expect(screen.getByTestId("followup-empty")).toBeTruthy()
  })

  it("章节审查条目：第 X 章 + 意见数 + 标记完成", () => {
    useReviewStore.getState().addNovelReviewEntry(makeEntry("entry-1", 3, false))
    render(<FollowupCenterView projectPath="test-proj" ledger={createRunEventLedger()} />)
    const row = screen.getByTestId("followup-entry-entry-1").textContent ?? ""
    expect(row).toContain("第 3 章")
    expect(row).toContain("1 条意见")

    fireEvent.click(screen.getByTestId("followup-entry-resolve-entry-1"))
    expect(useReviewStore.getState().novelReviewEntries[0]?.resolved).toBe(true)
  })

  it("磁盘装载：deps 注入 JSONL → 阻塞队列渲染", async () => {
    const lines = [gateRun(0, "consistency", "fail"), gateRun(1, "anti_ai", "pass")]
      .map((event) => JSON.stringify(event))
      .join("\n")
    const files = new Map<string, string>([["C:/proj/p-9/.novel/run-events.jsonl", `${lines}\n`]])
    const deps: RunEventLedgerStoreDeps = {
      readText: async (path) => files.get(path) ?? null,
      appendText: async (path, text) => {
        files.set(path, (files.get(path) ?? "") + text)
      },
    }
    render(<FollowupCenterView projectPath="C:/proj/p-9" deps={deps} />)
    const blocking = await screen.findByTestId("followup-blocking", undefined, { timeout: 2000 })
    expect(blocking).toBeTruthy()
    expect(screen.getByTestId("followup-blocking-item-consistency")).toBeTruthy()
  })
})
