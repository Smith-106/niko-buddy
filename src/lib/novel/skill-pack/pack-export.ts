/**
 * 技能包导出（F-006）：从既有 user-skill-store 读取选中技能，序列化为单文件。
 *
 * 硬约束：导出物**不含任何凭据字段**；识别到凭据类键名时导出前剔除并记录告警。
 * 本模块不做网络请求，也不新增存储位置——写盘交给既有 fs 写入命令（由调用方执行）。
 */

import type { UserSkill } from "../skill-library";
import type { TrustLevel } from "../trust-authority";import {
  NBSKILL_PACK_KIND,
  NBSKILL_PACK_SCHEMA_VERSION,
  packFileName,
  type NbskillPack,
  type PackPromptSpec,
  type PackToolSpec,
} from "./pack-format";

/** 凭据类键名（小写包含匹配）。命中即剔除。 */
export const CREDENTIAL_KEY_PARTS = [
  "token",
  "secret",
  "password",
  "passphrase",
  "apikey",
  "api-key",
  "credential",
  "authorization",
  "bearer",
] as const;

export interface ExportOptions {
  name: string;
  version: string;
  author?: string;
  tools?: PackToolSpec[];
  /** 导出时的信任级别；默认按本地证据重新分类，不继承来源级别。 */
  trustLevel?: TrustLevel;
}

export interface ExportResult {
  fileName: string;
  pack: NbskillPack;
  /** 剔除告警（不静默）。 */
  warnings: string[];
}

export function isCredentialLikeKey(key: string): boolean {
  const lowered = key.toLowerCase().replace(/_/g, "-");
  return CREDENTIAL_KEY_PARTS.some((part) => lowered.includes(part));
}

/**
 * 剔除对象里的凭据类键（递归，不改原对象）。返回剔除后的对象与命中的键路径。
 */
export function stripCredentialKeys(
  value: unknown,
  trail = "",
): { value: unknown; stripped: string[] } {
  if (Array.isArray(value)) {
    const stripped: string[] = [];
    const next = value.map((item, index) => {
      const result = stripCredentialKeys(item, `${trail}[${index}]`);
      stripped.push(...result.stripped);
      return result.value;
    });
    return { value: next, stripped };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const stripped: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = trail ? `${trail}.${key}` : key;
      if (isCredentialLikeKey(key)) {
        stripped.push(path);
        continue;
      }
      const result = stripCredentialKeys(child, path);
      stripped.push(...result.stripped);
      out[key] = result.value;
    }
    return { value: out, stripped };
  }
  return { value, stripped: [] };
}

/** 技能正文里若含凭据类行，导出前剔除该行并告警。 */
export function stripCredentialLines(body: string): { body: string; stripped: number } {
  const lines = body.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const colon = line.indexOf(":");
    if (colon <= 0) return true;
    const key = line.slice(0, colon).trim();
    return !isCredentialLikeKey(key);
  });
  return { body: kept.join("\n"), stripped: lines.length - kept.length };
}

export function buildPack(
  skills: UserSkill[],
  options: ExportOptions,
): ExportResult {
  const warnings: string[] = [];
  let strippedCount = 0;

  const prompts: PackPromptSpec[] = skills.map((skill, index) => {
    const cleaned = stripCredentialLines(skill.content ?? "");
    strippedCount += cleaned.stripped;
    return {
      id: skill.id || `prompt-${index}`,
      body: cleaned.body.length > 0 ? cleaned.body : "(empty)",
    };
  });

  const tools = (options.tools ?? []).flatMap((tool) => {
    const cleaned = stripCredentialKeys(tool);
    if (cleaned.stripped.length > 0) {
      warnings.push(`stripped credential-like fields from tool: ${cleaned.stripped.join(", ")}`);
      return [];
    }
    return [tool];
  });

  if (strippedCount > 0) {
    warnings.push(`stripped ${strippedCount} credential-like line(s) from prompt bodies`);
  }
  if (skills.length === 0) {
    warnings.push("no skills selected; pack will contain no prompts");
  }

  const pack: NbskillPack = {
    schemaVersion: NBSKILL_PACK_SCHEMA_VERSION,
    kind: NBSKILL_PACK_KIND,
    name: options.name,
    version: options.version,
    author: options.author ?? "",
    tools,
    prompts,
    trustLevel: options.trustLevel ?? "untrusted",
  };

  const cleanedPack = stripCredentialKeys(pack);
  if (cleanedPack.stripped.length > 0) {
    warnings.push(`stripped credential-like fields: ${cleanedPack.stripped.join(", ")}`);
  }

  return {
    fileName: packFileName(options.name),
    pack: cleanedPack.value as NbskillPack,
    warnings,
  };
}

/** 序列化为单文件文本（JSON，稳定两空格缩进）。 */
export function serializePack(result: ExportResult): string {
  return `${JSON.stringify(result.pack, null, 2)}\n`;
}
