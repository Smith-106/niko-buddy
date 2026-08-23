/**
 * wish-drive.tsx — F-27 卡文引导流入口（T29b：wish 清单装配可见）。
 *
 * 职责（TASK-P3-29b / 蓝图 S3 卡文场景）：
 *   情节卡文时，以「愿望—动机—行动」范式（craft.wish-motive-action 规则包，
 *   T27b technique-compiler：plot_stall_recovery="ask_wish_motive"）装配主角
 *   技法字段并输出结构化引导问题序列。
 *
 * A-22.6 装配门（硬门，构造用例命中）：
 *   卡文场景 task_brief 装配的 wish 清单必须**非空**且与当前 arc_stage **自洽**
 *   ——校验不过，引导入口关闭（blocked 态），不产出半成品引导。
 *   自洽的机械定义（零 LLM，可被构造用例命中）：
 *     1. wish 非空（且至少一条非空白）；
 *     2. arc_stage 是 U-04 提案 7 值注册表的合法值；
 *     3. 承诺后推进段（commitment/active/crisis/climax）wish 必须已有行动证据
 *        （wma_action 非空）：愿望—行动断层即卡文根因。觉醒前两段
 *        （ghost_exposed/refusal）与收束段（resolution）不强制行动证据。
 *
 * 数据源：T26 `canon-craft-fields.ts` entities 表技法列
 * （wish / motive / wma_action / arc_stage），由调用方注入（props-DI，
 * 与 arc-workbench 同型态；本组件零 IO、零 invoke、零 LLM）。
 *
 * Draft-first（ADR-08）：纯只读装配视图，不写运行时会话状态，不触及草稿正式层。
 */

import { useMemo } from "react"
import {
  isArcStage,
  type ArcStage,
} from "@/lib/novel/craft/canon-craft-fields"

// ============================================================================
// 输入画像（T26 canon-craft-fields entities 技法字段的卡文场景投影）
// ============================================================================

export interface WishDriveProfile {
  /** 目标 entity id（canon entities 表主键）。 */
  entityId: string
  /** 角色显示名（可选，用于标题）。 */
  displayName?: string
  /** 愿望清单（W-M-A 的 W；A-22.6 硬门要求非空）。 */
  wish?: readonly string[] | null
  /** 动机清单（为什么要；A-22.1 与 wish 强制区分）。 */
  motive?: readonly string[] | null
  /** 愿望—动机驱动的行动清单（自洽性第 3 条的行动证据）。 */
  wmaAction?: readonly string[] | null
  /**
   * 当前弧光阶段（U-04 提案 7 值）。
   * 类型面为 ArcStage，但运行时仍经 {@link isArcStage} 兜底——上游摄取的脏值
   * 必须在装配门被拦下（arc_stage_invalid），不得带病进入引导流。
   */
  arcStage?: ArcStage | null
}

function nonBlank(values: readonly string[] | null | undefined): string[] {
  if (!values) return []
  return values.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
}

// ============================================================================
// A-22.6 装配校验（纯函数，零 LLM）
// ============================================================================

/** 装配违规码。 */
export type WishDriveViolationCode =
  | "wish_empty"
  | "arc_stage_invalid"
  | "stage_action_gap"

export interface WishDriveViolation {
  code: WishDriveViolationCode
  message: string
}

export interface WishAssemblyCheck {
  ok: boolean
  violations: WishDriveViolation[]
}

/** 承诺后推进段：wish 必须已有行动证据（愿望—行动断层即卡文根因）。 */
export const ACTION_EVIDENCE_STAGES: readonly ArcStage[] = [
  "commitment",
  "active",
  "crisis",
  "climax",
]

const STAGE_LABELS: Record<ArcStage, string> = {
  ghost_exposed: "鬼魂暴露",
  refusal: "拒绝召唤",
  commitment: "承诺行动",
  active: "主动推进",
  crisis: "危机升级",
  climax: "高潮对决",
  resolution: "解决收束",
}

/**
 * A-22.6 装配校验：wish 清单非空 且 与当前 arc_stage 自洽（机械规则见文件头）。
 * profile 缺失视同 wish_empty（清单非空门必然不过），fail-closed。
 */
export function validateWishAssembly(
  profile: WishDriveProfile | null | undefined,
): WishAssemblyCheck {
  if (!profile) {
    return {
      ok: false,
      violations: [
        {
          code: "wish_empty",
          message:
            "主角技法画像缺失（尚未摄取 T26 entities.wish/motive/arc_stage），卡文引导入口关闭",
        },
      ],
    }
  }

  const violations: WishDriveViolation[] = []

  // 1) wish 非空（至少一条非空白项）
  const wishes = nonBlank(profile.wish)
  if (wishes.length === 0) {
    violations.push({
      code: "wish_empty",
      message:
        "wish 清单为空（A-22.6 要求装配清单非空）：先补齐主角愿望，再进入卡文引导",
    })
  }

  // 2) arc_stage 合法（U-04 提案 7 值注册表）
  const stageOk = profile.arcStage != null && isArcStage(profile.arcStage)
  if (!stageOk) {
    violations.push({
      code: "arc_stage_invalid",
      message: `arc_stage ${
        profile.arcStage == null ? "未摄取" : `「${String(profile.arcStage)}」非法`
      }，无法验证与 wish 清单自洽（U-04 提案 7 值注册表）`,
    })
  }

  // 3) 承诺后推进段须有行动证据
  if (stageOk && ACTION_EVIDENCE_STAGES.includes(profile.arcStage as ArcStage)) {
    const actions = nonBlank(profile.wmaAction)
    if (actions.length === 0) {
      violations.push({
        code: "stage_action_gap",
        message: `弧光处于「${STAGE_LABELS[profile.arcStage as ArcStage]}」阶段但 wma_action 无行动证据：愿望—行动断层是卡文根因，先登记一条最小可见行动`,
      })
    }
  }

  return { ok: violations.length === 0, violations }
}

// ============================================================================
// 引导问题序列构建（纯函数；前置条件 validateWishAssembly.ok）
// ============================================================================

/** 引导步骤 id（W-M-A + 对抗建构四问）。 */
export type WishDriveStepId = "wish" | "motive" | "action" | "confrontation"

export interface WishDriveStep {
  id: WishDriveStepId
  question: string
  hint: string
}

export interface WishDriveGuide {
  stageLabel: string
  stageHint: string
  steps: readonly WishDriveStep[]
}

const STAGE_HINTS: Record<ArcStage, string> = {
  ghost_exposed: "让过去的创伤在本章以一个具体场景浮出水面，解释愿望为何开始生根",
  refusal: "写主角拒绝行动的理由：让他有充分理由说「不」，再让事件剥夺这个理由",
  commitment: "让主角主动做出不可撤回的承诺；承诺本身要付出可见代价",
  active: "围绕愿望设计递进行动链，每次行动都改变力量对比",
  crisis: "让对抗力量压制愿望：主角承压但不得退回原点",
  climax: "愿望与对抗正面对撞；胜负由主角的选择决定，禁止巧合收场",
  resolution: "展示愿望达成或转变后的新常态，兑现读者对主角愿望—命运的期待",
}

/**
 * 构建卡文引导问题序列（前置：validateWishAssembly(profile).ok）。
 * stage 异常时降级为通用文案（防御式；正常入口已被装配门拦截）。
 */
export function buildWishDriveGuide(profile: WishDriveProfile): WishDriveGuide {
  const stage: ArcStage | null =
    profile.arcStage != null && isArcStage(profile.arcStage) ? profile.arcStage : null

  const hasMotive = nonBlank(profile.motive).length > 0

  return {
    stageLabel: stage ? STAGE_LABELS[stage] : "未定阶段",
    stageHint: stage ? STAGE_HINTS[stage] : "先校正 arc_stage 再深化阶段指引",
    steps: [
      {
        id: "wish",
        question: "主角此刻最想要什么？",
        hint: "从装配的愿望清单中选定本章驱动力；多条愿望冲突时选最迫切的一条",
      },
      {
        id: "motive",
        question: "他为什么想要？",
        hint: hasMotive
          ? "动机与愿望强制区分（A-22.1）：wish=想要什么，motive=为什么要"
          : "动机清单为空：先回答「为什么」，否则行动没有情感根基",
      },
      {
        id: "action",
        question: "为了得到它，本章他能采取的最小可见行动是什么？",
        hint: stage ? STAGE_HINTS[stage] : STAGE_HINTS.active,
      },
      {
        id: "confrontation",
        question: "谁或什么在阻止他？",
        hint: "主要人物间的愿望应相互冲突以建构对抗性情节；写下与本愿望正面相撞的力量",
      },
    ],
  }
}

// ============================================================================
// 组件
// ============================================================================

export interface WishDriveProps {
  /** 主角技法画像（T26 canon-craft-fields 投影）；null = 尚未摄取。 */
  profile: WishDriveProfile | null
  /** 角色名（可选，覆盖 displayName 用于标题）。 */
  characterName?: string
  className?: string
}

export function WishDrive({ profile, characterName, className }: WishDriveProps) {
  const check = useMemo(() => validateWishAssembly(profile), [profile])
  const guide = useMemo(
    () => (check.ok && profile ? buildWishDriveGuide(profile) : null),
    [check, profile],
  )

  const title = characterName ?? profile?.displayName ?? "主角"

  return (
    <div
      className={className ?? "flex h-full flex-col gap-4 p-4"}
      role="region"
      aria-label={`卡文引导（F-27 愿望驱动）· ${title}`}
      data-testid="wish-drive-root"
    >
      <header>
        <h3 className="text-sm font-semibold text-foreground">卡文引导 · 愿望驱动</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {title} · 数据源 T26 canon-craft-fields（wish/motive/wma_action/arc_stage）· A-22.6 装配门
        </p>
      </header>

      {!profile && (
        <div
          className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
          data-testid="wish-drive-empty"
        >
          <p>尚未摄取主角技法字段。</p>
          <p className="text-xs italic">先完成技法摄取（entities.wish/motive/arc_stage），再进入卡文引导。</p>
        </div>
      )}

      {profile && !check.ok && (
        <div
          className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm"
          role="alert"
          data-testid="wish-drive-blocked"
        >
          <p className="font-medium text-foreground">A-22.6 装配校验未通过 —— 卡文引导入口关闭</p>
          <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted-foreground">
            {check.violations.map((v) => (
              <li key={v.code} data-testid={`wish-drive-violation-${v.code}`}>
                [{v.code}] {v.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {profile && check.ok && guide && (
        <div className="flex flex-col gap-4" data-testid="wish-drive-ready">
          {/* 装配可见：wish 清单 + 动机 + 行动证据 + 弧光阶段 */}
          <section aria-label="装配的技法字段" className="rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">装配的愿望清单（wish）</span>
              <span
                className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
                data-testid="wish-drive-stage-badge"
              >
                弧光阶段：{guide.stageLabel}
              </span>
            </div>
            <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-sm" data-testid="wish-assembled-list">
              {nonBlank(profile.wish).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <dl className="mt-2 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
              <div>
                <dt className="inline text-muted-foreground">动机（motive）：</dt>
                <dd className="inline">{nonBlank(profile.motive).join("、") || "—"}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">行动证据（wma_action）：</dt>
                <dd className="inline">{nonBlank(profile.wmaAction).length || 0} 条</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs italic text-muted-foreground">阶段指引：{guide.stageHint}</p>
          </section>

          {/* 引导问题序列 */}
          <section aria-label="卡文引导问题序列">
            <ol className="space-y-2" data-testid="wish-drive-steps">
              {guide.steps.map((step, i) => (
                <li key={step.id} className="rounded-lg border p-3" data-testid={`wish-drive-step-${step.id}`}>
                  <p className="text-sm font-medium text-foreground">
                    {i + 1}. {step.question}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{step.hint}</p>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </div>
  )
}
