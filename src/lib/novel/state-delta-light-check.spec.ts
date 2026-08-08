import { describe, expect, it } from "vitest"
import type { CharacterState } from "./character-state"
import {
  extractStateDeltaHeuristic,
  lightIssuesToReviewResults,
  runLightCheck,
  runStateDeltaLightCheckOnDraft,
} from "./state-delta-light-check"

function char(partial: Partial<CharacterState> & { characterName: string }): CharacterState {
  return {
    currentLocation: "京城",
    status: "健康",
    equipment: [],
    abilities: [],
    relationships: {},
    lastUpdatedChapter: 1,
    lastUpdatedAt: "",
    ...partial,
  }
}

describe("runLightCheck", () => {
  it("flags dead character still active", () => {
    const prev = [char({ characterName: "阿宁", status: "已死亡", isAlive: false })]
    const issues = runLightCheck(prev, { chapter: 3, activeMentions: ["阿宁"] })
    expect(issues.some((i) => i.code === "dead_character_active")).toBe(true)
    expect(issues.find((i) => i.code === "dead_character_active")!.severity).toBe("error")
  })

  it("flags location from mismatch", () => {
    const prev = [char({ characterName: "李四", currentLocation: "码头" })]
    const issues = runLightCheck(prev, {
      chapter: 2,
      locationChanges: [{ entity: "李四", from: "皇宫", to: "客栈" }],
    })
    expect(issues.some((i) => i.code === "location_from_mismatch")).toBe(true)
  })

  it("flags inventory lose missing", () => {
    const prev = [char({ characterName: "王五", equipment: ["长剑"] })]
    const issues = runLightCheck(prev, {
      chapter: 2,
      inventoryChanges: [{ entity: "王五", item: "玉佩", op: "lose" }],
    })
    expect(issues.some((i) => i.code === "inventory_lose_missing")).toBe(true)
  })

  it("ok when live character mentioned", () => {
    const prev = [char({ characterName: "阿宁", status: "健康" })]
    const issues = runLightCheck(prev, { chapter: 2, activeMentions: ["阿宁"] })
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0)
  })
})

describe("extractStateDeltaHeuristic", () => {
  it("collects active mentions and weak location", () => {
    const prev = [char({ characterName: "阿宁", currentLocation: "京城" })]
    const draft = "阿宁在客栈门口停下，看了看天色。"
    const delta = extractStateDeltaHeuristic(draft, prev, 4)
    expect(delta.activeMentions).toContain("阿宁")
    expect(delta.locationChanges?.some((c) => c.to.includes("客栈") || c.to === "客栈")).toBe(true)
  })
})

describe("lightIssuesToReviewResults", () => {
  it("demotes error to warning when blocksTrackA false", () => {
    const issues = runLightCheck(
      [char({ characterName: "阿宁", isAlive: false, status: "死" })],
      { chapter: 1, activeMentions: ["阿宁"] },
    )
    const results = lightIssuesToReviewResults(issues, { blocksTrackA: false, chapter: 1 })
    expect(results.every((r) => r.severity !== "error")).toBe(true)
    expect(results[0]!.type).toBe("state_delta_light_check")
  })

  it("keeps error when blocksTrackA true", () => {
    const issues = runLightCheck(
      [char({ characterName: "阿宁", isAlive: false, status: "死" })],
      { chapter: 1, activeMentions: ["阿宁"] },
    )
    const results = lightIssuesToReviewResults(issues, { blocksTrackA: true, chapter: 1 })
    expect(results.some((r) => r.severity === "error")).toBe(true)
  })
})

describe("runStateDeltaLightCheckOnDraft", () => {
  it("skips empty draft with info", () => {
    const { issues } = runStateDeltaLightCheckOnDraft("", [], 2)
    expect(issues[0]!.code).toBe("extract_skipped_empty_draft")
  })

  it("prefers structured JSON over heuristic when valid", () => {
    const prev = [char({ characterName: "阿宁", status: "已死亡", isAlive: false })]
    const draft = "阿宁走在街上。```json\n{\"activeMentions\":[\"阿宁\"]}\n```"
    const { source, issues } = runStateDeltaLightCheckOnDraft(draft, prev, 3, {
      structuredRaw: JSON.stringify({ activeMentions: ["阿宁"] }),
    })
    expect(source).toBe("structured")
    expect(issues.some((i) => i.code === "dead_character_active")).toBe(true)
  })

  it("falls back to heuristic when structured invalid", () => {
    const prev = [char({ characterName: "阿宁", currentLocation: "京城" })]
    const draft = "阿宁在客栈门口停下。"
    const { source } = runStateDeltaLightCheckOnDraft(draft, prev, 2, {
      structuredRaw: "not-json",
    })
    expect(source).toBe("heuristic")
  })

  it("extractEmbeddedStateDeltaJson finds labeled fence", async () => {
    const { extractEmbeddedStateDeltaJson } = await import("./state-delta-light-check")
    const draft = '前言\n```state-delta\n{"activeMentions":["李四"]}\n```\n后文'
    expect(extractEmbeddedStateDeltaJson(draft)).toContain("李四")
  })
})
