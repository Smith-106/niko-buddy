/** skill-bundle-client.ts 单元测试（含 Phase 3 人工复核与单向声明式 SKILL.md 导出门禁）。 */
import { beforeEach, describe, expect, it, vi } from "vitest"

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
  SKILL_BUNDLE_TRUST_REVIEWED,
  SKILL_BUNDLE_TRUST_UNTRUSTED,
  canExportDeclarativeSkillMd,
  exportDeclarativeSkillMd,
  exportSkillBundle,
  hasExecutableExtension,
  importSkillBundle,
  isAllowedBundleEntry,
  listInstalledSkillBundles,
  setSkillBundleReviewStatus,
  summarizeImportGate,
  validateBundleEntryName,
  validateManifestShape,
  verifySkillBundle,
  type SkillBundleDeclarativeExportResult,
  type SkillBundleInstalledEntry,
  type SkillBundleReviewResult,
} from "./skill-bundle-client"

describe("skill-bundle-client.ts exports & smoke", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it("exports all schema/security constants and client helpers", () => {
    expect(SKILL_BUNDLE_SCHEMA).toBe("nbskill/1")
    expect(SKILL_BUNDLE_SCHEMA_VERSION).toBe(1)
    expect(SKILL_BUNDLE_TRUST_UNTRUSTED).toBe("untrusted")
    expect(SKILL_BUNDLE_TRUST_REVIEWED).toBe("reviewed")
    expect(SKILL_BUNDLE_MAX_ENTRIES).toBe(512)
    expect(SKILL_BUNDLE_MAX_BYTES).toBe(32 * 1024 * 1024)
    expect(SKILL_BUNDLE_ALLOWED_EXTENSIONS).toContain("md")
    expect(SKILL_BUNDLE_EXECUTABLE_EXTENSIONS).toContain("ps1")
    expect(typeof hasExecutableExtension).toBe("function")
    expect(typeof isAllowedBundleEntry).toBe("function")
    expect(typeof validateBundleEntryName).toBe("function")
    expect(typeof validateManifestShape).toBe("function")
    expect(typeof summarizeImportGate).toBe("function")
    expect(typeof exportSkillBundle).toBe("function")
    expect(typeof verifySkillBundle).toBe("function")
    expect(typeof importSkillBundle).toBe("function")
  })

  describe("canExportDeclarativeSkillMd fail-closed gate", () => {
    it("allows export ONLY when trust_level is reviewed, integrityOk is not false, and no rejected/mismatched", () => {
      expect(
        canExportDeclarativeSkillMd({
          trust_level: SKILL_BUNDLE_TRUST_REVIEWED,
          integrity_ok: true,
        }),
      ).toEqual({
        canExport: true,
        trustLevel: SKILL_BUNDLE_TRUST_REVIEWED,
        reasons: [],
      })

      expect(
        canExportDeclarativeSkillMd({
          trustLevel: SKILL_BUNDLE_TRUST_REVIEWED,
        }),
      ).toEqual({
        canExport: true,
        trustLevel: SKILL_BUNDLE_TRUST_REVIEWED,
        reasons: [],
      })
    })

    it("fails closed on null, untrusted, arbitrary trust string, integrityOk=false, rejected, or mismatched", () => {
      expect(canExportDeclarativeSkillMd(null).canExport).toBe(false)
      expect(canExportDeclarativeSkillMd(undefined).canExport).toBe(false)

      const untrusted = canExportDeclarativeSkillMd({
        trust_level: SKILL_BUNDLE_TRUST_UNTRUSTED,
        integrity_ok: true,
      })
      expect(untrusted.canExport).toBe(false)
      expect(untrusted.reasons.join("|")).toContain("reviewed")

      const forgedTrust = canExportDeclarativeSkillMd({
        trustLevel: "trusted",
        integrityOk: true,
      })
      expect(forgedTrust.canExport).toBe(false)

      const badIntegrity = canExportDeclarativeSkillMd({
        trust_level: SKILL_BUNDLE_TRUST_REVIEWED,
        integrity_ok: false,
      })
      expect(badIntegrity.canExport).toBe(false)
      expect(badIntegrity.reasons.join("|")).toContain("integrity")

      const withRejected = canExportDeclarativeSkillMd({
        trust_level: SKILL_BUNDLE_TRUST_REVIEWED,
        integrity_ok: true,
        rejected: ["hooks.json forbidden"],
      })
      expect(withRejected.canExport).toBe(false)
      expect(withRejected.reasons).toContain("hooks.json forbidden")

      const withMismatched = canExportDeclarativeSkillMd({
        trust_level: SKILL_BUNDLE_TRUST_REVIEWED,
        integrity_ok: true,
        mismatched: ["skills/demo/skill.md"],
      })
      expect(withMismatched.canExport).toBe(false)
      expect(withMismatched.reasons.join("|")).toContain("skills/demo/skill.md")
    })
  })

  describe("Phase 3 Tauri IPC wrappers", () => {
    it("listInstalledSkillBundles invokes skill_bundle_list_installed with camelCase destRoot", async () => {
      const sample: SkillBundleInstalledEntry[] = [
        {
          id: "demo-a",
          name: "Demo A",
          version: "1.0.0",
          installed_dir: "/proj/user-assets/skill_bundle/demo-a/1.0.0",
          trust_level: SKILL_BUNDLE_TRUST_UNTRUSTED,
          content_hash: "a".repeat(64),
          manifest_sha256: "b".repeat(64),
          file_count: 2,
          reviewed_at: null,
          reviewer_note: null,
          skill_ids: ["demo-a"],
          integrity_ok: true,
        },
      ]
      vi.mocked(invoke).mockResolvedValueOnce(sample)
      const list = await listInstalledSkillBundles("/proj/user-assets")
      expect(invoke).toHaveBeenCalledWith("skill_bundle_list_installed", {
        destRoot: "/proj/user-assets",
      })
      expect(list).toEqual(sample)
    })

    it("setSkillBundleReviewStatus fails closed before invoke when confirmed=false", async () => {
      await expect(
        setSkillBundleReviewStatus("/proj/user-assets/skill_bundle/demo-a/1.0.0", true, false, "note"),
      ).rejects.toThrow(/confirmed=true/)
      expect(invoke).not.toHaveBeenCalled()
    })

    it("setSkillBundleReviewStatus invokes skill_bundle_mark_reviewed when confirmed=true", async () => {
      const sample: SkillBundleReviewResult = {
        ok: true,
        bundle_id: "demo-a",
        bundle_version: "1.0.0",
        trust_level: SKILL_BUNDLE_TRUST_REVIEWED,
        content_hash: "a".repeat(64),
        manifest_sha256: "b".repeat(64),
        receipt_path: "/proj/user-assets/skill_bundle/demo-a/1.0.0/.nb-review-receipt.json",
        reviewed_at: "2026-11-27T00:00:00Z",
      }
      vi.mocked(invoke).mockResolvedValueOnce(sample)
      const res = await setSkillBundleReviewStatus(
        "/proj/user-assets/skill_bundle/demo-a/1.0.0",
        true,
        true,
        "人工核验通过",
      )
      expect(invoke).toHaveBeenCalledWith("skill_bundle_mark_reviewed", {
        installedDir: "/proj/user-assets/skill_bundle/demo-a/1.0.0",
        reviewed: true,
        confirmed: true,
        reviewerNote: "人工核验通过",
      })
      expect(res).toEqual(sample)
    })

    it("exportDeclarativeSkillMd rejects client-side when options.trustLevel is provided and not reviewed", async () => {
      await expect(
        exportDeclarativeSkillMd(
          "/proj/user-assets/skill_bundle/demo-a/1.0.0",
          "/proj/.agents/skills",
          { trustLevel: SKILL_BUNDLE_TRUST_UNTRUSTED },
        ),
      ).rejects.toThrow(/reviewed/)
      expect(invoke).not.toHaveBeenCalled()
    })

    it("exportDeclarativeSkillMd invokes skill_bundle_export_declarative_skill_md when reviewed or trustLevel omitted", async () => {
      const sample: SkillBundleDeclarativeExportResult = {
        ok: true,
        bundle_id: "demo-a",
        bundle_version: "1.0.0",
        source_skill_id: "demo-a",
        exported_skill_name: "demo-a",
        trust_level: SKILL_BUNDLE_TRUST_REVIEWED,
        content_hash: "a".repeat(64),
        manifest_sha256: "b".repeat(64),
        skill_md_sha256: "c".repeat(64),
        export_dir: "/proj/.agents/skills/demo-a",
        skill_md_path: "/proj/.agents/skills/demo-a/SKILL.md",
        written_files: ["SKILL.md"],
        skipped_non_md_files: ["assets/notes.csv"],
        declarative_only: true,
      }
      vi.mocked(invoke).mockResolvedValueOnce(sample)
      const res = await exportDeclarativeSkillMd(
        "/proj/user-assets/skill_bundle/demo-a/1.0.0",
        "/proj/.agents/skills",
        { skillId: "demo-a", overwrite: true, trustLevel: SKILL_BUNDLE_TRUST_REVIEWED },
      )
      expect(invoke).toHaveBeenCalledWith("skill_bundle_export_declarative_skill_md", {
        installedDir: "/proj/user-assets/skill_bundle/demo-a/1.0.0",
        destRoot: "/proj/.agents/skills",
        skillId: "demo-a",
        overwrite: true,
      })
      expect(res).toEqual(sample)

      vi.mocked(invoke).mockResolvedValueOnce(sample)
      await exportDeclarativeSkillMd(
        "/proj/user-assets/skill_bundle/demo-a/1.0.0",
        "/proj/.agents/skills",
      )
      expect(invoke).toHaveBeenLastCalledWith("skill_bundle_export_declarative_skill_md", {
        installedDir: "/proj/user-assets/skill_bundle/demo-a/1.0.0",
        destRoot: "/proj/.agents/skills",
        skillId: undefined,
        overwrite: undefined,
      })
    })
  })
})
