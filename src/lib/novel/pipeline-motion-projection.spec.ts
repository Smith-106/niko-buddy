// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * pipeline-motion-projection.spec — 管线动态投影测试。
 * 覆盖：空态 checked=false 且全 idle / 事件推进 current 路径 / critic gate-run
 * 落自检门、非 critic 落审稿门 / retry 计返工且点亮返修→正文红边 /
 * pass===false 的 gate-run 计审稿门→返修 / quota 点亮模型路由 /
 * kb-rebuild 点亮知识库 / 未知工具名不落节点 / log 截断 30 条。
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

describe("projectPipelineMotion 空态", () => {
  it("零事件 → checked=false、全节点 idle、计数全 0", () => {
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

describe("projectPipelineMotion 事件推进", () => {
  it("retrieval→generate→gate-run(pass)→accept：current 落入库，前序 visited", () => {
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

  it("critic 的 gate-run 落自检门，非 critic 落审稿门", () => {
    const critic = project([input(0, "gate-run", { actor: "critic", payload: { pass: true } })])
    expect(stateOf(critic, "self-gate")).toBe("current")
    expect(stateOf(critic, "review-gate")).toBe("idle")
    const arbiter = project([input(0, "gate-run", { actor: "arbiter", payload: { pass: true } })])
    expect(stateOf(arbiter, "review-gate")).toBe("current")
    expect(stateOf(arbiter, "self-gate")).toBe("idle")
  })

  it("retry 点亮返修并计返修→正文红边；失败 gate-run 计审稿门→返修", () => {
    const projection = project([
      input(0, "generate"),
      input(1, "gate-run", { actor: "arbiter", payload: { pass: false } }),
      input(2, "retry"),
    ])
    expect(stateOf(projection, "revise")).toBe("current")
    expect(projection.reworkCounts["revise->draft"]).toBe(1)
    expect(projection.reworkCounts["review-gate->revise"]).toBe(1)
    // 返工统计 = retry 数＋失败门数（红边亮而数字为 0 是自相矛盾）。
    expect(projection.counts.reworks).toBe(2)
    const reworkLog = projection.log.filter((entry) => entry.tone === "rework")
    expect(reworkLog).toHaveLength(2)
  })

  it("critic 的失败 gate-run 计入自检门→返修，不污染审稿门边", () => {
    const projection = project([input(0, "gate-run", { actor: "critic", payload: { pass: false } })])
    expect(stateOf(projection, "self-gate")).toBe("current")
    expect(projection.reworkCounts["self-gate->revise"]).toBe(1)
    expect(projection.reworkCounts["review-gate->revise"]).toBe(0)
  })

  it("stage 是异质事件：只进计数与 log，不落任何节点", () => {
    const projection = project([input(0, "stage", { payload: { alert: "aura" } })])
    expect(projection.checked).toBe(true)
    expect(projection.counts.events).toBe(1)
    expect(projection.log).toHaveLength(1)
    for (const node of [...projection.nodes, ...projection.externals]) {
      expect(node.state).toBe("idle")
    }
  })

  it("quota 点亮模型路由、kb-rebuild 点亮知识库；error 不落节点只计数", () => {
    const projection = project([input(0, "quota"), input(1, "kb-rebuild"), input(2, "error")])
    // error 映射不上：current 停在最后一个可映射事件（kb-rebuild），主线无 current。
    expect(stateOf(projection, "knowledge-base")).toBe("current")
    expect(stateOf(projection, "model-router")).toBe("visited")
    expect(projection.counts.errors).toBe(1)
    expect(projection.nodes.every((node) => node.state !== "current")).toBe(true)
  })

  it("chapterId 去重计章节；modelId 只是路由证据，不点亮模型路由", () => {
    const projection = project([
      input(0, "generate", { chapterId: 3, modelId: "m1" }),
      input(1, "generate", { chapterId: 3 }),
      input(2, "generate", { chapterId: 5 }),
    ])
    expect(projection.counts.chapters).toBe(2)
    expect(stateOf(projection, "model-router")).toBe("idle")
    const withQuota = project([input(0, "quota")])
    expect(stateOf(withQuota, "model-router")).toBe("current")
  })

  it("log 只保留最近 30 条", () => {
    const inputs = Array.from({ length: 35 }, (_, seq) => input(seq, "generate"))
    const projection = project(inputs)
    expect(projection.log).toHaveLength(30)
    expect(projection.counts.events).toBe(35)
  })
})

describe("projectPipelineMotion 轨迹条目", () => {
  it("白名单工具名补 visited；未知工具名不落节点", () => {
    const projection = projectPipelineMotion({
      events: [],
      traceEntries: [
        { name: "read_outline", title: "读大纲", status: "done", startedAt: 1 },
        { name: "mystery_tool", title: "未知", status: "done", startedAt: 2 },
      ],
    })
    expect(projection.checked).toBe(true)
    expect(stateOf(projection, "outline")).toBe("visited")
    // 纯轨迹输入没有账本事件可当 current：不得编造 current。
    expect([...projection.nodes, ...projection.externals].every((node) => node.state !== "current")).toBe(true)
  })
})

describe("projectPipelineMotion 生产门与转移诚实性", () => {
  it("生产三门（actor system＋status）失败：落审稿门、计红边、log 绿转红", () => {
    const projection = project([
      input(0, "gate-run", {
        actor: "system",
        chapterId: 2,
        payload: { gate: "consistency", status: "fail", findingsCount: 3 },
      }),
    ])
    expect(stateOf(projection, "review-gate")).toBe("current")
    expect(stateOf(projection, "self-gate")).toBe("idle")
    expect(projection.reworkCounts["review-gate->revise"]).toBe(1)
    expect(projection.reworkCounts["self-gate->revise"]).toBe(0)
    expect(projection.counts.passed).toBe(0)
    expect(projection.counts.reworks).toBe(1)
    expect(projection.log[0].tone).toBe("rework")
    expect(projection.log[0].label).toContain("consistency=fail")
  })

  it("skipped 是未评估：落节点但 tone 为 info，不计通过不计返工", () => {
    const projection = project([
      input(0, "gate-run", { actor: "system", payload: { gate: "quality", status: "skipped" } }),
    ])
    expect(stateOf(projection, "review-gate")).toBe("current")
    expect(projection.log[0].tone).toBe("info")
    expect(projection.log[0].label).toContain("quality=skipped")
    expect(projection.counts.passed).toBe(0)
    expect(projection.counts.reworks).toBe(0)
    expect(projection.reworkCounts["review-gate->revise"]).toBe(0)
  })

  it("hotEdge = 上一个真实转移；同阶段连击无转移；空态为 null", () => {
    const moved = project([input(0, "generate"), input(1, "retry")])
    expect(moved.hotEdge).toEqual({ from: "draft", to: "revise" })
    const same = project([input(0, "generate"), input(1, "generate")])
    expect(same.hotEdge).toBeNull()
    expect(projectPipelineMotion({}).hotEdge).toBeNull()
  })

  it("log 保留的是最后 30 条（非前 30 条）", () => {
    const inputs = Array.from({ length: 35 }, (_, seq) =>
      input(seq, "generate", { ts: `2026-10-19T00:00:${String(seq).padStart(2, "0")}Z` }),
    )
    const projection = project(inputs)
    expect(projection.log).toHaveLength(30)
    expect(projection.log[0].ts).toBe("2026-10-19T00:00:05Z")
    expect(projection.log[29].ts).toBe("2026-10-19T00:00:34Z")
  })

  it("未完成轨迹（running/error）不算走过；未知工具不点亮其他节点", () => {
    const projection = projectPipelineMotion({
      events: [],
      traceEntries: [
        { name: "write_chapter", title: "写", status: "running", startedAt: 1 },
        { name: "mystery_tool", title: "未知", status: "done", startedAt: 2 },
      ],
    })
    expect(projection.checked).toBe(true)
    for (const node of [...projection.nodes, ...projection.externals]) {
      expect(node.state).toBe("idle")
    }
  })
})
