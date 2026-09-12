/**
 * 技能包（.nbskill.json）格式契约（F-006）。
 *
 * 与既有 `nbskill/1` 目录包协议（`commands/skill_bundle.rs` / `skill-bundle-client.ts`）的关系：
 * 后者是**目录包**（多文件 + manifest + content_hash），本模块是**单文件交换格式**，
 * 复用同一套「只读声明 + 可写产物声明、无任何执行通道」的语义，不复用其容器布局。
 *
 * 工具分类白名单刻意只保留两类：`readable-state`（只读声明）与 `writable-artifact`
 * （可写产物）。没有 execute / network 类——技能包不允许携带任何可执行或联网能力。
 */

import { z } from "zod";

export const NBSKILL_PACK_SCHEMA_VERSION = 1;
export const NBSKILL_PACK_EXTENSION = ".nbskill.json";
export const NBSKILL_PACK_KIND = "nbskill";

/** 允许的工具分类（白名单外一律整包拒绝）。 */
export const PACK_TOOL_CATEGORIES = ["readable-state", "writable-artifact"] as const;
export type PackToolCategory = (typeof PACK_TOOL_CATEGORIES)[number];

/** 信任级别（与 `trust-authority` 同一字面量集合）。 */
export const PACK_TRUST_LEVELS = ["untrusted", "reviewed", "trusted"] as const;
export type PackTrustLevel = (typeof PACK_TRUST_LEVELS)[number];

/** 工具名：小写字母开头，仅字母/数字/`-`/`_`。 */
export const PACK_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** 技能名（同时决定导出文件名）。 */
export const PACK_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 明确禁止的工具名片段（防执行通道；只做名字层拦截，不做任何求值）。 */
const FORBIDDEN_TOOL_NAME_PARTS = ["exec", "shell", "spawn", "eval", "script"];

/** 分类是否在白名单内。 */
export function isAllowedToolCategory(value: string): value is PackToolCategory {
  return (PACK_TOOL_CATEGORIES as readonly string[]).includes(value);
}

/** zod 路径（`tools.0.category`）→ 面板可读路径（`tools[0].category`）。 */
export function formatIssuePath(path: (string | number)[]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    return acc ? `${acc}.${segment}` : segment;
  }, "");
}

export const packToolSpecSchema = z.object({
  name: z.string().min(1).max(64),
  // 分类先按字符串接收：白名单校验由 `parseNbskillPack` 显式完成——否则 zod 枚举
  // 会先报 `schema_invalid`，专属的 `tool_category_not_allowed` 永远不可达。
  category: z.string().min(1).max(64),
  description: z.string().max(500).default(""),
});

export const packPromptSpecSchema = z.object({
  id: z.string().min(1).max(64),
  /** 提示词正文；技能包只承载文本，不承载任何可执行体。 */
  body: z.string().min(1).max(20000),
});

export const nbskillPackSchema = z.object({
  schemaVersion: z.literal(NBSKILL_PACK_SCHEMA_VERSION),
  kind: z.string().optional(),
  name: z.string().min(1).max(64),
  version: z.string().min(1).max(32),
  author: z.string().max(120).default(""),
  tools: z.array(packToolSpecSchema).max(64),
  prompts: z.array(packPromptSpecSchema).max(64),
  trustLevel: z.enum(PACK_TRUST_LEVELS),
});

export type PackToolSpec = z.infer<typeof packToolSpecSchema>;
export type PackPromptSpec = z.infer<typeof packPromptSpecSchema>;
export type NbskillPack = z.infer<typeof nbskillPackSchema>;

export type PackValidationCode =
  | "schema_version_unsupported"
  | "schema_invalid"
  | "name_invalid"
  | "tool_category_not_allowed"
  | "tool_name_invalid"
  | "tool_name_forbidden";

export interface PackValidationIssue {
  code: PackValidationCode;
  /** 出问题的位置（如 `tools[2].category`）。 */
  at: string;
  detail: string;
}

export type PackValidationResult =
  | { ok: true; pack: NbskillPack; warnings: string[] }
  | { ok: false; issues: PackValidationIssue[] };

/**
 * 解析并校验技能包。**整包语义**：任何一条 issue 都导致整包拒绝，不做部分导入。
 * `schemaVersion` 只接受 1；其它值单独报 `schema_version_unsupported`。
 */
export function parseNbskillPack(raw: unknown): PackValidationResult {
  const issues: PackValidationIssue[] = [];

  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      issues: [{ code: "schema_invalid", at: "", detail: "pack must be a JSON object" }],
    };
  }

  const candidate = raw as Record<string, unknown>;
  if (candidate.schemaVersion !== NBSKILL_PACK_SCHEMA_VERSION) {
    return {
      ok: false,
      issues: [
        {
          code: "schema_version_unsupported",
          at: "schemaVersion",
          detail: `expected ${NBSKILL_PACK_SCHEMA_VERSION}, got ${String(candidate.schemaVersion)}`,
        },
      ],
    };
  }

  const parsed = nbskillPackSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code: "schema_invalid",
        at: formatIssuePath(issue.path),
        detail: issue.message,
      });
    }
    return { ok: false, issues };
  }

  const pack = parsed.data;

  if (!PACK_NAME_PATTERN.test(pack.name)) {
    issues.push({
      code: "name_invalid",
      at: "name",
      detail: `name must match ${String(PACK_NAME_PATTERN)}`,
    });
  }

  pack.tools.forEach((tool, index) => {
    if (!isAllowedToolCategory(tool.category)) {
      issues.push({
        code: "tool_category_not_allowed",
        at: `tools[${index}].category`,
        detail: `category ${tool.category} is outside the allowlist`,
      });
    }
    const lowered = tool.name.toLowerCase();
    const forbidden = FORBIDDEN_TOOL_NAME_PARTS.find((part) => lowered.includes(part));
    if (forbidden) {
      issues.push({
        code: "tool_name_forbidden",
        at: `tools[${index}].name`,
        detail: `tool name must not contain ${forbidden}`,
      });
    } else if (!PACK_TOOL_NAME_PATTERN.test(tool.name)) {
      issues.push({
        code: "tool_name_invalid",
        at: `tools[${index}].name`,
        detail: `tool name must match ${String(PACK_TOOL_NAME_PATTERN)}`,
      });
    }
  });

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const warnings: string[] = [];
  if (pack.author.trim().length === 0) {
    warnings.push("pack declares no author; trust stays untrusted until reviewed locally");
  }

  return { ok: true, pack, warnings };
}

/** 导出文件名：`<name><.nbskill.json>`。 */
export function packFileName(name: string): string {
  return `${name}${NBSKILL_PACK_EXTENSION}`;
}
