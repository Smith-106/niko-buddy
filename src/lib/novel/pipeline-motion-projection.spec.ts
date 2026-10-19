// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * pipeline-motion-projection.spec — 管線動態投影測試。
 * 覆蓋：空態 checked=false 且全 idle / 事件推進 current 路徑 / critic gate-run
 * 落自檢門、非 critic 落審稿門 / retry 計返工且點亮返修→正文紅邊 /
 * pass===false 的 gate-run 計審稿門→返修 / quota 點亮模型路由 /
 * kb-rebuild 點亮知識庫 / 未知工具名不落節點 / log 截斷 30 條。
 */
import { describe, expect, it } from "vitest"
import { appendRunEvents, createRunEventLedger, type RunEventInput } from "./run-event-ledger"
import {
  EXTERNAL_NODES,
  PIPELINE_STAGES,
  projectPipelineMotion,
} from "./pipeline-motion-projection"

const TS = "2026-10-19T00:00:00.000Z"

function input(seq: number, kind: RunEventInput["kind"], extra?: Partial<RunEventInput>): RunEventInput {
  return { seq, eventId: `e:${seq}`, ts: TS, kind, actor: "system", ...extra }
}

function project(inputs: RunEventInput[]) {
  const ledger = appendRunEvents(createRunEventLedger(), inputs)
  return projectPipelineMotion({ events: ledger.events })
}

function stateOf(projection: ReturnType<typeof projectPipelineMotion>, id: string): string {
  const node = [...projection.nodes, ...projection.externals].find((entry) => entry.id === id)
  if (!node) throw new Error(`missing node ${id}`)
  return node.state
}

describe("projectPipelineMotion 空態", () => {
  it("零事件 → checked=false、全節點 idle、計數全 0", () => {
    const projection = projectPipelineMotion({})
    expect(projection.checked).toBe(false)
    expect(projection.nodes).toHaveLength(PIPELINE_STAGES.length)
    expect(projection.externals).toHaveLength(EXTERNAL_NODES.length)
    for (const node of [...projection.nodes, ...projection.externals]) {
      expect(node.state).toBe("idle")
      expect(node.lastTs).toBeNull()
    }
    expect(projection.counts.events).toBe(0)
    expect(projection.log).toEqual([])
  })
})

describe("projectPipelineMotion 事件推進", () => {
  it("retrieval→generate→gate-run(pass)→accept：current 落入庫，前序 visited", () => {
    const projection = project([
      input(0, "retrieval"),
      input(1, "generate"),
      input(2, "gate-run", { actor: "critic", payload: { pass: true } }),
      input(3, "accept"),
    ])
    expect(projection.checked).toBe(true)
    expect(stateOf(projection, "ingest")).toBe("current")
    expect(stateOf(projection, "evidence")).toBe("visited")
    expect(stateOf(projection, "draft")).toBe("visited")
    expect(stateOf(projection, "self-gate")).toBe("visited")
    expect(stateOf(projection, "deliver")).toBe("idle")
    expect(projection.counts).toMatchObject({ events: 4, evidence: 1, generated: 1, gates: 1, passed: 1, accepts: 1 })
  })

  it("critic 的 gate-run 落自檢門，非 critic 落審稿門", () => {
    const critic = project([input(0, "gate-run", { actor: "critic", payload: { pass: true } })])
    expect(stateOf(critic, "self-gate")).toBe("current")
    expect(stateOf(critic, "review-gate")).toBe("idle")
    const arbiter = project([input(0, "gate-run", { actor: "arbiter", payload: { pass: true } })])
    expect(stateOf(arbiter, "review-gate")).toBe("current")
    expect(stateOf(arbiter, "self-gate")).toBe("idle")
  })

  it("retry 點亮返修並計返修→正文紅邊；失敗 gate-run 計審稿門→返修", () => {
    const projection = project([
      input(0, "generate"),
      input(1, "gate-run", { actor: "arbiter", payload: { pass: false } }),
      input(2, "retry"),
    ])
    expect(stateOf(projection, "revise")).toBe("current")
    expect(projection.reworkCounts["revise->draft"]).toBe(1)
    expect(projection.reworkCounts["review-gate->revise"]).toBe(1)
    expect(projection.counts.reworks).toBe(1)
    const reworkLog = projection.log.filter((entry) => entry.tone === "rework")
    expect(reworkLog.length).toBeGreaterThanOrEqual(2)
  })

  it("quota 點亮模型路由、kb-rebuild 點亮知識庫；error 不落節點只計數", () => {
    const projection = project([input(0, "quota"), input(1, "kb-rebuild"), input(2, "error")])
    expect(stateOf(projection, "knowledge-base")).toBe("current")
    expect(stateOf(projection, "model-router")).toBe("visited")
    expect(projection.counts.errors).toBe(1)
    expect(projection.nodes.every((node) => node.state !== "current")).toBe(true)
  })

  it("chapterId 去重計章節；modelId 出現即點亮模型路由", () => {
    const projection = project([
      input(0, "generate", { chapterId: 3, modelId: "m1" }),
      input(1, "generate", { chapterId: 3 }),
      input(2, "generate", { chapterId: 5 }),
    ])
    expect(projection.counts.chapters).toBe(2)
    expect(stateOf(projection, "model-router")).toBe("visited")
  })

  it("log 只保留最近 30 條", () => {
    const inputs = Array.from({ length: 35 }, (_, seq) => input(seq, "generate"))
    const projection = project(inputs)
    expect(projection.log).toHaveLength(30)
    expect(projection.counts.events).toBe(35)
  })
})

describe("projectPipelineMotion 軌跡條目", () => {
  it("白名單工具名補 visited；未知工具名不落節點", () => {
    const projection = projectPipelineMotion({
      events: [],
      traceEntries: [
        { name: "read_outline", title: "讀大綱", status: "done", startedAt: 1 },
        { name: "mystery_tool", title: "未知", status: "done", startedAt: 2 },
      ],
    })
    expect(projection.checked).toBe(true)
    expect(stateOf(projection, "outline")).toBe("visited")
    // 純軌跡輸入沒有賬本事件可當 current：不得編造 current。
    expect(projection.nodes.every((node) => node.state !== "current")).toBe(true)
  })
})
