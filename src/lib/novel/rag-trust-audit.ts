/**
 * RAG 来源信任审计（F-005 卡片点名的模块）。
 *
 * 定位：组合层，不是新评分器——把既有 `trust-grader` 的两条既有裁决
 * （来源许可分档 `licensePolicy`、ADR 分数归一 `normalizeADR`）合成一个
 * 「检索到的内容能不能用」的机械结论。阈值与分档表全部沿用 `trust-grader`，
 * 不引入任何新权重（架构不变量 4：无新评分器）。
 */

import {
  DEFAULT_TRUST_THRESHOLDS,
  GRADE_ORDER,
  licensePolicy,
  normalizeADR,
  type TrustGrade,
  type TrustThresholds,
} from "./trust-grader";

export interface RagTrustInput {
  /** 来源许可证标识（缺失按最保守处理）。 */
  license?: string;
  /** 来源 ADR 分数（0~1）；缺失时不做 ADR 归一。 */
  adrScore?: number;
  thresholds?: TrustThresholds;
}

export interface RagTrustVerdict {
  grade: TrustGrade;
  /** 机械结论：只有非 blocked 才允许继续。 */
  action: "allow" | "block";
  reasons: string[];
}

/**
 * 合成结论 = 两个既有裁决里更严的那个（取 GRADE_ORDER 较小值）。
 * 缺许可证一律按 `blocked`（不猜许可）。
 */
export function auditRagSource(input: RagTrustInput): RagTrustVerdict {
  const thresholds = input.thresholds ?? DEFAULT_TRUST_THRESHOLDS;
  const reasons: string[] = [];

  const byLicense: TrustGrade = input.license ? licensePolicy(input.license) : "blocked";
  if (!input.license) {
    reasons.push("no license declared; source cannot be used");
  } else {
    reasons.push(`license '${input.license}' -> ${byLicense}`);
  }

  let byAdr: TrustGrade = "full";
  if (typeof input.adrScore === "number") {
    byAdr = normalizeADR(input.adrScore, thresholds);
    reasons.push(`ADR score -> ${byAdr}`);
  }

  const grade: TrustGrade = GRADE_ORDER[byLicense] <= GRADE_ORDER[byAdr] ? byLicense : byAdr;

  return { grade, action: grade === "blocked" ? "block" : "allow", reasons };
}

/** 是否为可放行结论（供上游门禁使用）。 */
export function isRagTrustAllowed(verdict: RagTrustVerdict): boolean {
  return verdict.action === "allow";
}
