// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import { buildPack, serializePack, type UserSkill } from "@/lib/novel"
import { SkillPackPanel } from "./SkillPackPanel"
import DefaultExport from "./SkillPackPanel"

const tMock = vi.hoisted(() => vi.fn((key: string) => key))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: tMock }),
}))

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
    } finally {
      clickSpy.mockRestore()
      cleanup()
    }
  })
})
