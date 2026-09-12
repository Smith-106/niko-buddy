/**
 * 技能包信任分级（F-006）。
 *
 * 定位（与既有 `trust-grader` 的关系）：本模块是**规则分类器**，不是评分器——
 * 它只把「已声明的来源事实」映射到三档信任级别，不引入任何权重、阈值或打分公式
 * （架构不变量 4：无新评分器）。`trust-grader` 继续负责来源许可/ADR 分档，
 * 本模块只回答一个问题：**这个技能包能不能被当作可信内容使用**。
 *
 * 升级路径是**显式 + 本地**的：导入的一律 `untrusted`；只有用户在本地做过评审
 * （`reviewedLocally`）才可能到 `reviewed`；再叠加作者标识可验证才到 `trusted`。
 */

export const TRUST_LEVELS = ["untrusted", "reviewed", "trusted"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** 导入通道。当前只有本地文件一种——没有任何托管市场通道。 */
export const TRUST_ORIGINS = ["local-file", "project-builtin"] as const;
export type TrustOrigin = (typeof TRUST_ORIGINS)[number];

export interface TrustEvidence {
  origin: TrustOrigin;
  /** 作者字段是否可验证（例如与本项目已知作者一致）。默认不可验证。 */
  authorVerified?: boolean;
  /** 用户是否在本地逐条评审过（显式动作，非自动推断）。 */
  reviewedLocally?: boolean;
}

/**
 * 分档规则（确定性，无阈值）：
 *
 * | 条件 | 级别 |
 * |---|---|
 * | 项目内置 | trusted |
 * | 本地文件 + 本地评审 + 作者可验证 | trusted |
 * | 本地文件 + 本地评审 | reviewed |
 * | 其余（含默认） | untrusted |
 */
export function classifyTrustLevel(evidence: TrustEvidence): TrustLevel {
  if (evidence.origin === "project-builtin") return "trusted";
  const reviewed = evidence.reviewedLocally === true;
  if (!reviewed) return "untrusted";
  return evidence.authorVerified === true ? "trusted" : "reviewed";
}

/** 导入场景的默认证据：一律 untrusted，直到本地评审发生。 */
export function importEvidence(): TrustEvidence {
  return { origin: "local-file", authorVerified: false, reviewedLocally: false };
}

/** 该级别是否允许其内容直接进入正式正文/正式记忆（仅 trusted/reviewed 可以）。 */
export function mayEnterCanonTruth(level: TrustLevel): boolean {
  return level === "trusted" || level === "reviewed";
}

export function isTrustLevel(value: unknown): value is TrustLevel {
  return typeof value === "string" && (TRUST_LEVELS as readonly string[]).includes(value);
}
