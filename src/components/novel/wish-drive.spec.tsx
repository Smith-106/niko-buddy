// @vitest-environment jsdom
//
// wish-drive.tsx（T29b / F-27 卡文引导流入口）spec。
//
// 覆盖：
//   1. A-22.6 装配校验（纯函数，构造用例命中）：
//      - wish_empty（缺失 / 空清单 / 全空白项 / profile 缺失）；
//      - arc_stage_invalid（null / 注册表外脏值）；
//      - stage_action_gap（承诺后推进段无 wma_action；觉醒前/收束段不强制）；
//   2. 引导问题序列构建（四问 + 阶段指引 + motive 缺失提示分支）；
//   3. UI 可观测：空态 / blocked 态（violation 列表 + 入口关闭）/
//      ready 态（wish 清单装配可见 + 弧光阶段徽标 + 四步引导问题）。

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { useWikiStore } from "@/stores/wiki-store"
import type { ArcStage } from "@/lib/novel"
import zhLocale from "@/i18n/zh.json"
import enLocale from "@/i18n/en.json"
import {
  ACTION_EVIDENCE_STAGES,
  WishDrive,
  buildWishDriveGuide,
  validateWishAssembly,
  type WishDriveProfile,
  type WishDriveT,
} from "./wish-drive"

// F11-4：纯函数 t 桩（与组件同 key 源；支持 {{var}} 插值，与 i18next 同语义）。
function lookupT(locale: unknown): WishDriveT {
  return (key: string, options?: Record<string, unknown>) => {
    let o: unknown = locale
    for (const p of key.split(".")) {
      if (o == null || typeof o !== "object") return key
      o = (o as Record<string, unknown>)[p]
    }
    let s = typeof o === "string" ? o : key
    for (const [k, v] of Object.entries(options ?? {})) s = s.replace(`{{${k}}}`, String(v))
    return s
  }
}
const zhT = lookupT(zhLocale)
const enT = lookupT(enLocale)

function makeProfile(overrides: Partial<WishDriveProfile> = {}): WishDriveProfile {
  return {
    entityId: "ent:lin-jin",
    displayName: "林烬",
    wish: ["夺回被夺走的家传剑谱", "查清灭门真凶"],
    motive: ["为家族雪冤"],
    wmaAction: ["夜探义庄取回残页"],
    arcStage: "active",
    ...overrides,
  }
}

afterEach(() => cleanup())

// ── A-22.6 装配校验（纯函数）────────────────────────────────────────

describe("validateWishAssembly (A-22.6)", () => {
  it("passes a fully assembled profile", () => {
    const check = validateWishAssembly(makeProfile(), zhT)
    expect(check.ok).toBe(true)
    expect(check.violations).toEqual([])
  })

  it("blocks on a missing profile (fail-closed)", () => {
    for (const p of [null, undefined]) {
      const check = validateWishAssembly(p, zhT)
      expect(check.ok).toBe(false)
      expect(check.violations[0]!.code).toBe("wish_empty")
    }
  })

  it("blocks when the wish list is empty or all-blank (构造用例：wish_empty)", () => {
    const empty = validateWishAssembly(makeProfile({ wish: [] }), zhT)
    expect(empty.violations.map((v) => v.code)).toContain("wish_empty")

    const blank = validateWishAssembly(makeProfile({ wish: ["  ", "　"] }), zhT)
    expect(blank.violations[0]!.code).toBe("wish_empty")
  })

  it("blocks on an illegal or missing arc_stage (构造用例：arc_stage_invalid)", () => {
    const missing = validateWishAssembly(makeProfile({ arcStage: null }), zhT)
    expect(missing.violations[0]!.code).toBe("arc_stage_invalid")
    expect(missing.violations[0]!.message).toContain("未摄取")

    // 上游脏值（注册表外字符串）必须在装配门被拦下
    const dirty = validateWishAssembly(
      makeProfile({ arcStage: "super_saiyan" as ArcStage }),
      zhT,
    )
    expect(dirty.violations.some((v) => v.code === "arc_stage_invalid")).toBe(true)
    expect(dirty.violations.find((v) => v.code === "arc_stage_invalid")!.message).toContain(
      "super_saiyan",
    )
  })

  it("blocks on the wish-action gap in post-commitment stages (构造用例：stage_action_gap)", () => {
    for (const stage of ACTION_EVIDENCE_STAGES) {
      const check = validateWishAssembly(makeProfile({ arcStage: stage, wmaAction: [] }), zhT)
      expect(check.ok).toBe(false)
      expect(check.violations.some((v) => v.code === "stage_action_gap")).toBe(true)
    }
  })

  it("does not require action evidence in pre-commitment and resolution stages", () => {
    for (const stage of ["ghost_exposed", "refusal", "resolution"] as const) {
      const check = validateWishAssembly(makeProfile({ arcStage: stage, wmaAction: [] }), zhT)
      expect(check.ok).toBe(true)
    }
  })

  it("accumulates multiple violations", () => {
    const check = validateWishAssembly(
      makeProfile({ wish: [], arcStage: null, wmaAction: [] }),
      zhT,
    )
    expect(check.violations.map((v) => v.code)).toEqual(["wish_empty", "arc_stage_invalid"])
  })
})

// ── 引导问题序列构建（纯函数）───────────────────────────────────────

describe("buildWishDriveGuide", () => {
  it("emits the four W-M-A+confrontation questions with the stage hint", () => {
    const guide = buildWishDriveGuide(makeProfile({ arcStage: "crisis" }), zhT)
    expect(guide.stageLabel).toBe("危机升级")
    expect(guide.steps.map((s) => s.id)).toEqual([
      "wish",
      "motive",
      "action",
      "confrontation",
    ])
    // 行动步骤的 hint 携带阶段指引
    expect(guide.steps.find((s) => s.id === "action")!.hint).toContain("对抗力量压制愿望")
  })

  it("flags an empty motive list inside the motive step hint (A-22.1 区分口径)", () => {
    const guide = buildWishDriveGuide(makeProfile({ motive: [] }), zhT)
    expect(guide.steps.find((s) => s.id === "motive")!.hint).toContain("动机清单为空")

    // F11-4：motive hint 去 A-22.1 术语（用户语言：愿望=想要什么，动机=为什么想要）。
    const full = buildWishDriveGuide(makeProfile(), zhT)
    expect(full.steps.find((s) => s.id === "motive")!.hint).toContain("想要什么")
    expect(full.steps.find((s) => s.id === "motive")!.hint).not.toContain("A-22.1")
  })

  it("degrades gracefully for an invalid stage (defensive; gate blocks normal entry)", () => {
    const guide = buildWishDriveGuide(
      makeProfile({ arcStage: "bogus" as ArcStage }),
      zhT,
    )
    expect(guide.stageLabel).toBe("未定阶段")
  })
})

// ── UI 可观测行为 ──────────────────────────────────────────────────

describe("WishDrive (F-27 entry)", () => {
  it("shows the empty state when no profile has been ingested", () => {
    render(<WishDrive profile={null} />)
    expect(screen.getByTestId("wish-drive-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("wish-drive-blocked")).not.toBeInTheDocument()
    expect(screen.queryByTestId("wish-drive-ready")).not.toBeInTheDocument()
  })

  it("F10-3：空态短指引为可点击按钮 + 有填写示例（去哪+怎么写）", () => {
    const onOpenCanonEditor = vi.fn()
    render(<WishDrive profile={null} onOpenCanonEditor={onOpenCanonEditor} />)
    const goto = screen.getByTestId("wish-drive-goto-canon")
    expect(goto.tagName).toBe("BUTTON")
    // 示例行：给“怎么写”参照（愿望/动机/鬼魂/弧光四字段示例；F11-1：弧光用语须与 STAGE_LABELS
    // “主动推进”一致，不得用注册表外术语；须含 ghost（麦基鬼魂）写法参照）
    expect(screen.getByTestId("wish-drive-empty")).toHaveTextContent("夺回被夺走的家传剑谱")
    expect(screen.getByTestId("wish-drive-empty")).toHaveTextContent("主动推进")
    expect(screen.getByTestId("wish-drive-empty")).not.toHaveTextContent("行动期")
    expect(screen.getByTestId("wish-drive-empty")).toHaveTextContent("鬼魂")
    fireEvent.click(goto)
    expect(onOpenCanonEditor).toHaveBeenCalledTimes(1)
  })

  it("F10-3：空态按钮默认跳转到设定校正视图（canonEditor）", () => {
    const prev = useWikiStore.getState().activeView
    render(<WishDrive profile={null} />)
    fireEvent.click(screen.getByTestId("wish-drive-goto-canon"))
    expect(useWikiStore.getState().activeView).toBe("canonEditor")
    useWikiStore.getState().setActiveView(prev)
  })

  it("closes the entry with the violation list when A-22.6 fails (blocked)", () => {
    render(<WishDrive profile={makeProfile({ wish: [], arcStage: null })} />)
    const blocked = screen.getByTestId("wish-drive-blocked")
    expect(blocked).toHaveAttribute("role", "alert")
    // F11-4：可见行只渲染用户语言（无 [code]/内部编号）；机读码降为 data-*/title。
    expect(blocked).toHaveTextContent("装配校验未通过")
    expect(blocked).not.toHaveTextContent("[wish_empty]")
    expect(blocked).not.toHaveTextContent("A-22.6")
    expect(screen.getByTestId("wish-drive-violation-wish_empty")).toHaveAttribute(
      "data-violation-code",
      "wish_empty",
    )
    expect(screen.getByTestId("wish-drive-violation-wish_empty")).toBeInTheDocument()
    expect(screen.getByTestId("wish-drive-violation-arc_stage_invalid")).toBeInTheDocument()
    // 引导流不产出半成品
    expect(screen.queryByTestId("wish-drive-ready")).not.toBeInTheDocument()
    expect(screen.queryByTestId("wish-drive-steps")).not.toBeInTheDocument()
  })

  it("renders the assembled wish list visibly in the ready state", () => {
    render(<WishDrive profile={makeProfile()} />)
    const ready = screen.getByTestId("wish-drive-ready")
    expect(ready).toBeInTheDocument()
    // 装配可见：两条愿望逐条渲染
    expect(screen.getByText("夺回被夺走的家传剑谱")).toBeInTheDocument()
    expect(screen.getByText("查清灭门真凶")).toBeInTheDocument()
    // 动机与行动证据计数
    expect(ready).toHaveTextContent("为家族雪冤")
    // F11-4：标签去 token（行动证据：1 条），无 wma_action 机读串。
    expect(ready).toHaveTextContent("行动证据：1 条")
    expect(ready).not.toHaveTextContent("wma_action")
    // 弧光阶段徽标
    expect(screen.getByTestId("wish-drive-stage-badge")).toHaveTextContent("主动推进")
  })

  it("renders the four guided questions in order", () => {
    render(<WishDrive profile={makeProfile()} />)
    const steps = screen.getByTestId("wish-drive-steps")
    expect(steps.children).toHaveLength(4)
    expect(screen.getByTestId("wish-drive-step-wish")).toHaveTextContent("主角此刻最想要什么？")
    expect(screen.getByTestId("wish-drive-step-motive")).toHaveTextContent("他为什么想要？")
    expect(screen.getByTestId("wish-drive-step-action")).toHaveTextContent(/最小可见行动/)
    expect(screen.getByTestId("wish-drive-step-confrontation")).toHaveTextContent(/谁或什么在阻止他？/)
  })

  it("prefers characterName over displayName in the header", () => {
    const { rerender } = render(<WishDrive profile={makeProfile()} />)
    // F11-4：aria-label 走 i18n title（无 F-27 代号）。
    let region = screen.getByRole("region", { name: /卡文引导 · 愿望驱动 · 林烬/ })
    expect(region).toBeInTheDocument()

    rerender(<WishDrive profile={makeProfile()} characterName="沈微" />)
    region = screen.getByRole("region", { name: /卡文引导 · 愿望驱动 · 沈微/ })
    expect(region).toBeInTheDocument()
  })

  it("falls back to a generic title when neither name is present", () => {
    render(<WishDrive profile={makeProfile({ displayName: undefined })} />)
    expect(
      screen.getByRole("region", { name: /卡文引导 · 愿望驱动 · 主角/ }),
    ).toBeInTheDocument()
  })
})

// ── F11-4：英文面可用性（用户维度残留整改锁）─────────────────────────────

describe("wish-drive i18n parity (F11-4)", () => {
  const CJK = /[一-鿿]/
  const wishKeys = [
    "novel.wishStageLabel",
    "novel.wishFallbackTitle",
    "novel.wishSourceNote",
    "novel.wishFallbackStageHint",
    "novel.wishStepWishQ",
    "novel.wishStepWishHint",
    "novel.wishStepMotiveQ",
    "novel.wishStepMotiveHintWith",
    "novel.wishStepMotiveHintWithout",
    "novel.wishStepActionQ",
    "novel.wishStepConfrontQ",
    "novel.wishStepConfrontHint",
    "novel.wishStageBadge",
    "novel.wishActionCount",
  ]

  it("英文面无中文残留（novel.* 用户可见键 + 7 阶段名/指引 + 5 违规 message）", () => {
    for (const key of wishKeys) {
      expect(enT(key)).not.toMatch(CJK)
      expect(enT(key)).not.toBe(key) // 在位（非 key 回退）
    }
    for (const stage of ["ghost_exposed", "refusal", "commitment", "active", "crisis", "climax", "resolution"] as const) {
      expect(enT(`novel.wishStageLabels.${stage}`)).not.toMatch(CJK)
      expect(enT(`novel.wishStageHints.${stage}`)).not.toMatch(CJK)
    }
    for (const key of ["profile_missing", "wish_empty", "arc_stage_missing", "arc_stage_invalid", "stage_action_gap"] as const) {
      const msg = enT(`novel.wishViolation.${key}`, { stage: "bogus", stageLabel: "Active" })
      expect(msg).not.toMatch(CJK)
      expect(msg).not.toContain("{{") // 插值位全部填充
    }
  })

  it("英文纯函数面：阶段名/违规 message 均为用户语言", () => {
    const check = validateWishAssembly(makeProfile({ wish: [], arcStage: null }), enT)
    expect(check.ok).toBe(false)
    for (const v of check.violations) expect(v.message).not.toMatch(CJK)
    const guide = buildWishDriveGuide(makeProfile({ arcStage: "active" }), enT)
    expect(guide.stageLabel).not.toMatch(CJK)
    expect(guide.stageHint).not.toMatch(CJK)
    for (const s of guide.steps) {
      expect(s.question).not.toMatch(CJK)
      expect(s.hint).not.toMatch(CJK)
    }
  })

  it("中文违规 message 无内部编号/表列 token（A-22.6/U-04/T26/entities 零出现）", () => {
    const cases: Array<Partial<WishDriveProfile>> = [
      { wish: [] },
      { arcStage: null },
      { arcStage: "bogus" as ArcStage },
      { arcStage: "active", wmaAction: [] },
    ]
    const probe = validateWishAssembly(null, zhT)
    const all = [...probe.violations]
    for (const c of cases) all.push(...validateWishAssembly(makeProfile(c), zhT).violations)
    expect(all.length).toBeGreaterThan(0)
    for (const v of all) {
      expect(v.message).not.toContain("A-22.6")
      expect(v.message).not.toContain("U-04")
      expect(v.message).not.toContain("T26")
      expect(v.message).not.toContain("entities.")
    }
  })
})
