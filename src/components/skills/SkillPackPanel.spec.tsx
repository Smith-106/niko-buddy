// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import {
  buildPack,
  serializePack,
  type SkillBundleInstalledEntry,
  type UserSkill,
} from "@/lib/novel"
import { SkillPackPanel } from "./SkillPackPanel"
import DefaultExport from "./SkillPackPanel"

const tMock = vi.hoisted(() =>
  vi.fn((key: string, opts?: Record<string, unknown>) => {
    if (opts && typeof opts.path === "string") return `${key}:${opts.path}`
    if (opts && typeof opts.count === "number") return `${key}:${opts.count}`
    return key
  }),
)

const bundleMocks = vi.hoisted(() => ({
  listInstalledSkillBundles: vi.fn(),
  setSkillBundleReviewStatus: vi.fn(),
  exportDeclarativeSkillMd: vi.fn(),
  isTauri: vi.fn(() => false),
  pickDirectory: vi.fn(),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: tMock }),
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    listInstalledSkillBundles: (...args: unknown[]) =>
      bundleMocks.listInstalledSkillBundles(...args),
    setSkillBundleReviewStatus: (...args: unknown[]) =>
      bundleMocks.setSkillBundleReviewStatus(...args),
    exportDeclarativeSkillMd: (...args: unknown[]) =>
      bundleMocks.exportDeclarativeSkillMd(...args),
  }
})

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>()
  return {
    ...actual,
    isTauri: () => bundleMocks.isTauri(),
    pickDirectory: () => bundleMocks.pickDirectory(),
  }
})

function skill(partial: Partial<UserSkill> & { name: string }): UserSkill {
  return {
    id: `skill:${partial.name}`,
    description: partial.description ?? "",
    kind: ["structure"],
    stages: ["planning"],
    modes: ["standard"],
    content: partial.content ?? "规则正文",
    source: "uploaded",
    priority: 50,
    tags: [],
    categoryId: "general",
    ...partial,
  } as UserSkill
}

const VALID_PACK = {
  schemaVersion: 1,
  name: "demo-pack",
  version: "1.0.0",
  tools: [],
  prompts: [{ id: "p1", body: "打包规则正文" }],
  trustLevel: "untrusted",
}

function uploadFile(file: File) {
  const input = screen.getByTestId("skillpack-file") as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("SkillPackPanel", () => {
  it("has default export", () => {
    expect(DefaultExport).toBe(SkillPackPanel)
  })

  it("renders title, skills and zeroed trust badges", () => {
    render(<SkillPackPanel skills={[skill({ name: "三翻四抖" })]} categoryId="general" />)

    expect(screen.getByText("skillpack.title")).toBeTruthy()
    expect(screen.getByTestId("skillpack-skills").textContent).toContain("三翻四抖")
    expect(screen.getByTestId("skillpack-badge-untrusted").textContent).toContain("(0)")
    expect(screen.getByTestId("skillpack-badge-reviewed").textContent).toContain("(0)")
    expect(screen.getByTestId("skillpack-badge-trusted").textContent).toContain("(0)")
    // untrusted 不能进 canon 真理区 reviewed/trusted 可以（title 区分）
    expect(screen.getByTestId("skillpack-badge-untrusted").title).toBe("skillpack.badge.notTruthEligible")
    expect(screen.getByTestId("skillpack-badge-trusted").title).toBe("skillpack.badge.mayEnterTruth")
  })

  it("shows the no-skills-selected export warning for an empty skill set", () => {
    render(<SkillPackPanel skills={[]} categoryId="general" />)

    const warnings = screen.getByTestId("skillpack-export-warnings")
    expect(warnings.textContent).toContain("skillpack.export.warn.noSkillsSelected")
  })

  it("shows a stripped-lines export warning for credential-like content", () => {
    render(<SkillPackPanel skills={[skill({ name: "带凭据", content: "api_key: 12345\n正文" })]} categoryId="general" />)

    const warnings = screen.getByTestId("skillpack-export-warnings")
    expect(warnings.textContent).toContain("skillpack.export.warn.strippedPromptLines")
  })

  it("downloads the serialized pack on export", async () => {
    const skills = [skill({ name: "三翻四抖" })]
    const blobs: Blob[] = []
    const createSpy = vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      blobs.push(blob as Blob)
      return "blob:mock-url"
    })
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

    try {
      render(<SkillPackPanel skills={skills} categoryId="general" />)
      fireEvent.click(screen.getByTestId("skillpack-export"))

      expect(createSpy).toHaveBeenCalledTimes(1)
      const expected = serializePack(buildPack(skills, { name: "niko-skills", version: "1.0.0" }))
      await expect(blobs[0].text()).resolves.toBe(expected)
      expect(clickSpy).toHaveBeenCalled()
      expect(revokeSpy).toHaveBeenCalledWith("blob:mock-url")
    } finally {
      createSpy.mockRestore()
      revokeSpy.mockRestore()
      clickSpy.mockRestore()
    }
  })

  it("surfaces a read failure when the file cannot be read", async () => {
    const onImported = vi.fn()
    render(<SkillPackPanel skills={[]} categoryId="general" onImported={onImported} />)

    const file = new File(["whatever"], "pack.nbskill.json")
    vi.spyOn(file, "text").mockRejectedValue(new Error("disk gone"))
    uploadFile(file)

    expect(await screen.findByTestId("skillpack-errors")).toBeTruthy()
    // 诊断 detail 只进 title（诊断详情），主文案是结论码
    expect(screen.getByTestId("skillpack-errors").textContent).toContain("skillpack.issue.schema_invalid")
    expect(screen.getByTestId("skillpack-errors").querySelector("li")?.title).toBe(
      "skillpack.issueDetail.readFailed",
    )
    expect(onImported).not.toHaveBeenCalled()
  })

  it("surfaces invalid JSON without calling onImported", async () => {
    const onImported = vi.fn()
    render(<SkillPackPanel skills={[]} categoryId="general" onImported={onImported} />)

    uploadFile(new File(["{not json"], "pack.nbskill.json"))

    expect(await screen.findByTestId("skillpack-errors")).toBeTruthy()
    expect(screen.getByTestId("skillpack-errors").textContent).toContain("skillpack.issue.schema_invalid")
    expect(screen.getByTestId("skillpack-errors").querySelector("li")?.title).toBe(
      "skillpack.issueDetail.invalidJson",
    )
    expect(onImported).not.toHaveBeenCalled()
  })

  it("lists pack validation issues for a schema-violating pack", async () => {
    render(<SkillPackPanel skills={[]} categoryId="general" />)

    uploadFile(new File([JSON.stringify({ schemaVersion: 999, name: "x", version: "1", tools: [], prompts: [], trustLevel: "untrusted" })], "pack.nbskill.json"))

    const errors = await screen.findByTestId("skillpack-errors")
    expect(errors.textContent).toContain("skillpack.issue.schema_version_unsupported")
  })

  it("imports a valid pack, updates badges and notifies the host", async () => {
    const onImported = vi.fn()
    render(<SkillPackPanel skills={[skill({ name: "既有" })]} categoryId="general" onImported={onImported} />)

    // 双提示词包：徽标计数必须等于导入技能数（不是固定 +1）
    const twoPromptPack = { ...VALID_PACK, prompts: [...VALID_PACK.prompts, { id: "p2", body: "第二条规则" }] }
    uploadFile(new File([JSON.stringify(twoPromptPack)], "pack.nbskill.json"))

    expect(await screen.findByTestId("skillpack-import-result")).toBeTruthy()
    expect(screen.getByTestId("skillpack-import-result").textContent).toContain("skillpack.imported")
    // untrusted 徽标计数随导入技能数更新
    expect(screen.getByTestId("skillpack-badge-untrusted").textContent).toContain("(2)")

    expect(onImported).toHaveBeenCalledTimes(1)
    const result = onImported.mock.calls[0][0]
    expect(result.ok).toBe(true)
    expect(result.trustLevel).toBe("untrusted")
    expect(result.skills).toHaveLength(2)
    // 描述文案在 UI 层生成：带包名/版本/级别
    expect(result.skills[0].description).toBe("skillpack.importedDescription")
    expect(tMock).toHaveBeenCalledWith("skillpack.importedDescription", expect.objectContaining({
      name: "demo-pack",
      version: "1.0.0",
    }))
  })

  it("shows trust reclassification when the pack declares a higher level", async () => {
    render(<SkillPackPanel skills={[]} categoryId="general" />)

    uploadFile(new File([JSON.stringify({ ...VALID_PACK, trustLevel: "trusted" })], "pack.nbskill.json"))

    // 文件自报 trusted，但本地文件导入恒为 untrusted → 重分类提示
    const notice = await screen.findByTestId("skillpack-trust-reclassified")
    expect(notice.textContent).toContain("skillpack.trustReclassified")
    expect(screen.getByTestId("skillpack-badge-untrusted").textContent).toContain("(1)")
    await waitFor(() => {
      expect(tMock).toHaveBeenCalledWith("skillpack.trustReclassified", expect.objectContaining({
        declared: "skillpack.trust.trusted",
        effective: "skillpack.trust.untrusted",
      }))
    })
  })
})

describe("SkillPackPanel 导入入口", () => {
  it("opens the file picker when the import button is clicked", () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {})
    try {
      render(<SkillPackPanel skills={[]} categoryId="general" />)
      fireEvent.click(screen.getByTestId("skillpack-import"))
      expect(clickSpy).toHaveBeenCalledTimes(1)
      // 未传 bundleDestRoot / installedBundles 时不渲染声明式导出分区
      expect(screen.queryByTestId("skillbundle-declarative-section")).toBeNull()
    } finally {
      clickSpy.mockRestore()
      cleanup()
    }
  })
})

function makeInstalledBundle(
  overrides: Partial<SkillBundleInstalledEntry> = {},
): SkillBundleInstalledEntry {
  return {
    id: "demo-bundle",
    name: "Demo Writing Bundle",
    version: "1.0.0",
    installed_dir: "C:/proj/user-assets/skill_bundle/demo-bundle/1.0.0",
    trust_level: "untrusted",
    content_hash: "a".repeat(64),
    manifest_sha256: "b".repeat(64),
    file_count: 3,
    reviewed_at: null,
    reviewer_note: null,
    skill_ids: ["demo-skill"],
    integrity_ok: true,
    ...overrides,
  }
}

describe("SkillPackPanel nbskill/1 人工复核与单向声明式 SKILL.md 导出 (Phase 3)", () => {
  it("untrusted 技能包严格禁用导出并展示 aria-describedby 理由，绝不调用 exportDeclarativeSkillMd", () => {
    const bundle = makeInstalledBundle({ trust_level: "untrusted" })
    render(
      <SkillPackPanel
        skills={[]}
        categoryId="general"
        installedBundles={[bundle]}
      />,
    )

    expect(screen.getByTestId("skillbundle-declarative-section")).toBeTruthy()
    expect(screen.getByTestId("skillbundle-trust-badge-demo-bundle").textContent).toBe(
      "skillbundle.declarative.trustUntrusted",
    )

    const exportBtn = screen.getByTestId("skillbundle-export-skillmd-demo-bundle") as HTMLButtonElement
    const disabledHint = screen.getByTestId("skillbundle-export-disabled-hint-demo-bundle")
    expect(exportBtn.disabled).toBe(true)
    expect(exportBtn.getAttribute("aria-disabled")).toBe("true")
    expect(exportBtn.getAttribute("aria-describedby")).toBe(disabledHint.id)
    expect(disabledHint.textContent).toBe("skillbundle.declarative.exportDisabledHint")

    // 复核按钮在未勾选核对确认前同样禁用
    const markBtn = screen.getByTestId("skillbundle-mark-reviewed-demo-bundle") as HTMLButtonElement
    expect(markBtn.disabled).toBe(true)

    fireEvent.click(exportBtn)
    expect(bundleMocks.exportDeclarativeSkillMd).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("显式勾选核对确认 + 点击标记为已复核后解锁导出，并支持撤销复核回到不可信态", async () => {
    const bundle = makeInstalledBundle({ trust_level: "untrusted" })
    bundleMocks.setSkillBundleReviewStatus
      .mockResolvedValueOnce({
        ok: true,
        bundle_id: bundle.id,
        bundle_version: bundle.version,
        trust_level: "reviewed",
        content_hash: bundle.content_hash,
        manifest_sha256: bundle.manifest_sha256,
        receipt_path: `${bundle.installed_dir}/.nb-review-receipt.json`,
        reviewed_at: "2026-11-27T12:00:00Z",
      })
      .mockResolvedValueOnce({
        ok: true,
        bundle_id: bundle.id,
        bundle_version: bundle.version,
        trust_level: "untrusted",
        content_hash: bundle.content_hash,
        manifest_sha256: bundle.manifest_sha256,
        receipt_path: `${bundle.installed_dir}/.nb-review-receipt.json`,
        reviewed_at: null,
      })

    render(
      <SkillPackPanel
        skills={[]}
        categoryId="general"
        installedBundles={[bundle]}
      />,
    )

    // 确认每个 <label> 均有绑定控件（零孤立 label）
    const orphans = Array.from(document.querySelectorAll("label")).filter(
      (l) => !(l as HTMLLabelElement).control,
    )
    expect(orphans).toEqual([])

    const checkbox = screen.getByTestId("skillbundle-review-checkbox-demo-bundle") as HTMLInputElement
    const markBtn = screen.getByTestId("skillbundle-mark-reviewed-demo-bundle") as HTMLButtonElement
    expect(markBtn.disabled).toBe(true)

    fireEvent.click(checkbox)
    expect(markBtn.disabled).toBe(false)
    fireEvent.click(markBtn)

    await waitFor(() => {
      expect(bundleMocks.setSkillBundleReviewStatus).toHaveBeenCalledWith(
        bundle.installed_dir,
        true,
        true,
      )
    })
    expect(screen.getByTestId("skillbundle-trust-badge-demo-bundle").textContent).toBe(
      "skillbundle.declarative.trustReviewed",
    )
    expect(
      (screen.getByTestId("skillbundle-export-skillmd-demo-bundle") as HTMLButtonElement).disabled,
    ).toBe(false)
    expect(screen.queryByTestId("skillbundle-export-disabled-hint-demo-bundle")).toBeNull()

    // 撤销复核 -> 回到 untrusted 并重新禁用导出
    fireEvent.click(screen.getByTestId("skillbundle-revoke-review-demo-bundle"))
    await waitFor(() => {
      expect(bundleMocks.setSkillBundleReviewStatus).toHaveBeenCalledWith(
        bundle.installed_dir,
        false,
        true,
      )
    })
    expect(screen.getByTestId("skillbundle-trust-badge-demo-bundle").textContent).toBe(
      "skillbundle.declarative.trustUntrusted",
    )
    expect(
      (screen.getByTestId("skillbundle-export-skillmd-demo-bundle") as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it("reviewed 技能包单向导出 SKILL.md：在 role=status 展示路径与 C-007 零脚本徽标", async () => {
    const bundle = makeInstalledBundle({ trust_level: "reviewed", reviewed_at: "2026-11-27T12:00:00Z" })
    const onPickExportDir = vi.fn(async () => "C:/proj/.agents/skills")
    bundleMocks.exportDeclarativeSkillMd.mockResolvedValueOnce({
      ok: true,
      bundle_id: bundle.id,
      bundle_version: bundle.version,
      source_skill_id: "demo-skill",
      exported_skill_name: "demo-skill",
      trust_level: "reviewed",
      content_hash: bundle.content_hash,
      manifest_sha256: bundle.manifest_sha256,
      skill_md_sha256: "c".repeat(64),
      export_dir: "C:/proj/.agents/skills/demo-skill",
      skill_md_path: "C:/proj/.agents/skills/demo-skill/SKILL.md",
      written_files: ["SKILL.md"],
      skipped_non_md_files: [],
      declarative_only: true,
    })

    render(
      <SkillPackPanel
        skills={[]}
        categoryId="general"
        installedBundles={[bundle]}
        onPickExportDir={onPickExportDir}
      />,
    )

    fireEvent.click(screen.getByTestId("skillbundle-export-skillmd-demo-bundle"))

    await waitFor(() => {
      expect(bundleMocks.exportDeclarativeSkillMd).toHaveBeenCalledWith(
        bundle.installed_dir,
        "C:/proj/.agents/skills",
        { trustLevel: "reviewed" },
      )
    })

    const status = await screen.findByTestId("skillbundle-export-status")
    expect(status.getAttribute("role")).toBe("status")
    expect(status.textContent).toContain(
      "skillbundle.declarative.exportSuccess:C:/proj/.agents/skills/demo-skill/SKILL.md",
    )
    expect(screen.getByTestId("skillbundle-zero-script-badge").textContent).toBe(
      "skillbundle.declarative.zeroScriptBadge",
    )
  })

  it("取消目录选择时在 role=status 播报取消提示，不调用后端导出", async () => {
    const bundle = makeInstalledBundle({ trust_level: "reviewed" })
    const onPickExportDir = vi.fn(async () => null)

    render(
      <SkillPackPanel
        skills={[]}
        categoryId="general"
        installedBundles={[bundle]}
        onPickExportDir={onPickExportDir}
      />,
    )

    fireEvent.click(screen.getByTestId("skillbundle-export-skillmd-demo-bundle"))

    const status = await screen.findByTestId("skillbundle-export-status")
    expect(status.getAttribute("role")).toBe("status")
    expect(status.textContent).toContain("skillbundle.declarative.exportCancelled")
    expect(bundleMocks.exportDeclarativeSkillMd).not.toHaveBeenCalled()
  })

  it("导出失败时主文案本地化，原始诊断串折叠进 details", async () => {
    const bundle = makeInstalledBundle({ trust_level: "reviewed" })
    bundleMocks.exportDeclarativeSkillMd.mockRejectedValueOnce(
      new Error("RUST_DENIED_PROTECTED_TARGET"),
    )

    render(
      <SkillPackPanel
        skills={[]}
        categoryId="general"
        installedBundles={[bundle]}
        defaultExportDir="C:/proj/.agents/skills"
      />,
    )

    fireEvent.click(screen.getByTestId("skillbundle-export-skillmd-demo-bundle"))

    const err = await screen.findByTestId("skillbundle-declarative-error")
    expect(err.getAttribute("role")).toBe("alert")
    expect(err.firstElementChild?.textContent).toBe("skillbundle.declarative.exportFailed")
    expect(err.firstElementChild?.textContent).not.toContain("RUST_DENIED_PROTECTED_TARGET")
    const details = err.querySelector("details")
    expect(details).toBeTruthy()
    expect(details?.open).toBe(false)
    expect(details?.textContent).toContain("RUST_DENIED_PROTECTED_TARGET")
  })

  it("Tauri 环境下传入 bundleDestRoot 时自动调用 listInstalledSkillBundles，加载失败静默空态不污染 role=alert", async () => {
    bundleMocks.isTauri.mockReturnValue(true)
    bundleMocks.listInstalledSkillBundles.mockRejectedValueOnce(new Error("fs denied"))

    render(
      <SkillPackPanel
        skills={[]}
        categoryId="general"
        bundleDestRoot="C:/proj/user-assets"
      />,
    )

    await waitFor(() => {
      expect(bundleMocks.listInstalledSkillBundles).toHaveBeenCalledWith("C:/proj/user-assets")
    })
    expect(await screen.findByTestId("skillbundle-declarative-empty")).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
    bundleMocks.isTauri.mockReturnValue(false)
  })
})
