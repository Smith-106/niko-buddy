// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest"
import { runDeAiDualPass } from "./de-ai-rules"
import {
  TIERED_DEAI_TABLE,
  mergeTieredDeAiTable,
  createEmptyDeAiTieredOverrides,
} from "./de-ai-tiered-table"
import { loadReviewUniversalRulesPrompt } from "./context-engine-technique-sources"
import {
  computeRuntimeSkillBudgetTokens,
  mapRuntimeStageToTaskKey,
} from "./runtime-skill-resolver"
import {
  BUILT_IN_CRAFT_PRESETS,
  computeMissingPresetSkills,
  parseCustomCraftPresetsJson,
} from "./craft-preset-applier"
import { parseNbskillPack } from "./skill-pack/pack-format"
import { runMechanicalGateForMcp } from "@/lib/mcp/mechanical-gate"
import type { UserSkill } from "./skill-library"

function makeSkill(name: string): UserSkill {
  return {
    id: `skill:${name}`,
    name,
    description: name,
    kind: ["style"],
    stages: ["drafting"],
    modes: ["standard"],
    content: `# ${name}\nbody`,
    source: "project",
    priority: 50,
    tags: [],
    categoryId: "skill-category:writing",
  }
}

describe("Plan B Closure — 统一去 AI、机械门控覆盖、全局规则、预设闭环与摘要/提取预算", () => {
  it("runDeAiDualPass 支持自定义 tieredTable（豁免内置词 + 新增自定义 1A 禁词）", () => {
    const overrides = {
      ...createEmptyDeAiTieredOverrides(),
      disabledTerms: ["显然"],
      customEntries: [
        {
          term: "量子修真",
          tier: "1A" as const,
          category: "AI特征词" as const,
          weight: 1.0,
          suggestion: "改为具体灵气与器物细节",
        },
      ],
    }
    const merged = mergeTieredDeAiTable(TIERED_DEAI_TABLE, overrides)
    const sample = "显然，他施展了量子修真之术。"
    const defaultReport = runDeAiDualPass(sample)
    expect(defaultReport.pass1.hits.some((h) => h.entry.term === "显然")).toBe(true)
    expect(defaultReport.pass1.hits.some((h) => h.entry.term === "量子修真")).toBe(false)

    const customReport = runDeAiDualPass(sample, { tieredTable: merged })
    expect(customReport.pass1.hits.some((h) => h.entry.term === "显然")).toBe(false)
    expect(customReport.pass1.hits.some((h) => h.entry.term === "量子修真")).toBe(true)
  })

  it("runMechanicalGateForMcp 只读合入 .niko-buddy/de-ai-tiered-overrides.json", async () => {
    const overridesJson = JSON.stringify({
      version: 1,
      updatedAt: 1,
      tierOverrides: {},
      disabledTerms: ["显然"],
      customEntries: [
        {
          term: "赛博剑气",
          tier: "1A",
          category: "AI特征词",
          weight: 1.0,
          suggestion: "替换为具象剑招",
        },
      ],
    })
    const report = await runMechanicalGateForMcp(
      {
        projectPath: "/proj",
        text: "# 第一章\n\n显然，他劈出一道赛博剑气。",
        detailLevel: "full",
      },
      {
        runContinuityPreflight: vi.fn(async () => []),
        readFileText: vi.fn(async (p: string) => {
          if (p.endsWith(".niko-buddy/de-ai-tiered-overrides.json")) return overridesJson
          throw new Error("ENOENT")
        }),
        loadCharacterNames: vi.fn(async () => []),
        loadUserMemory: vi.fn(async () => ({
          schemaVersion: 1,
          updatedAt: "",
          preferences: [],
          avoidWords: [],
          deAiWeights: {},
          feedbackHistory: [],
        }) as never),
        analyzeStatisticalFactors: vi.fn(async () => ({
          sentenceLengthStd: 10,
          dialogueRatio: 0.2,
          lexicalDiversity: 0.7,
          paragraphLengthMean: 80,
          warnings: [],
        }) as never),
        readDefaultGenre: () => "",
        readDefaultTargetChars: () => 2000,
      },
    )
    // 机械层 (slop) 与分级覆盖层 (1A/1B/3) 各自产出命中；此处断言分级层精确应用覆盖：
    // 新增 1A 词「赛博剑气」命中，已豁免的内置 1A 词「显然」不再从分级层产出。
    const tieredTerms = report.metrics.pinpointHits
      .filter((h) => h.tier !== "slop")
      .map((h) => h.term)
    expect(tieredTerms).toContain("赛博剑气")
    expect(tieredTerms).not.toContain("显然")
  })

  it("loadReviewUniversalRulesPrompt 按维度过滤 review_consistency / review_quality 且按 P0>P1>P2 排序", () => {
    const continuityRules = loadReviewUniversalRulesPrompt("continuity")
    expect(continuityRules).toContain("编译期通用审查规则")
    expect(continuityRules).toContain("[P0]")

    const qualityRules = loadReviewUniversalRulesPrompt("pacing")
    expect(qualityRules).toContain("编译期通用审查规则")
    expect(qualityRules).not.toContain("跨章连续性 P0 硬门控")

    const allRules = loadReviewUniversalRulesPrompt()
    expect(allRules).toContain("[P0]")
    expect(allRules.length).toBeGreaterThan(continuityRules.length)
  })

  it("runtime-skill-resolver 支持 summary 与 extract 阶段映射及独立预算槽", () => {
    expect(mapRuntimeStageToTaskKey("summary")).toBe("summary")
    expect(mapRuntimeStageToTaskKey("extract")).toBe("extract")
    expect(computeRuntimeSkillBudgetTokens("summary", 64000)).toBe(2500)
    expect(computeRuntimeSkillBudgetTokens("extract", 64000)).toBe(2500)
  })

  it("computeMissingPresetSkills 准确识别未导入预设技能，导入后归零", () => {
    const preset = BUILT_IN_CRAFT_PRESETS[0]
    const missingEmpty = computeMissingPresetSkills(preset, [])
    expect(missingEmpty).toContain(preset.primaryExpert)
    expect(missingEmpty).toContain("long-form-drafting")

    const installed = missingEmpty.map((name) => makeSkill(name))
    expect(computeMissingPresetSkills(preset, installed)).toEqual([])
  })

  it("parseCustomCraftPresetsJson 支持 { presets } 与数组形态，并拦截非法输入", () => {
    const fromWrapped = parseCustomCraftPresetsJson(
      JSON.stringify({
        schemaVersion: 1,
        presets: [
          {
            id: "my-custom",
            name: "我的自定义流派",
            genres: ["都市异能"],
            tone: "快节奏",
            primaryExpert: "expert-commercial-pacing-hook-master",
            secondaryExpert: null,
            taskSkillNames: { outline: [], writing: ["long-form-drafting"], review: [] },
            extraPromptHint: "开篇直接抛钩子",
          },
        ],
      }),
    )
    expect(fromWrapped).toHaveLength(1)
    expect(fromWrapped[0].id).toBe("my-custom")

    const fromArray = parseCustomCraftPresetsJson(
      JSON.stringify([
        { id: "arr-1", name: "数组预设", taskSkillNames: { outline: [], writing: [], review: [] } },
      ]),
    )
    expect(fromArray).toHaveLength(1)
    expect(fromArray[0].id).toBe("arr-1")

    expect(() => parseCustomCraftPresetsJson("{}")).toThrow()
    expect(() => parseCustomCraftPresetsJson("not-json")).toThrow()
  })

  it("parseNbskillPack v2 兼容 66+ 条技能与完整元数据字段", () => {
    const prompts = Array.from({ length: 70 }, (_, idx) => ({
      id: `skill-${idx + 1}`,
      name: `skill-${idx + 1}`,
      description: `技能描述 ${idx + 1}`,
      body: `# 技能 ${idx + 1}\n\n正文规则内容。`,
      kind: ["style"],
      stages: ["drafting"],
      modes: ["standard"],
      priority: 20,
      tags: ["nmem", "expert"],
      categoryId: "skill-category:writing",
    }))
    const parsed = parseNbskillPack({
      schemaVersion: 2,
      kind: "nbskill",
      name: "nmem-novel-full-craft",
      version: "2026.11.27",
      author: "niko",
      tools: [{ name: "novel_context_read", category: "readable-state", description: "read only" }],
      prompts,
      trustLevel: "reviewed",
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.pack.prompts).toHaveLength(70)
      expect(parsed.pack.prompts[0].tags).toEqual(["nmem", "expert"])
    }
  })
})
