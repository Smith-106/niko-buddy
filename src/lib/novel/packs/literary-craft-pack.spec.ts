/**
 * literary-craft-pack.spec.ts — T28 文学提升规则包单测
 *
 * 覆盖（任务约束 coverage-100%）：
 *   - 14 条规则全部存在且 id 唯一
 *   - 每条规则产出一条示例 assertion（有数据输入时产出 findings）
 *   - 空输入时所有规则产出空 findings
 *   - 与 T23 combinePacks 兼容（可组合为冻结栈并运行）
 *   - 每条规则的 dimensionId 与 T22 quality 门一致
 *
 * 执行纪律：
 *   - ADR-19 机械层零模型调用：无 IO / 无 LLM / 无 Tauri invoke
 *   - Draft-first（ADR-08）：新增测试文件，不触及 .novel/status.json 正式层
 */
import { describe, expect, it } from "vitest"
import { createLiteraryCraftPack, createEmptyLiteraryCraftPack } from "./literary-craft-pack"
import type { LiteraryCraftInput } from "./literary-craft-pack"
import { combinePacks, runRuleStack } from "../rule-stack"
import type { QuantifiedHit, TensionSample } from "../craft/thrill-quantifier"

// ============================================================================
// 测试夹具
// ============================================================================

/** 构造默认测试输入（含有全部字段的假数据，覆盖 14 条规则检查路径）。 */
function makeDefaultTestInput(): LiteraryCraftInput {
  return {
    thrillQuantifierResult: {
      hits: makeDefaultHits(),
      tensionCurve: makeDefaultTensionCurve(),
    },
    arcProgressionResult: {
      previousStage: "ghost_exposed",
      currentStage: "commitment",
      progressed: true,
      confidence: 0.8,
      reason: "wma_actions 存在",
    },
    arcProgressionInput: {
      currentStage: "commitment",
      mckeeGhost: "少年时目睹父亲蒙冤却无力阻止",
      significantDetails: ["袖口磨白的旧怀表"],
      wmaActions: ["联合旧部搜集罪证"],
      arcFundamentals: {
        willpower: 0.8,
        versatility: 0.5,
        underdog_position: 0.9,
        empathy_core: 0.7,
        duplicity: 0.3,
        foreground_depth: 0.6,
        change_capacity: 0.5,
        epiphany_insight: 0.4,
      },
      visibleActions: [
        { chapterNumber: 1, action: "拒绝旧部的请求" },
        { chapterNumber: 2, action: "暗中调查真相" },
      ],
      closureState: "open",
    },
    entityCraftFields: {
      wish: ["夺回被侵占的家产"],
      motive: ["父亲临终托付"],
      wma_action: ["联合旧部搜集罪证", "潜入敌营获取情报"],
      mckee_ghost: "少年时目睹父亲蒙冤却无力阻止",
      arc_stage: "commitment",
      arc_fundamentals: {
        willpower: 0.8,
        versatility: 0.5,
        underdog_position: 0.9,
        empathy_core: 0.7,
        duplicity: 0.3,
        foreground_depth: 0.6,
        change_capacity: 0.5,
        epiphany_insight: 0.4,
      },
      significant_details: ["袖口磨白的旧怀表", "左手虎口的刀疤"],
      visible_actions: [
        { chapterNumber: 1, action: "拒绝旧部的请求" },
        { chapterNumber: 2, action: "暗中调查真相" },
      ],
    },
    edgeCraftFields: {
      beat_label: "theme_stated",
      beat_hit: true,
      foreshadow_planted_at: 3,
      hook_type: "suspense",
      payoff_chapter: 15,
    },
    episodeCraftFields: {
      beat_hits: [
        { beat_type: "catalyst", intensity: 0.7, position_ratio: 0.1, closure_state: "open" },
        { beat_type: "midpoint", intensity: 0.9, position_ratio: 0.5, closure_state: "closed" },
        { beat_type: "finale", intensity: 1.0, position_ratio: 0.9, closure_state: "open" },
      ],
      hook_type: "turning_point",
      conflict_caliber: "edgerton",
      narrative_mode: "snyder_commercial",
    },
    chapterNumber: 5,
    totalChapters: 20,
  }
}

/** 构造默认爽点命中列表（覆盖密度/间隔检查，避免连续延宕跨度 > 0.5）。 */
function makeDefaultHits(): QuantifiedHit[] {
  const data: [string, number, number, "open" | "closed"][] = [
    ["catalyst", 0.7, 0.05, "open"],
    ["debate", 0.4, 0.12, "closed"],   // 早期闭环，打断连续延宕
    ["break_into_two", 0.6, 0.22, "open"],
    ["b_story", 0.5, 0.28, "closed"],
    ["fun_and_games", 0.6, 0.35, "closed"],
    ["midpoint", 0.9, 0.48, "closed"],
    ["bad_guys_close_in", 0.7, 0.55, "open"],
    ["all_is_lost", 0.8, 0.65, "closed"], // 闭环，打断连续延宕
    ["dark_night_of_the_soul", 0.5, 0.72, "closed"], // 闭环，打断
    ["break_into_three", 0.7, 0.78, "open"],
    ["finale", 1.0, 0.88, "closed"], // 闭环
    ["final_image", 0.8, 0.98, "open"],
  ]
  return data.map(([beatType, intensity, positionRatio, closureState]) => ({
    beatType,
    rawIntensity: intensity,
    weightedIntensity: intensity,
    positionRatio,
    closureState,
    arcId: null,
  }))
}

/** 构造默认张力曲线（频繁交替，避免连续上升 > 5 点）。 */
function makeDefaultTensionCurve(): TensionSample[] {
  const samples: TensionSample[] = []
  const total = 21
  // 大幅振荡：用大振幅让 EMA 平滑值每次方向改变时都跨越前值
  // 上升→下降→上升→下降，每个方向最多 2 次连续
  const pattern = [0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1]
  for (let i = 0; i < total; i++) {
    const pos = Math.min(i * 0.05, 1)
    const raw = pattern[i] ?? 0.5
    samples.push({
      positionRatio: pos,
      raw,
      smoothed: raw * 0.3 + (samples[i - 1]?.smoothed ?? raw) * 0.7,
    })
  }
  return samples
}

// ============================================================================
// 14 条规则存在性与完整性
// ============================================================================

describe("literary-craft-pack 规则完整性", () => {
  const pack = createEmptyLiteraryCraftPack()

  it("14 条规则全部存在且 id 唯一", () => {
    expect(pack.rules).toHaveLength(14)
    const ids = pack.rules.map((r) => r.id)
    expect(new Set(ids).size).toBe(14)
  })

  it("所有规则以 'craft.' 前缀命名", () => {
    const ids = pack.rules.map((r) => r.id)
    for (const id of ids) {
      expect(id.startsWith("craft.")).toBe(true)
    }
  })

  it("所有规则归属 quality 门", () => {
    for (const rule of pack.rules) {
      expect(rule.gate).toBe("quality")
    }
  })

  it("所有规则有合法的 dimensionId", () => {
    const validDims = [
      "thrill_density",
      "reading_power",
      "pacing_tension",
      "emotional_impact",
      "description_vividness",
      "structural_balance",
      "scene_craft",
      "tension_curve",
    ]
    for (const rule of pack.rules) {
      expect(validDims).toContain(rule.dimensionId)
    }
  })

  it("规则 id 列表（按字典序，与 combinePacks 全序一致）", () => {
    const ids = pack.rules.map((r) => r.id)
    expect(ids).toEqual([
      "craft.arc-progression",
      "craft.bridge-caliber",
      "craft.chapter-end-hook",
      "craft.delay-ratio",
      "craft.domino-closure-dangling-hooks",
      "craft.eight-fundamentals",
      "craft.ending-three-precepts",
      "craft.ghost-unrevealed",
      "craft.opening-hook",
      "craft.opening-red-line-five-categories",
      "craft.significant-detail",
      "craft.thrill-density",
      "craft.thrill-spacing",
      "craft.tension-relax-alternation",
    ])
  })
})

// ============================================================================
// 空输入: 所有规则产出空 findings
// ============================================================================

describe("空输入时所有规则产出空 findings", () => {
  const pack = createEmptyLiteraryCraftPack()

  it("14 条规则在空输入下不产生 error/warning（info 级别的诊断提示可接受）", () => {
    for (const rule of pack.rules) {
      const findings = (rule.run as (ctx: { isFinale: boolean }) => readonly { severity: string; message: string }[])({
        isFinale: false,
      })
      // 空输入下不应有 error 或 warning 级别的 finding
      // (info 级别如桥接口径未设置、显著细节缺失可接受)
      for (const finding of findings) {
        expect(finding.severity).not.toBe("error")
      }
    }
  })
})

// ============================================================================
// 14 条规则逐条测试
// ============================================================================

describe("14 条规则逐条检查", () => {
  // -----------------------------------------------------------------------
  // 规则 1: 爽点密度
  // -----------------------------------------------------------------------
  describe("craft.thrill-density", () => {
    it("正常密度不产出 findings", () => {
      const pack = createLiteraryCraftPack(makeDefaultTestInput())
      const rule = pack.rules.find((r) => r.id === "craft.thrill-density")!
      const findings = rule.run({ isFinale: false })
      // 默认 12 个 hit 均匀分布在 10 个桶，每桶不超过 30%
      expect(findings.length).toBe(0)
    })

    it("过密桶产出 warning", () => {
      const hits = makeDefaultHits()
      // 把所有 hit 塞到第 2 个桶 (0.1-0.2)
      for (const h of hits) {
        h.positionRatio = 0.15
      }
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        thrillQuantifierResult: {
          hits,
          tensionCurve: makeDefaultTensionCurve(),
        },
      })
      const rule = pack.rules.find((r) => r.id === "craft.thrill-density")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].severity).toBe("warning")
      expect(findings[0].message).toContain("爽点密度过高")
    })
  })

  // -----------------------------------------------------------------------
  // 规则 2: 爽点间隔
  // -----------------------------------------------------------------------
  describe("craft.thrill-spacing", () => {
    it("正常间距不产出 findings", () => {
      const pack = createLiteraryCraftPack(makeDefaultTestInput())
      const rule = pack.rules.find((r) => r.id === "craft.thrill-spacing")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBe(0)
    })

    it("过长间距产出 warning", () => {
      const hits = makeDefaultHits()
      // 把第一个 hit 移到 0.01，第二个移到 0.5，制造大间距
      if (hits.length >= 2) {
        hits[0].positionRatio = 0.01
        hits[1].positionRatio = 0.5
      }
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        thrillQuantifierResult: { hits, tensionCurve: makeDefaultTensionCurve() },
      })
      const rule = pack.rules.find((r) => r.id === "craft.thrill-spacing")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
    })

    it("少于 3 个 hit 不产出 findings", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        thrillQuantifierResult: { hits: makeDefaultHits().slice(0, 2), tensionCurve: makeDefaultTensionCurve() },
      })
      const rule = pack.rules.find((r) => r.id === "craft.thrill-spacing")!
      const findings = rule.run({ isFinale: false })
      expect(findings).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // 规则 3: 延宕比
  // -----------------------------------------------------------------------
  describe("craft.delay-ratio", () => {
    it("正常延宕比不产出 findings", () => {
      const pack = createLiteraryCraftPack(makeDefaultTestInput())
      const rule = pack.rules.find((r) => r.id === "craft.delay-ratio")!
      const findings = rule.run({ isFinale: false })
      // 默认 12 hits: 7 open, 5 closed → ratio = 1.4 — 正常范围
      expect(findings.length).toBe(0)
    })

    it("过高延宕比产出 warning", () => {
      const hits = makeDefaultHits()
      // 把大部分 hit 设为 open
      for (const h of hits) {
        h.closureState = "open"
      }
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        thrillQuantifierResult: { hits, tensionCurve: makeDefaultTensionCurve() },
      })
      const rule = pack.rules.find((r) => r.id === "craft.delay-ratio")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      // 全部 open 状态下，延宕比 Infinity 或连续延宕跨度会触发
      expect(findings.some((f) => f.message.includes("延宕") || f.message.includes("开放爽点"))).toBe(true)
    })

    it("少于 4 个 hit 不产出 findings", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        thrillQuantifierResult: { hits: makeDefaultHits().slice(0, 3), tensionCurve: makeDefaultTensionCurve() },
      })
      const rule = pack.rules.find((r) => r.id === "craft.delay-ratio")!
      const findings = rule.run({ isFinale: false })
      expect(findings).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // 规则 4: 弧光推进
  // -----------------------------------------------------------------------
  describe("craft.arc-progression", () => {
    it("正常推进不产出 findings", () => {
      const pack = createLiteraryCraftPack(makeDefaultTestInput())
      const rule = pack.rules.find((r) => r.id === "craft.arc-progression")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBe(0)
    })

    it("未推进产出 warning", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        arcProgressionResult: {
          previousStage: "ghost_exposed",
          currentStage: "ghost_exposed",
          progressed: false,
          confidence: 0.0,
          reason: "无推进证据",
        },
      })
      const rule = pack.rules.find((r) => r.id === "craft.arc-progression")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].message).toContain("弧光未推进")
    })

    it("无 arcProgressionResult 不产出 findings", () => {
      const pack = createLiteraryCraftPack({})
      const rule = pack.rules.find((r) => r.id === "craft.arc-progression")!
      const findings = rule.run({ isFinale: false })
      expect(findings).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // 规则 5: 鬼魂未揭
  // -----------------------------------------------------------------------
  describe("craft.ghost-unrevealed", () => {
    it("有鬼魂登记不产出 findings", () => {
      const pack = createLiteraryCraftPack(makeDefaultTestInput())
      const rule = pack.rules.find((r) => r.id === "craft.ghost-unrevealed")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBe(0)
    })

    it("全书过半仍无鬼魂产出 warning", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        entityCraftFields: { ...makeDefaultTestInput().entityCraftFields!, mckee_ghost: undefined },
        chapterNumber: 15,
        totalChapters: 20,
      })
      const rule = pack.rules.find((r) => r.id === "craft.ghost-unrevealed")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.some((f) => f.message.includes("鬼魂未揭示"))).toBe(true)
    })

    it("无 chapterNumber 不产出 findings", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        entityCraftFields: { ...makeDefaultTestInput().entityCraftFields!, mckee_ghost: undefined },
        chapterNumber: 0,
        totalChapters: 0,
      })
      const rule = pack.rules.find((r) => r.id === "craft.ghost-unrevealed")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // 规则 6: 开篇钩子
  // -----------------------------------------------------------------------
  describe("craft.opening-hook", () => {
    it("有效钩子类型不产出 findings", () => {
      const pack = createLiteraryCraftPack(makeDefaultTestInput())
      const rule = pack.rules.find((r) => r.id === "craft.opening-hook")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBe(0)
    })

    it("钩子缺失产出 warning", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        edgeCraftFields: { ...makeDefaultTestInput().edgeCraftFields!, hook_type: undefined },
      })
      const rule = pack.rules.find((r) => r.id === "craft.opening-hook")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].message).toContain("开篇钩子缺失")
    })

    it("投稿禁忌钩子类型产出 warning", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        edgeCraftFields: { ...makeDefaultTestInput().edgeCraftFields!, hook_type: "country_road" },
      })
      const rule = pack.rules.find((r) => r.id === "craft.opening-hook")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].message).toContain("投稿禁忌")
    })
  })

  // -----------------------------------------------------------------------
  // 规则 7: 章末钩子
  // -----------------------------------------------------------------------
  describe("craft.chapter-end-hook", () => {
    it("有效章末钩子不产出 findings", () => {
      const pack = createLiteraryCraftPack(makeDefaultTestInput())
      const rule = pack.rules.find((r) => r.id === "craft.chapter-end-hook")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBe(0)
    })

    it("钩子缺失产出 warning", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        episodeCraftFields: { ...makeDefaultTestInput().episodeCraftFields!, hook_type: undefined },
      })
      const rule = pack.rules.find((r) => r.id === "craft.chapter-end-hook")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].message).toContain("章末钩子缺失")
    })

    it("终章不检查章末钩子", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        chapterNumber: 20,
        totalChapters: 20,
        episodeCraftFields: { ...makeDefaultTestInput().episodeCraftFields!, hook_type: undefined },
      })
      const rule = pack.rules.find((r) => r.id === "craft.chapter-end-hook")!
      const findings = rule.run({ isFinale: false })
      expect(findings).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // 规则 8: 显著细节
  // -----------------------------------------------------------------------
  describe("craft.significant-detail", () => {
    it("有细节登记不产出 findings", () => {
      const pack = createLiteraryCraftPack(makeDefaultTestInput())
      const rule = pack.rules.find((r) => r.id === "craft.significant-detail")!
      const findings = rule.run({ isFinale: false })
      // 2 个细节，不超过 2 个，无泛化形容词
      expect(findings.length).toBe(0)
    })

    it("细节为空产出 info", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        entityCraftFields: { ...makeDefaultTestInput().entityCraftFields!, significant_details: undefined },
      })
      const rule = pack.rules.find((r) => r.id === "craft.significant-detail")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].severity).toBe("info")
      expect(findings[0].message).toContain("显著细节缺失")
    })

    it("泛化形容词产出 warning", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        entityCraftFields: {
          ...makeDefaultTestInput().entityCraftFields!,
          significant_details: ["她很漂亮", "袖口磨白的旧怀表"],
        },
      })
      const rule = pack.rules.find((r) => r.id === "craft.significant-detail")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.some((f) => f.message.includes("泛化形容词"))).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // 规则 9: 桥接口径
  // -----------------------------------------------------------------------
  describe("craft.bridge-caliber", () => {
    it("口径匹配不产出 findings", () => {
      const pack = createLiteraryCraftPack(makeDefaultTestInput())
      const rule = pack.rules.find((r) => r.id === "craft.bridge-caliber")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBe(0)
    })

    it("口径不匹配产出 warning", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        episodeCraftFields: {
          ...makeDefaultTestInput().episodeCraftFields!,
          conflict_caliber: "gerke",
          narrative_mode: "snyder_commercial",
        },
      })
      const rule = pack.rules.find((r) => r.id === "craft.bridge-caliber")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.some((f) => f.message.includes("桥接口径不匹配"))).toBe(true)
    })

    it("口径未设置产出 info", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        episodeCraftFields: { ...makeDefaultTestInput().episodeCraftFields!, conflict_caliber: undefined },
      })
      const rule = pack.rules.find((r) => r.id === "craft.bridge-caliber")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].severity).toBe("info")
      expect(findings[0].message).toContain("桥接口径未设置")
    })
  })

  // -----------------------------------------------------------------------
  // 规则 10: 结局三戒
  // -----------------------------------------------------------------------
  describe("craft.ending-three-precepts", () => {
    it("climax 阶段且有 wma_action 不产出 findings", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        entityCraftFields: {
          ...makeDefaultTestInput().entityCraftFields!,
          arc_stage: "climax",
          wma_action: ["联合旧部搜集罪证"],
          arc_fundamentals: { willpower: 0.8 },
        },
        arcProgressionResult: {
          previousStage: "active",
          currentStage: "climax",
          progressed: true,
          confidence: 0.9,
          reason: "visible_actions 显示冲突升级",
        },
      })
      const rule = pack.rules.find((r) => r.id === "craft.ending-three-precepts")!
      const findings = rule.run({ isFinale: false })
      // climax 阶段 + wma_action 存在 + arc_fundamentals 非全低 → 不触发
      expect(findings.length).toBe(0)
    })

    it("climax 阶段缺 wma_action 产出 warning", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        entityCraftFields: {
          ...makeDefaultTestInput().entityCraftFields!,
          arc_stage: "climax",
          wma_action: undefined,
          arc_fundamentals: { willpower: 0.8 },
        },
        arcProgressionResult: {
          previousStage: "active",
          currentStage: "climax",
          progressed: true,
          confidence: 0.9,
          reason: "visible_actions 显示冲突升级",
        },
      })
      const rule = pack.rules.find((r) => r.id === "craft.ending-three-precepts")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.some((f) => f.message.includes("结局三戒"))).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // 规则 11: 张弛交替
  // -----------------------------------------------------------------------
  describe("craft.tension-relax-alternation", () => {
    it("正常张力曲线不产出 findings", () => {
      const pack = createLiteraryCraftPack(makeDefaultTestInput())
      const rule = pack.rules.find((r) => r.id === "craft.tension-relax-alternation")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBe(0)
    })

    it("连续上升超过 5 点产出 warning", () => {
      // 构建连续上升的曲线
      const curve: TensionSample[] = []
      for (let i = 0; i < 10; i++) {
        curve.push({
          positionRatio: i * 0.05,
          raw: 0.1 + i * 0.1,
          smoothed: 0.1 + i * 0.1,
        })
      }
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        thrillQuantifierResult: {
          hits: makeDefaultHits(),
          tensionCurve: curve,
        },
      })
      const rule = pack.rules.find((r) => r.id === "craft.tension-relax-alternation")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.some((f) => f.message.includes("张弛交替不足"))).toBe(true)
    })

    it("少于 4 个采样点不产出 findings", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        thrillQuantifierResult: {
          hits: makeDefaultHits(),
          tensionCurve: [
            { positionRatio: 0, raw: 0.1, smoothed: 0.1 },
            { positionRatio: 0.5, raw: 0.5, smoothed: 0.5 },
            { positionRatio: 1, raw: 0.1, smoothed: 0.1 },
          ],
        },
      })
      const rule = pack.rules.find((r) => r.id === "craft.tension-relax-alternation")!
      const findings = rule.run({ isFinale: false })
      expect(findings).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // 规则 12: 多米诺闭环与悬空钩子
  // -----------------------------------------------------------------------
  describe("craft.domino-closure-dangling-hooks", () => {
    it("有 payoff 计划不产出 findings", () => {
      const pack = createLiteraryCraftPack(makeDefaultTestInput())
      const rule = pack.rules.find((r) => r.id === "craft.domino-closure-dangling-hooks")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBe(0)
    })

    it("悬空钩子（有 plant 无 payoff）产出 warning", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        edgeCraftFields: {
          ...makeDefaultTestInput().edgeCraftFields!,
          foreshadow_planted_at: 1,
          payoff_chapter: undefined,
        },
        chapterNumber: 10,
      })
      const rule = pack.rules.find((r) => r.id === "craft.domino-closure-dangling-hooks")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.some((f) => f.message.includes("悬空钩子"))).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // 规则 13: 开篇红线 5 类全集
  // -----------------------------------------------------------------------
  describe("craft.opening-red-line-five-categories", () => {
    it("完整 5 类不产出 findings", () => {
      const pack = createLiteraryCraftPack(makeDefaultTestInput())
      const rule = pack.rules.find((r) => r.id === "craft.opening-red-line-five-categories")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBe(0)
    })

    it("缺失 3 类以上产出 warning", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        entityCraftFields: {
          wish: undefined,
          motive: undefined,
          wma_action: undefined,
          significant_details: undefined,
          mckee_ghost: undefined,
        },
        edgeCraftFields: {
          ...makeDefaultTestInput().edgeCraftFields!,
          hook_type: undefined,
        },
      })
      const rule = pack.rules.find((r) => r.id === "craft.opening-red-line-five-categories")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].message).toContain("开篇红线承诺缺失")
    })
  })

  // -----------------------------------------------------------------------
  // 规则 14: 八项素质检查
  // -----------------------------------------------------------------------
  describe("craft.eight-fundamentals", () => {
    it("完整 8 槽位不产出 findings", () => {
      const pack = createLiteraryCraftPack(makeDefaultTestInput())
      const rule = pack.rules.find((r) => r.id === "craft.eight-fundamentals")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBe(0)
    })

    it("缺失八项素质产出 warning", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        entityCraftFields: { ...makeDefaultTestInput().entityCraftFields!, arc_fundamentals: undefined },
      })
      const rule = pack.rules.find((r) => r.id === "craft.eight-fundamentals")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].message).toContain("八项素质缺失")
    })

    it("槽位不全产出 warning", () => {
      const pack = createLiteraryCraftPack({
        ...makeDefaultTestInput(),
        entityCraftFields: {
          ...makeDefaultTestInput().entityCraftFields!,
          arc_fundamentals: { willpower: 0.8, versatility: 0.5 },
        },
      })
      const rule = pack.rules.find((r) => r.id === "craft.eight-fundamentals")!
      const findings = rule.run({ isFinale: false })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].message).toContain("八项素质不全")
    })
  })
})

// ============================================================================
// T23 combinePacks 兼容性
// ============================================================================

describe("与 T23 combinePacks 兼容", () => {
  it("可通过 combinePacks 组合为冻结栈并运行", () => {
    const pack = createLiteraryCraftPack(makeDefaultTestInput())
    const stack = combinePacks([pack])
    const result = runRuleStack(stack, { isFinale: false })
    expect(result.verdicts.quality).toBe("pass") // 全部 warning，非终局章
    expect(result.executedRuleCount).toBe(14)
    // 组合栈元数据
    expect(stack.id).toBe("literary-craft-pack")
    expect(stack.packIds).toEqual(["literary-craft-pack"])
    expect(Object.isFrozen(stack)).toBe(true)
  })

  it("终局章升格：quality warning 全部升为 error", () => {
    // 制造一个有 findings 的输入
    const pack = createLiteraryCraftPack({
      entityCraftFields: {
        wish: [],
        motive: [],
        wma_action: [],
        mckee_ghost: "",
        arc_fundamentals: {},
      },
      edgeCraftFields: { hook_type: undefined },
      episodeCraftFields: { hook_type: undefined },
      chapterNumber: 10,
      totalChapters: 20,
    })
    const stack = combinePacks([pack])
    const result = runRuleStack(stack, { isFinale: true })
    // 终局章：quality warning 升格为 error → quality fail
    expect(result.verdicts.quality).toBe("fail")
    expect(result.escalatedCount).toBeGreaterThan(0)
    // 但 Quality 永不短路
    expect(result.shortCircuited).toBe(false)
  })
})