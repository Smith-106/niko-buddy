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

import { afterEach, describe, expect, it } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"
import type { ArcStage } from "@/lib/novel/craft/canon-craft-fields"
import {
  ACTION_EVIDENCE_STAGES,
  WishDrive,
  buildWishDriveGuide,
  validateWishAssembly,
  type WishDriveProfile,
} from "./wish-drive"

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
    const check = validateWishAssembly(makeProfile())
    expect(check.ok).toBe(true)
    expect(check.violations).toEqual([])
  })

  it("blocks on a missing profile (fail-closed)", () => {
    for (const p of [null, undefined]) {
      const check = validateWishAssembly(p)
      expect(check.ok).toBe(false)
      expect(check.violations[0]!.code).toBe("wish_empty")
    }
  })

  it("blocks when the wish list is empty or all-blank (构造用例：wish_empty)", () => {
    const empty = validateWishAssembly(makeProfile({ wish: [] }))
    expect(empty.violations.map((v) => v.code)).toContain("wish_empty")

    const blank = validateWishAssembly(makeProfile({ wish: ["  ", "　"] }))
    expect(blank.violations[0]!.code).toBe("wish_empty")
  })

  it("blocks on an illegal or missing arc_stage (构造用例：arc_stage_invalid)", () => {
    const missing = validateWishAssembly(makeProfile({ arcStage: null }))
    expect(missing.violations[0]!.code).toBe("arc_stage_invalid")
    expect(missing.violations[0]!.message).toContain("未摄取")

    // 上游脏值（注册表外字符串）必须在装配门被拦下
    const dirty = validateWishAssembly(
      makeProfile({ arcStage: "super_saiyan" as ArcStage }),
    )
    expect(dirty.violations.some((v) => v.code === "arc_stage_invalid")).toBe(true)
    expect(dirty.violations.find((v) => v.code === "arc_stage_invalid")!.message).toContain(
      "super_saiyan",
    )
  })

  it("blocks on the wish-action gap in post-commitment stages (构造用例：stage_action_gap)", () => {
    for (const stage of ACTION_EVIDENCE_STAGES) {
      const check = validateWishAssembly(makeProfile({ arcStage: stage, wmaAction: [] }))
      expect(check.ok).toBe(false)
      expect(check.violations.some((v) => v.code === "stage_action_gap")).toBe(true)
    }
  })

  it("does not require action evidence in pre-commitment and resolution stages", () => {
    for (const stage of ["ghost_exposed", "refusal", "resolution"] as const) {
      const check = validateWishAssembly(makeProfile({ arcStage: stage, wmaAction: [] }))
      expect(check.ok).toBe(true)
    }
  })

  it("accumulates multiple violations", () => {
    const check = validateWishAssembly(
      makeProfile({ wish: [], arcStage: null, wmaAction: [] }),
    )
    expect(check.violations.map((v) => v.code)).toEqual(["wish_empty", "arc_stage_invalid"])
  })
})

// ── 引导问题序列构建（纯函数）───────────────────────────────────────

describe("buildWishDriveGuide", () => {
  it("emits the four W-M-A+confrontation questions with the stage hint", () => {
    const guide = buildWishDriveGuide(makeProfile({ arcStage: "crisis" }))
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
    const guide = buildWishDriveGuide(makeProfile({ motive: [] }))
    expect(guide.steps.find((s) => s.id === "motive")!.hint).toContain("动机清单为空")

    const full = buildWishDriveGuide(makeProfile())
    expect(full.steps.find((s) => s.id === "motive")!.hint).toContain("A-22.1")
  })

  it("degrades gracefully for an invalid stage (defensive; gate blocks normal entry)", () => {
    const guide = buildWishDriveGuide(
      makeProfile({ arcStage: "bogus" as ArcStage }),
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

  it("closes the entry with the violation list when A-22.6 fails (blocked)", () => {
    render(<WishDrive profile={makeProfile({ wish: [], arcStage: null })} />)
    const blocked = screen.getByTestId("wish-drive-blocked")
    expect(blocked).toHaveAttribute("role", "alert")
    expect(blocked).toHaveTextContent("A-22.6 装配校验未通过")
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
    expect(ready).toHaveTextContent("行动证据（wma_action）：1 条")
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
    let region = screen.getByRole("region", { name: /卡文引导（F-27 愿望驱动）· 林烬/ })
    expect(region).toBeInTheDocument()

    rerender(<WishDrive profile={makeProfile()} characterName="沈微" />)
    region = screen.getByRole("region", { name: /卡文引导（F-27 愿望驱动）· 沈微/ })
    expect(region).toBeInTheDocument()
  })

  it("falls back to a generic title when neither name is present", () => {
    render(<WishDrive profile={makeProfile({ displayName: undefined })} />)
    expect(
      screen.getByRole("region", { name: /卡文引导（F-27 愿望驱动）· 主角/ }),
    ).toBeInTheDocument()
  })
})
