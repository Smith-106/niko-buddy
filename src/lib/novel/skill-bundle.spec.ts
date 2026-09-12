/**
 * skill-bundle.spec.ts — F-002 技能包离线协议客户端契约测试（TASK-005 / TASK-006）。
 *
 * 覆盖：
 *   1. 条目名体检：绝对路径 / 盘符 / 反斜杠 / `..` 穿越 / 空名一律拒绝。
 *   2. 扩展名双侧边界：可执行 denylist 拒绝、allowlist 之外拒绝、allowlist 之内通过。
 *   3. 清单结构体检：schema 名与版本、必填字段、content_hash 形态、allowlist 必需。
 *   4. 导入门禁：mismatched / rejected 任一条即不可导入；trust_level 恒为 untrusted。
 *   5. IPC 契约：三个命令的 invoke 名称与 camelCase 参数形状（含 confirmed 透传）。
 *
 * 不依赖 Tauri 运行时：mock `@tauri-apps/api/core`。
 */

import { describe, expect, it, vi, beforeEach } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

import { invoke } from "@tauri-apps/api/core"
import {
  SKILL_BUNDLE_ALLOWED_EXTENSIONS,
  SKILL_BUNDLE_EXECUTABLE_EXTENSIONS,
  SKILL_BUNDLE_MAX_BYTES,
  SKILL_BUNDLE_MAX_ENTRIES,
  SKILL_BUNDLE_SCHEMA,
  SKILL_BUNDLE_SCHEMA_VERSION,
  SKILL_BUNDLE_TRUST_UNTRUSTED,
  exportSkillBundle,
  hasExecutableExtension,
  importSkillBundle,
  isAllowedBundleEntry,
  summarizeImportGate,
  validateBundleEntryName,
  validateManifestShape,
  verifySkillBundle,
  type SkillBundleManifest,
  type SkillBundleVerifyResult,
} from "./skill-bundle-client"

function manifestOf(overrides: Partial<SkillBundleManifest> = {}): SkillBundleManifest {
  return {
    schema: SKILL_BUNDLE_SCHEMA,
    schema_version: SKILL_BUNDLE_SCHEMA_VERSION,
    id: "demo-a",
    name: "Demo A",
    version: "1.0.0",
    content_hash: "a".repeat(64),
    source: "niko-buddy-local",
    trust_level: SKILL_BUNDLE_TRUST_UNTRUSTED,
    min_nb_version: "2.8.2",
    deps: [],
    allowlist: { readable_state: [], writable_artifacts: [] },
    files: [{ path: "skills/demo-a/skill.md", hash: "b".repeat(64), size: 10 }],
    ...overrides,
  }
}

function verifyOf(overrides: Partial<SkillBundleVerifyResult> = {}): SkillBundleVerifyResult {
  return {
    ok: true,
    schema_version: SKILL_BUNDLE_SCHEMA_VERSION,
    trust_level: SKILL_BUNDLE_TRUST_UNTRUSTED,
    manifest_sha256: "c".repeat(64),
    content_hash: "a".repeat(64),
    mismatched: [],
    rejected: [],
    entry_count: 2,
    total_bytes: 128,
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(invoke).mockReset()
})

describe("技能包条目安全体检", () => {
  it("拒绝穿越、绝对路径、盘符与反斜杠条目", () => {
    expect(validateBundleEntryName("../escape.md")).toEqual({
      ok: false,
      reason: "path traversal rejected",
    })
    expect(validateBundleEntryName("skills/../../escape.md").ok).toBe(false)
    expect(validateBundleEntryName("/etc/passwd").ok).toBe(false)
    expect(validateBundleEntryName("C:/Windows/x.md").ok).toBe(false)
    expect(validateBundleEntryName("skills\\demo\\skill.md").ok).toBe(false)
    expect(validateBundleEntryName("").ok).toBe(false)
  })

  it("放行 allowlist 内的相对 POSIX 条目", () => {
    expect(validateBundleEntryName("skills/demo-a/skill.md")).toEqual({ ok: true })
    expect(validateBundleEntryName("manifest.json")).toEqual({ ok: true })
  })

  it("可执行扩展名一律判为拒绝（C-007 脚本通道否决）", () => {
    for (const ext of SKILL_BUNDLE_EXECUTABLE_EXTENSIONS) {
      expect(hasExecutableExtension(`skills/a/run.${ext}`)).toBe(true)
      expect(validateBundleEntryName(`skills/a/run.${ext}`).ok).toBe(false)
    }
    expect(hasExecutableExtension("skills/a/run.EXE")).toBe(true)
    expect(hasExecutableExtension("skills/a/skill.md")).toBe(false)
  })

  it("allowlist 之外的扩展名判为拒绝", () => {
    for (const ext of SKILL_BUNDLE_ALLOWED_EXTENSIONS) {
      expect(isAllowedBundleEntry(`skills/a/file.${ext}`)).toBe(true)
    }
    expect(isAllowedBundleEntry("skills/a/data.bin")).toBe(false)
    expect(isAllowedBundleEntry("skills/a/noext")).toBe(false)
  })
})

describe("清单结构体检", () => {
  it("合法清单无拒绝项", () => {
    expect(validateManifestShape(manifestOf())).toEqual([])
  })

  it("schema 名与版本不识别即拒绝", () => {
    expect(validateManifestShape(manifestOf({ schema: "nbskill/2" }))).toHaveLength(1)
    expect(
      validateManifestShape(manifestOf({ schema_version: SKILL_BUNDLE_SCHEMA_VERSION + 1 })),
    ).toHaveLength(1)
  })

  it("必填字段、content_hash 形态与 allowlist 存在性被强制", () => {
    expect(validateManifestShape(manifestOf({ id: "  " })).join("|")).toContain("id")
    expect(validateManifestShape(manifestOf({ content_hash: "short" })).join("|")).toContain(
      "content_hash",
    )
    expect(
      validateManifestShape(manifestOf({ allowlist: undefined as never })).join("|"),
    ).toContain("allowlist")
  })
})

describe("导入门禁与信任盖章", () => {
  it("校验通过才允许导入", () => {
    expect(summarizeImportGate(verifyOf())).toEqual({
      canImport: true,
      trustLevel: SKILL_BUNDLE_TRUST_UNTRUSTED,
      reasons: [],
    })
  })

  it("哈希不匹配或结构性拒绝即不可导入，并给出理由", () => {
    const gate = summarizeImportGate(
      verifyOf({ ok: false, mismatched: ["skills/a/skill.md"], rejected: ["schema unsupported"] }),
    )
    expect(gate.canImport).toBe(false)
    expect(gate.reasons.join("|")).toContain("schema unsupported")
    expect(gate.reasons.join("|")).toContain("skills/a/skill.md")
  })

  it("信任级别恒按 untrusted 处理，不采信包内自述", () => {
    const gate = summarizeImportGate(verifyOf({ trust_level: "trusted" }))
    expect(gate.trustLevel).toBe(SKILL_BUNDLE_TRUST_UNTRUSTED)
  })

  it("上限常量与 Rust 侧一致", () => {
    expect(SKILL_BUNDLE_MAX_ENTRIES).toBe(512)
    expect(SKILL_BUNDLE_MAX_BYTES).toBe(32 * 1024 * 1024)
  })
})

describe("IPC 契约", () => {
  it("exportSkillBundle 传 camelCase 参数并以命令名调用", async () => {
    vi.mocked(invoke).mockResolvedValue({
      bundle_path: "/tmp/a.nbskill.zip",
      id: "demo-a",
      version: "1.0.0",
      content_hash: "a".repeat(64),
      manifest_sha256: "b".repeat(64),
      file_count: 2,
      total_bytes: 64,
    })
    const result = await exportSkillBundle(["demo-a"], "/src", "/tmp/a.nbskill.zip")
    expect(invoke).toHaveBeenCalledWith("skill_bundle_export", {
      skillIds: ["demo-a"],
      sourceRoot: "/src",
      destPath: "/tmp/a.nbskill.zip",
    })
    expect(result.bundle_path).toBe("/tmp/a.nbskill.zip")
  })

  it("verifySkillBundle 只传路径", async () => {
    vi.mocked(invoke).mockResolvedValue(verifyOf())
    await verifySkillBundle("/tmp/a.nbskill.zip")
    expect(invoke).toHaveBeenCalledWith("skill_bundle_verify", {
      bundlePath: "/tmp/a.nbskill.zip",
    })
  })

  it("importSkillBundle 透传 confirmed（导入确认门为机械约束）", async () => {
    vi.mocked(invoke).mockResolvedValue({
      ok: true,
      id: "demo-a",
      name: "Demo A",
      version: "1.0.0",
      trust_level: SKILL_BUNDLE_TRUST_UNTRUSTED,
      installed_dir: "/assets/skill_bundle/demo-a/1.0.0",
      content_hash: "a".repeat(64),
      manifest_sha256: "b".repeat(64),
      file_count: 2,
      total_bytes: 64,
      readable_state: [],
      writable_artifacts: [],
      warnings: [],
    })
    await importSkillBundle("/tmp/a.nbskill.zip", "/assets", true)
    expect(invoke).toHaveBeenCalledWith("skill_bundle_import", {
      bundlePath: "/tmp/a.nbskill.zip",
      destRoot: "/assets",
      confirmed: true,
    })
  })

  it("导入失败时错误向上抛出（不吞异常）", async () => {
    vi.mocked(invoke).mockRejectedValue("write denied by write_authority")
    await expect(importSkillBundle("/tmp/a.nbskill.zip", "/canon", true)).rejects.toBe(
      "write denied by write_authority",
    )
  })
})
