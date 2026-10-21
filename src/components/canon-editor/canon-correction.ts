import type { RawCanonEdge } from "@/lib/novel"
import { fnv1aHex } from "@/lib/utils"

// ============================================================================
// wire 契约（与 src-tauri/src/canon_commands.rs serde snake_case 对齐）
// ============================================================================

/** `canon_supersede_edges` 请求体（SupersedeRequest 镜像）。 */
export interface CanonSupersedeRequest {
  /** 被取代的旧边 id 列表。 */
  old_edge_ids: string[]
  /** 封顶章节（旧边 invalid_at 写入值）。 */
  cap_chapter: number
  /** 后继新边（id 由调用方生成）。 */
  new_edges: RawCanonEdge[]
  /** §B 审计溯源标记：人工校正 supersede 的高审计粒度标记。 */
  caused_by?: string
}

/** `canon_supersede_edges` 响应体（CanonSupersedeResponse 镜像）。 */
export interface CanonSupersedeResponse {
  result: {
    capped: number
    inserted: number
    missing: string[]
  }
  max_revision: number
}

// ============================================================================
// 校正载荷构建（纯函数）
// ============================================================================

/**
 * 生成校正后继边的 id（纯函数；salt 由调用方注入时间戳/序数以保证全局唯一）。
 * Rust 侧约定「后继新边由调用方生成全新 id」。
 */
export function makeCorrectionId(oldId: string, salt: string): string {
  return `corr:${oldId}:${salt}`
}

/** FNV-1a 32 位摘要（十六进制）。校正后继边的写路径幂等键（确定性，同内容同值）。 */
export function computeCorrectionDigest(input: string): string {
  return fnv1aHex(input)
}

/**
 * 把一条原始边 + 认知轴补丁装配为 `canon_supersede_edges` 请求（纯函数）。
 *
 * - 旧边封顶章 = `old.valid_at ?? 0`：旧边自生效点起即被后继取代（无缝替换，
 *   且恒满足 valid_at <= invalid_at 时态不变量）；已封顶旧边重复封顶无害。
 * - 后继边继承旧边全部字段（含 world 时态 valid_at/invalid_at 与技法列），
 *   仅覆盖 id / known_by / revealed_at，并重算 digest；archived 归一为 false。
 *
 * @param salt 校正 id 后缀盐（调用方注入，测试传固定值）
 */
export function buildSupersedeRequestForCorrection(
  old: RawCanonEdge,
  patch: { knownBy: readonly string[]; revealedAt: number | null },
  salt: string,
): CanonSupersedeRequest {
  const newId = makeCorrectionId(old.id, salt)
  const newEdge: RawCanonEdge = {
    ...old,
    id: newId,
    known_by: [...patch.knownBy],
    revealed_at: patch.revealedAt,
    archived: false,
    digest: computeCorrectionDigest(
      `${newId}|${patch.knownBy.join(",")}|${patch.revealedAt ?? ""}`,
    ),
  }
  return {
    old_edge_ids: [old.id],
    cap_chapter: old.valid_at ?? 0,
    new_edges: [newEdge],
    // §B causedBy：人工校正 supersede 的审计溯源标记
    caused_by: "manual-correction",
  }
}

// ============================================================================
// 校正校验（纯函数；POV 防泄密 + 时态不变量，客户端 fail-closed 拦截）
// ============================================================================

/** 校验违规码（与消息一一对应，供 spec 断言与 UI 徽标）。 */
export type CorrectionViolationCode =
  | "empty_pov"
  | "duplicate_pov"
  | "not_in_allowlist"
  | "invalid_revealed_at"
  | "revealed_before_valid"
  | "revealed_without_known_by"

export interface CorrectionViolation {
  code: CorrectionViolationCode
  message: string
}

export interface CorrectionValidation {
  ok: boolean
  violations: CorrectionViolation[]
}

/**
 * known_by 白名单校验（POV 防泄密核心守卫，fail-closed）：
 *   - 空白条目 → empty_pov；
 *   - 重复条目 → duplicate_pov；
 *   - 不在白名单 → not_in_allowlist（白名单空 = 全部拒绝增补，只允许移除）。
 */
export function validateKnownByCorrection(
  nextKnownBy: readonly unknown[],
  allowlist: readonly string[],
): CorrectionValidation {
  const violations: CorrectionViolation[] = []
  const seen = new Set<string>()
  for (const raw of nextKnownBy) {
    const pov = typeof raw === "string" ? raw.trim() : ""
    if (!pov) {
      violations.push({ code: "empty_pov", message: "知晓角色里有空白条目，请删掉或填入角色" })
      continue
    }
    if (seen.has(pov)) {
      violations.push({ code: "duplicate_pov", message: `知晓角色重复：${pov}` })
      continue
    }
    seen.add(pov)
    if (!allowlist.includes(pov)) {
      violations.push({
        code: "not_in_allowlist",
        message: `「${pov}」不在项目角色白名单内，只能添加白名单中的角色`,
      })
    }
  }
  return { ok: violations.length === 0, violations }
}

/**
 * revealed_at 时态不变量校验（与 Rust validate_edge_temporal 对齐）：
 *   - 非 null 必须为 ≥1 整数（1-based 章节号）→ 否则 invalid_revealed_at；
 *   - revealed_at < valid_at → revealed_before_valid（揭示早于事实生效）；
 *   - revealed_at 非空但 known_by 为空 → revealed_without_known_by。
 */
export function validateRevealedAtCorrection(
  revealedAt: number | null,
  validAt: number | null | undefined,
  knownByCount: number,
): CorrectionValidation {
  const violations: CorrectionViolation[] = []
  if (revealedAt !== null) {
    if (!Number.isInteger(revealedAt) || revealedAt < 1) {
      violations.push({
        code: "invalid_revealed_at",
        message: "揭晓章节必须是 ≥1 的整数（留空表示尚未揭晓）",
      })
    } else if (validAt != null && revealedAt < validAt) {
      violations.push({
        code: "revealed_before_valid",
        message: `揭晓章节（第${revealedAt}章）早于生效章节（第${validAt}章）：揭示不能早于事实生效`,
      })
    } else if (knownByCount === 0) {
      violations.push({
        code: "revealed_without_known_by",
        message: "已填写揭晓章节，但知晓角色为空：没人知道的事实无法被揭示",
      })
    }
  }
  return { ok: violations.length === 0, violations }
}
