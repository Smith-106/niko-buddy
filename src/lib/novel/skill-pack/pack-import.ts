/**
 * 技能包导入（F-006）。
 *
 * 顺序是硬的：**先整包校验 → 再定信任级别 → 最后经既有存储落盘**。
 * * 校验阶段任何 issue（白名单外的工具分类、非法工具名、schemaVersion 非 1……）
 *   都导致**整包拒绝**，不做部分导入。
 * * 信任级别由 `trust-authority` 计算：导入默认 `untrusted`；包自报的 `trustLevel`
 *   只作为「声明」记录，**不采信为结果**（否则导入即自我提权）。
 * * 落盘复用既有 `user-skill-store` / `skill-library` 结构。
 * * 本模块不发任何网络请求（无托管市场通道）。
 */

import { normalizeUserSkill, type UserSkill } from "../skill-library";
import { USER_SKILL_CONFIG_FILE, type UserSkillConfig } from "../user-skill-store";
import { classifyTrustLevel, importEvidence, type TrustLevel } from "../trust-authority";
import {
  parseNbskillPack,
  type PackValidationIssue,
  type NbskillPack,
} from "./pack-format";

export interface ImportContext {
  /** 目标分类 id（既有 user-skill-store 的分类概念）。 */
  categoryId: string;
  /** 是否在本地逐条评审过（默认 false → untrusted）。 */
  reviewedLocally?: boolean;
  authorVerified?: boolean;
  now?: number;
}

export interface ImportSuccess {
  ok: true;
  trustLevel: TrustLevel;
  /** 包自报级别；仅作记录，永不作为最终级别。 */
  declaredTrustLevel: TrustLevel;
  warnings: string[];
  skills: UserSkill[];
}

export interface ImportFailure {
  ok: false;
  issues: PackValidationIssue[];
}

export type ImportResult = ImportSuccess | ImportFailure;

/**
 * 把技能包转为可落盘的 `UserSkill[]`。
 * 返回值中的 `trustLevel` 才是应当写库的级别；`declaredTrustLevel` 只用于展示差异。
 */
export function importNbskillPack(raw: unknown, context: ImportContext): ImportResult {
  const parsed = parseNbskillPack(raw);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues };
  }

  const pack: NbskillPack = parsed.pack;
  const trustLevel = classifyTrustLevel({
    ...importEvidence(),
    reviewedLocally: context.reviewedLocally === true,
    authorVerified: context.authorVerified === true,
  });

  const warnings = [...parsed.warnings];
  if (pack.trustLevel !== trustLevel) {
    warnings.push(
      `pack declared trustLevel=${pack.trustLevel}; import re-classified it as ${trustLevel}`,
    );
  }

  const now = context.now ?? Date.now();
  const skills: UserSkill[] = pack.prompts.map((prompt) =>
    normalizeUserSkill({
      id: prompt.id,
      name: `${pack.name} · ${prompt.id}`,
      description: `imported from ${pack.name}@${pack.version} (trustLevel=${trustLevel})`,
      content: prompt.body,
      source: "uploaded",
      categoryId: context.categoryId,
      tags: pack.tools.map((tool) => tool.category),
      createdAt: now,
      updatedAt: now,
    }),
  );

  return {
    ok: true,
    trustLevel,
    declaredTrustLevel: pack.trustLevel,
    warnings,
    skills,
  };
}

/** 导入落盘目标文件（复用 `user-skill-store` 的单一真源，不另起存储位置）。 */
export function importedSkillsTargetFile(): string {
  return USER_SKILL_CONFIG_FILE;
}

/** 已导入技能在既有配置里的存放位置（只读视图，不修改传入配置）。 */
export function importedSkillsOf(config: UserSkillConfig): UserSkill[] {
  return config.skills.filter((skill) => skill.source === "uploaded");
}

/** 导入失败时的可读错误列表（供面板逐条展示）。 */
export function describeIssues(issues: PackValidationIssue[]): string[] {
  return issues.map((issue) => (issue.at ? `${issue.at}: ${issue.detail}` : issue.detail));
}
