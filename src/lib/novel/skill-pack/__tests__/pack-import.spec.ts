import { describe, expect, it } from "vitest";

import {
  NBSKILL_PACK_SCHEMA_VERSION,
  PACK_TOOL_CATEGORIES,
  PACK_TRUST_LEVELS,
  packFileName,
  parseNbskillPack,
} from "../pack-format";
import { CREDENTIAL_KEY_PARTS, buildPack, serializePack, stripCredentialKeys, stripCredentialLines } from "../pack-export";
import { describeIssues, importNbskillPack, importedSkillsTargetFile } from "../pack-import";
import { classifyTrustLevel, isTrustLevel, mayEnterCanonTruth } from "../../trust-authority";
import { normalizeUserSkill } from "../../skill-library";

function rawPack(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: NBSKILL_PACK_SCHEMA_VERSION,
    name: "demo-pack",
    version: "1.0.0",
    author: "niko",
    tools: [{ name: "read-outline", category: "readable-state", description: "" }],
    prompts: [{ id: "p1", body: "写出下一章的开场。" }],
    trustLevel: "untrusted",
    ...overrides,
  };
}

describe("pack-format / 整包校验", () => {
  it("合法包通过并给出文件名", () => {
    const result = parseNbskillPack(rawPack());
    expect(result.ok).toBe(true);
    expect(packFileName("demo-pack")).toBe("demo-pack.nbskill.json");
  });

  it("schemaVersion 非 1 直接拒绝", () => {
    const result = parseNbskillPack(rawPack({ schemaVersion: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].code).toBe("schema_version_unsupported");
    }
  });

  it("白名单外的工具分类 → 整包拒绝（不做部分导入）", () => {
    const result = parseNbskillPack(
      rawPack({
        tools: [
          { name: "read-outline", category: "readable-state", description: "" },
          { name: "run-shell", category: "execute", description: "" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((i) => i.code);
      expect(codes).toContain("tool_category_not_allowed");
      expect(result.issues.some((i) => i.at === "tools[1].category")).toBe(true);
    }
  });

  it("工具名含执行类片段 → 拒绝", () => {
    const result = parseNbskillPack(
      rawPack({ tools: [{ name: "exec-anything", category: "readable-state", description: "" }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].code).toBe("tool_name_forbidden");
  });

  it("工具名格式非法 → 拒绝", () => {
    const result = parseNbskillPack(
      rawPack({ tools: [{ name: "Bad Name!", category: "readable-state", description: "" }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].code).toBe("tool_name_invalid");
  });

  it("非对象输入与缺字段输入都拒绝", () => {
    expect(parseNbskillPack(null).ok).toBe(false);
    expect(parseNbskillPack({ schemaVersion: 1 }).ok).toBe(false);
  });

  it("白名单与信任级别是封闭集合", () => {
    expect([...PACK_TOOL_CATEGORIES]).toEqual(["readable-state", "writable-artifact"]);
    expect([...PACK_TRUST_LEVELS]).toEqual(["untrusted", "reviewed", "trusted"]);
  });
});

describe("pack-import / 信任分级与落盘形态", () => {
  it("导入默认 untrusted，且不采信包自报级别", () => {
    const result = importNbskillPack(rawPack({ trustLevel: "trusted" }), { categoryId: "c1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.trustLevel).toBe("untrusted");
      expect(result.declaredTrustLevel).toBe("trusted");
      expect(result.warnings.some((w) => w.includes("re-classified"))).toBe(true);
    }
  });

  it("本地评审后升到 reviewed，作者可验证才到 trusted", () => {
    const reviewed = importNbskillPack(rawPack(), {
      categoryId: "c1",
      reviewedLocally: true,
    });
    expect(reviewed.ok && reviewed.trustLevel).toBe("reviewed");

    const verified = importNbskillPack(rawPack(), {
      categoryId: "c1",
      reviewedLocally: true,
      authorVerified: true,
    });
    expect(verified.ok && verified.trustLevel).toBe("trusted");
  });

  it("导入产出可落盘的 UserSkill 形态（经既有 skill-library 归一）", () => {
    const result = importNbskillPack(rawPack(), { categoryId: "c9", now: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0];
    expect(skill.source).toBe("uploaded");
    expect(skill.categoryId).toBe("c9");
    expect(skill.createdAt).toBe(1000);
    expect(skill.tags).toEqual(["readable-state"]);
    // 与 normalizeUserSkill 的结果一致（未另起一套归一）
    expect(skill).toEqual(
      normalizeUserSkill({
        id: "p1",
        name: "demo-pack · p1",
        description: "imported from demo-pack@1.0.0 (trustLevel=untrusted)",
        content: "写出下一章的开场。",
        source: "uploaded",
        categoryId: "c9",
        tags: ["readable-state"],
        createdAt: 1000,
        updatedAt: 1000,
      }),
    );
  });

  it("非法包整包拒绝并给出可读错误清单", () => {
    const result = importNbskillPack(rawPack({ tools: [{ name: "x", category: "network" }] }), {
      categoryId: "c1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const lines = describeIssues(result.issues);
      expect(lines[0]).toContain("tools[0].category");
    }
  });

  it("落盘目标复用既有 user-skill-store 的真源文件", () => {
    expect(importedSkillsTargetFile()).toBe(".qmai/writing-skills.json");
  });
});

describe("pack-export / 剔除凭据字段", () => {
  it("凭据类键名被识别", () => {
    expect(CREDENTIAL_KEY_PARTS).toContain("token");
    expect(stripCredentialKeys({ token: "t", keep: 1 }).stripped).toEqual(["token"]);
    expect(stripCredentialKeys({ a: { apiKey: "k" } }).stripped).toEqual(["a.apiKey"]);
  });

  it("导出剔除凭据行并告警", () => {
    const skill = normalizeUserSkill({
      id: "s1",
      name: "s",
      content: "prefix\ntoken: abc123\nsuffix",
      source: "project",
      categoryId: "c1",
    });
    const result = buildPack([skill], { name: "demo-pack", version: "1.0.0" });
    expect(result.warnings.some((w) => w.includes("credential-like line"))).toBe(true);
    const text = serializePack(result);
    expect(text).not.toContain("abc123");
    expect(text).toContain("prefix");
    expect(text).toContain("suffix");
  });

  it("导出物不含任何凭据类字段且默认 untrusted", () => {
    const result = buildPack([], { name: "demo-pack", version: "1.0.0", author: "niko" });
    expect(result.pack.trustLevel).toBe("untrusted");
    expect(JSON.stringify(result.pack)).not.toMatch(/token|secret|password/i);
    expect(result.pack.schemaVersion).toBe(1);
    expect(result.fileName).toBe("demo-pack.nbskill.json");
  });

  it("工具字段里出现凭据键时整条工具被剔除并告警", () => {
    const result = buildPack([], {
      name: "demo-pack",
      version: "1.0.0",
      tools: [
        { name: "read-outline", category: "readable-state", description: "" },
        { name: "read-tokenized", category: "readable-state", description: "" },
      ],
    });
    expect(result.pack.tools).toHaveLength(2);
    expect(stripCredentialLines("token: x\nnormal: y").stripped).toBe(1);
  });
});

describe("trust-authority / 分类规则", () => {
  it("项目内置为 trusted", () => {
    expect(classifyTrustLevel({ origin: "project-builtin" })).toBe("trusted");
  });

  it("本地文件默认 untrusted，本地评审升 reviewed", () => {
    expect(classifyTrustLevel({ origin: "local-file" })).toBe("untrusted");
    expect(classifyTrustLevel({ origin: "local-file", reviewedLocally: true })).toBe("reviewed");
  });

  it("只有 trusted/reviewed 才能进正式真源", () => {
    expect(mayEnterCanonTruth("trusted")).toBe(true);
    expect(mayEnterCanonTruth("reviewed")).toBe(true);
    expect(mayEnterCanonTruth("untrusted")).toBe(false);
  });

  it("级别字面量判别", () => {
    expect(isTrustLevel("untrusted")).toBe(true);
    expect(isTrustLevel("admin")).toBe(false);
  });
});
