/**
 * ANL-009 deferred-trigger 监测机制 (S5 safety-valve)。
 *
 * ANL-009 判定 direct-API + OAuth 凭证复用重构 = NO-GO:
 *   - Anthropic ToS 禁第三方 OAuth 复用
 *   - extra_usage 计费池蒸发订阅护城河
 *
 * 本模块不是绕过 NO-GO, 而是一个"安全阀": 监测 ToS 变化 / first-party
 * embedded SDK 可用性等触发条件, 当条件满足时生成 reassessment issue
 * 记录, 供未来人工裁决是否重新评估 ANL-009。当前 hasTrigger 始终 false
 * (除非显式传入已知触发条件), 实际轮询逻辑 (URL / SDK 版本) 由后续
 * wiring 注入。
 *
 * ARCH-008 (wiring status): buildReassessmentIssue 生成的 issue JSON 当前
 * 无 production caller 追加到 issues.jsonl — 这是 ANL-009 S5 的预期状态
 * (NO-GO 仍 enforced, 触发条件未满足)。wiring 推迟到 Stage 5 sidecar:
 * 届时 app 启动时调用 monitorTosTriggers, hasTrigger=true 时将 issue JSON
 * 追加 issues.jsonl。在此之前, 本模块作为 read-only safety-valve 文档化
 * 存在, 不构成执行路径。
 *
 * 边界守恒:
 *   - 不做直接 API 复用
 *   - 不改 llm-client.ts transport
 *   - 不修改 issues.jsonl (只生成 issue JSON, caller 决定是否追加)
 */

/** ANL-009 deferred-trigger 监测条件 */
export interface TosTriggerCondition {
  /** 触发类型 */
  type: "tos_change" | "embedded_sdk_available" | "official_oauth_first_party" | "billing_model_change"
  /** 触发描述 */
  description: string
  /** 检测到的证据 (URL / changelog / SDK 版本) */
  evidence: string
  /** 检测时间 ISO */
  detectedAt: string
}

/** 监测结果: 是否有触发条件满足 (满足则应记录 issue 重新评估 ANL-009) */
export interface TosTriggerMonitorResult {
  hasTrigger: boolean
  triggers: TosTriggerCondition[]
  /** ANL-009 当前状态 (始终 "no_go" 直到触发条件满足且人工裁决) */
  anl009Status: "no_go" | "reassessment_recommended"
  note: string
}

/** 触发条件满足时生成的 reassessment issue 记录 */
export interface TosReassessmentIssue {
  id: string
  title: string
  type: "reassessment"
  severity: "info"
  status: "open"
  source: "tos-trigger-monitor"
  description: string
  related: string
  created_at: string
}

const ANL009_NO_GO_NOTE =
  "ANL-009 NO-GO intact: direct-API + OAuth credential reuse refactor remains blocked (Anthropic ToS + extra_usage billing moat). No triggers detected."

const ANL009_REASSESS_NOTE =
  "ANL-009 reassessment recommended: a deferred-trigger condition has been detected. Manual review required before any code change; NO-GO still enforced until human override."

function isValidCondition(condition: TosTriggerCondition): boolean {
  return (
    typeof condition.type === "string" &&
    typeof condition.description === "string" &&
    condition.description.trim().length > 0 &&
    typeof condition.evidence === "string" &&
    condition.evidence.trim().length > 0 &&
    typeof condition.detectedAt === "string" &&
    condition.detectedAt.trim().length > 0
  )
}

/**
 * 检测 ANL-009 deferred-trigger 条件。
 *
 * 当前实现: 无 knownConditions 时返回空触发 (hasTrigger=false,
 * anl009Status="no_go") — 监测框架就位, 实际检测逻辑 (URL 轮询 /
 * SDK 版本检查) 由后续 wiring 注入。
 *
 * 这是"安全阀": 当 Anthropic 发布 first-party embedded SDK 或 ToS
 * 明确允许第三方复用时, 此函数应返回 hasTrigger=true 触发重新评估。
 *
 * @param knownConditions 外部 wiring 注入的已知触发条件 (默认 undefined)
 */
export function checkTosTriggers(knownConditions?: TosTriggerCondition[]): TosTriggerMonitorResult {
  if (!knownConditions || knownConditions.length === 0) {
    return {
      hasTrigger: false,
      triggers: [],
      anl009Status: "no_go",
      note: ANL009_NO_GO_NOTE,
    }
  }

  const validTriggers = knownConditions.filter(isValidCondition)

  if (validTriggers.length === 0) {
    return {
      hasTrigger: false,
      triggers: [],
      anl009Status: "no_go",
      note: ANL009_NO_GO_NOTE,
    }
  }

  return {
    hasTrigger: true,
    triggers: validTriggers,
    anl009Status: "reassessment_recommended",
    note: ANL009_REASSESS_NOTE,
  }
}

/**
 * 当触发条件满足时, 生成 issue 记录供未来决策。
 *
 * 返回 issue JSON (caller 负责追加到 issues.jsonl)。本函数不写入文件,
 * 不修改 issues.jsonl — 由 caller 决定是否追加。
 *
 * @param trigger 满足的触发条件
 */
export function buildReassessmentIssue(trigger: TosTriggerCondition): TosReassessmentIssue {
  const timestamp = trigger.detectedAt || new Date().toISOString()
  const typeLabel = trigger.type.replace(/_/g, " ")
  const issueId = `ISS-ANL009-REASSESS-${timestamp.replace(/[^0-9TZ]/g, "").slice(0, 15)}`

  return {
    id: issueId,
    title: `ANL-009 reassessment trigger: ${typeLabel}`,
    type: "reassessment",
    severity: "info",
    status: "open",
    source: "tos-trigger-monitor",
    description:
      `ANL-009 deferred-trigger detected. Type: ${trigger.type}. ` +
      `Description: ${trigger.description}. ` +
      `Evidence: ${trigger.evidence}. ` +
      `Manual review required to determine whether ANL-009 NO-GO should be re-evaluated. ` +
      `NO-GO remains enforced until explicit human override.`,
    related: "ANL-009",
    created_at: timestamp,
  }
}
