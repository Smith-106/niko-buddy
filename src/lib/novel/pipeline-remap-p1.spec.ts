// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * pipeline-remap-p1.spec — P1 阶段一拓扑契约（TASK-001 lib + TASK-002 能力池 lib 面）。
 *
 * 覆盖：
 * - V1：TOOL_TO_STAGE route_task→goal（轨迹条目补 visited）；eventToStage null 分支
 *   （stage/error 映射不上，只进计数与 log，不落节点；注释含“映射不上”由 grep 门把关）；
 * - D1 阈值：hasExplicitReferenceId 仅显式范文ID/拆书报告ID 为 true，
 *   链接猜测/模糊提及一律 false；resolveDraftRoute 无参考回落 A；
 * - V2：SKILL_ROUTE_DEFINITIONS 16 任务 × outline|drafting|review 3 阶段；
 *   范文仿写/拆书报告仿写别名增量挂载到 long_form_drafting；
 * - V4：CHAPTER_OUTLINE_SUPPORT_SKILLS 7 件套存在性；
 * - V7-lib：GATE_PRIORITY_ORDER Consistency > Anti-AI > Quality，
 *   GATE_MAPPING 37 维（15/10/12），REWORK_EDGES 3 条红边；
 * - V9-lib（D4 替代）：MAIN_LANES 12 + SUPPORT_LANES 8 + LIBRARY_IDS 6 库 +
 *   MODULE_ATLAS 接线真源 + skill 全集（getSkillRouteSkillNames 非空）。
 */
import { describe, expect, it } from "vitest"

import { appendRunEvents, createRunEventLedger, type RunEventInput } from "./run-event-ledger"
import {
  PIPELINE_STAGES,
  REWORK_EDGES,
  projectPipelineMotion,
} from "./pipeline-motion-projection"
import {
  CHAPTER_OUTLINE_SUPPORT_SKILLS,
  SKILL_ROUTE_DEFINITIONS,
  findSkillRouteByAlias,
  getSkillRouteSkillNames,
  hasExplicitReferenceId,
  resolveDraftRoute,
} from "./skill-route-registry"
import { GATE_MAPPING, GATE_PRIORITY_ORDER } from "./audit-taxonomy"
import { LIBRARY_IDS, entrySchemaFor } from "./asset-library"
import { MODULE_ATLAS } from "./module-atlas"
import { MAIN_LANES, SUPPORT_LANES } from "@/components/novel/module-heatmap-view"

const TS = "2026-10-19T00:00:00.000Z"

function ledgerOf(entries: Array<{ seq: number; kind: RunEventInput["kind"] }>) {
  return appendRunEvents(
    createRunEventLedger(),
    entries.map((entry) => ({
      seq: entry.seq,
      eventId: `e:${entry.seq}`,
      ts: TS,
      kind: entry.kind,
      actor: "system",
    })),
  ).events
}

describe("V1 路由契约", () => {
  it("route_task 轨迹条目补 goal visited（TOOL_TO_STAGE route_task→goal）", () => {
    const projection = projectPipelineMotion({
      events: [],
      traceEntries: [{ name: "route_task", title: "派活", status: "done", startedAt: 1 }],
    })
    const goal = projection.nodes.find((node) => node.id === "goal")
    expect(goal?.state).toBe("visited")
  })

  it("stage/error 事件映射不上：只进计数与 log，不落节点", () => {
    const projection = projectPipelineMotion({
      events: ledgerOf([
        { seq: 0, kind: "stage" },
        { seq: 1, kind: "error" },
      ]),
    })
    expect(projection.checked).toBe(true)
    expect(projection.counts.events).toBe(2)
    expect(projection.log).toHaveLength(2)
    for (const node of [...projection.nodes, ...projection.externals]) {
      expect(node.state).toBe("idle")
    }
    expect(projection.hotEdge).toBeNull()
  })
})

describe("D1 有参考阈值（locked）", () => {
  it.each([
    "范文ID：EX-001",
    "范文ID: EX-001",
    "拆书报告ID：RPT-9",
    "拆书报告: 卷一拆书",
    "exemplar-id: abc123",
    "exemplarId=xyz",
    "拆书id: r1",
  ])("显式 ID 算有参考：%s", (text) => {
    expect(hasExplicitReferenceId(text)).toBe(true)
    expect(resolveDraftRoute(text)).toBe("route-b-reference")
  })

  it.each([
    "",
    "参考这篇范文写一章",
    "范文",
    "拆书",
    "拆书报告",
    "https://example.com/novel/123",
    "帮我写一章，风格参考链接里那本",
    "范文ID",
  ])("无显式 ID 一律回落 A（不猜测）：%s", (text) => {
    expect(hasExplicitReferenceId(text)).toBe(false)
    expect(resolveDraftRoute(text)).toBe("route-a-direct")
  })
})

describe("V2 skill 16×3 路由表", () => {
  it("16 任务 × outline|drafting|review 3 阶段", () => {
    expect(SKILL_ROUTE_DEFINITIONS).toHaveLength(16)
    expect(new Set(SKILL_ROUTE_DEFINITIONS.map((def) => def.stage))).toEqual(
      new Set(["outline", "drafting", "review"]),
    )
  })

  it("范文仿写/拆书报告仿写别名增量挂载到 long_form_drafting（仅别名，不改名）", () => {
    expect(findSkillRouteByAlias("范文仿写")?.task).toBe("long_form_drafting")
    expect(findSkillRouteByAlias("拆书报告仿写")?.task).toBe("long_form_drafting")
  })

  it("skill 全集为能力池另一半（getSkillRouteSkillNames 非空）", () => {
    const names = getSkillRouteSkillNames(SKILL_ROUTE_DEFINITIONS[0])
    expect(names.length).toBeGreaterThan(0)
  })
})

describe("V4 章纲 7 件套", () => {
  it("CHAPTER_OUTLINE_SUPPORT_SKILLS 7 件套存在且含 assembler", () => {
    expect(CHAPTER_OUTLINE_SUPPORT_SKILLS).toHaveLength(7)
    expect(CHAPTER_OUTLINE_SUPPORT_SKILLS).toContain("chapter-outline-assembler")
  })
})

describe("V7-lib 三门硬门", () => {
  it("门优先级固定 Consistency > Anti-AI > Quality（Quality 不得覆盖 Consistency）", () => {
    expect(GATE_PRIORITY_ORDER).toEqual(["consistency", "anti_ai", "quality"])
    expect(GATE_MAPPING.consistency.priority).toBe(0)
    expect(GATE_MAPPING.anti_ai.priority).toBe(1)
    expect(GATE_MAPPING.quality.priority).toBe(2)
  })

  it("37 维分布 15/10/12", () => {
    expect(GATE_MAPPING.consistency.dimensionIds).toHaveLength(15)
    expect(GATE_MAPPING.anti_ai.dimensionIds).toHaveLength(10)
    expect(GATE_MAPPING.quality.dimensionIds).toHaveLength(12)
  })

  it("REWORK_EDGES 3 条红边", () => {
    expect(REWORK_EDGES).toHaveLength(3)
  })

  it("PIPELINE_STAGES 含 chapter-plan 与 deliver 链", () => {
    const ids = PIPELINE_STAGES.map((stage) => stage.id)
    expect(ids).toContain("chapter-plan")
    expect(ids).toContain("deliver")
    expect(ids).toContain("reflow")
    expect(ids).toContain("retrospective")
  })
})

describe("V9-lib 能力池矩阵（D4 替代）", () => {
  it("MAIN_LANES 12 主泳道", () => {
    expect(MAIN_LANES).toHaveLength(12)
  })

  it("SUPPORT_LANES 8 支撑泳道", () => {
    expect(SUPPORT_LANES).toHaveLength(8)
  })

  it("LIBRARY_IDS 现 6 库（不硬凑 17），每库有 schema 校验器）", () => {
    expect(LIBRARY_IDS).toHaveLength(6)
    for (const id of LIBRARY_IDS) {
      expect(entrySchemaFor(id)).toBeDefined()
    }
  })

  it("MODULE_ATLAS 静态接线真源存在", () => {
    expect(MODULE_ATLAS.modules.length).toBeGreaterThan(0)
    expect(MODULE_ATLAS.stages.length).toBeGreaterThan(0)
  })
})
