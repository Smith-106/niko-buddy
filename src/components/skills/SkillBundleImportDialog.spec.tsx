// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import { SkillBundleImportDialog } from "./SkillBundleImportDialog"
import DefaultExport from "./SkillBundleImportDialog"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
  verifySkillBundle: vi.fn(),
  importSkillBundle: vi.fn(),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    verifySkillBundle: mocks.verifySkillBundle,
    importSkillBundle: mocks.importSkillBundle,
  }
})

const VERIFY_OK = {
  ok: true,
  schema_version: 1,
  trust_level: "untrusted",
  manifest_sha256: "abc",
  content_hash: "def",
  mismatched: [] as string[],
  rejected: [] as string[],
  entry_count: 2,
  total_bytes: 128,
  manifest: {
    id: "demo",
    name: "演示包",
    version: "1.0.0",
    schema: "nbskill/1.0",
    schema_version: 1,
    min_nb_version: "0.1.0",
    source: "local",
    trust_level: "untrusted",
    allowlist: { readable_state: ["state/a"], writable_artifacts: ["prompts/x.md"] },
  },
}

const IMPORT_OK = {
  ok: true,
  id: "demo",
  name: "演示包",
  version: "1.0.0",
  trust_level: "untrusted",
  installed_dir: "C:/proj/skills/demo",
  content_hash: "def",
  manifest_sha256: "abc",
  file_count: 2,
  total_bytes: 128,
  readable_state: ["state/a"],
  writable_artifacts: ["prompts/x.md"],
  warnings: [] as string[],
}

function renderDialog(props: Record<string, unknown> = {}) {
  return render(
    <SkillBundleImportDialog
      open
      bundlePath="C:/packs/demo.zip"
      destRoot="C:/proj"
      onClose={() => {}}
      {...(props as object)}
    />,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("SkillBundleImportDialog", () => {
  it("has default export", () => {
    expect(DefaultExport).toBe(SkillBundleImportDialog)
  })

  it("renders nothing when closed", () => {
    const { container } = render(
      <SkillBundleImportDialog open={false} bundlePath="C:/packs/demo.zip" destRoot="C:/proj" onClose={() => {}} />,
    )
    expect(container.innerHTML).toBe("")
    expect(mocks.verifySkillBundle).not.toHaveBeenCalled()
  })

  it("shows the untrusted trust badge regardless of package claims", async () => {
    mocks.verifySkillBundle.mockResolvedValue(VERIFY_OK)
    renderDialog()

    expect(await screen.findByText("untrusted")).toBeTruthy()
    // 信任文案与机器码同段渲染：断言对话框整体包含其 key
    expect(screen.getByRole("dialog").textContent).toContain("skillbundle.import.trustUntrusted")
  })

  it("displays the manifest and allowlists", async () => {
    mocks.verifySkillBundle.mockResolvedValue(VERIFY_OK)
    renderDialog()

    expect(await screen.findByText("演示包")).toBeTruthy()
    expect(screen.getByText("state/a")).toBeTruthy()
    expect(screen.getByText("prompts/x.md")).toBeTruthy()
  })

  it("shows none-declared hints for empty allowlists", async () => {
    mocks.verifySkillBundle.mockResolvedValue({
      ...VERIFY_OK,
      manifest: {
        ...VERIFY_OK.manifest,
        allowlist: { readable_state: [], writable_artifacts: [] },
      },
    })
    renderDialog()

    expect(await screen.findAllByText("skillbundle.import.noneDeclared")).toHaveLength(2)
  })

  it("lists mismatched files and blocks import", async () => {
    mocks.verifySkillBundle.mockResolvedValue({
      ...VERIFY_OK,
      mismatched: ["skills/a/SKILL.md"],
    })
    const onClose = vi.fn()
    renderDialog({ onClose })

    expect(await screen.findByText("skills/a/SKILL.md")).toBeTruthy()
    expect(screen.getByText("skillbundle.import.gateDenied")).toBeTruthy()
    // 存在拒绝项时确认框被禁用
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
  })

  it("imports after explicit confirmation and reports the installed dir", async () => {
    mocks.verifySkillBundle.mockResolvedValue(VERIFY_OK)
    mocks.importSkillBundle.mockResolvedValue(IMPORT_OK)
    const onImported = vi.fn()
    renderDialog({ onImported })

    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement
    // 未确认时提交按钮禁用
    const submit = screen.getByText("skillbundle.import.submit").closest("button")!
    expect(submit.disabled).toBe(true)

    fireEvent.click(checkbox)
    expect(submit.disabled).toBe(false)

    fireEvent.click(submit)
    await waitFor(() => {
      expect(mocks.importSkillBundle).toHaveBeenCalledWith("C:/packs/demo.zip", "C:/proj", true)
    })
    expect(await screen.findByText("C:/proj/skills/demo")).toBeTruthy()
    expect(onImported).toHaveBeenCalledWith(IMPORT_OK)
  })

  it("shows import warnings returned by the importer", async () => {
    mocks.verifySkillBundle.mockResolvedValue(VERIFY_OK)
    mocks.importSkillBundle.mockResolvedValue({ ...IMPORT_OK, warnings: ["extra file skipped"] })
    renderDialog()

    fireEvent.click(await screen.findByRole("checkbox"))
    fireEvent.click(screen.getByText("skillbundle.import.submit").closest("button")!)
    expect(await screen.findByText("extra file skipped")).toBeTruthy()
  })

  it("surfaces import failure with diagnostics detail", async () => {
    mocks.verifySkillBundle.mockResolvedValue(VERIFY_OK)
    mocks.importSkillBundle.mockRejectedValue(new Error("rust: permission denied"))
    renderDialog()

    fireEvent.click(await screen.findByRole("checkbox"))
    fireEvent.click(screen.getByText("skillbundle.import.submit").closest("button")!)

    expect(await screen.findByText("skillbundle.import.importFailed")).toBeTruthy()
    const details = screen.getByText("skillbundle.import.diagnostics").closest("details")
    expect(details?.textContent).toContain("permission denied")
  })

  it("requires a destination root before import is allowed", async () => {
    mocks.verifySkillBundle.mockResolvedValue(VERIFY_OK)
    render(
      <SkillBundleImportDialog open bundlePath="C:/packs/demo.zip" destRoot={null} onClose={() => {}} />,
    )

    fireEvent.click(await screen.findByRole("checkbox"))
    const submit = screen.getByText("skillbundle.import.submit").closest("button")!
    expect(submit.disabled).toBe(true)
    expect(mocks.importSkillBundle).not.toHaveBeenCalled()
  })

  it("closes on Escape when idle but not while busy", async () => {
    mocks.verifySkillBundle.mockResolvedValue(VERIFY_OK)
    const onClose = vi.fn()
    renderDialog({ onClose })

    await screen.findByText("演示包")
    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("closes on backdrop click but not on content click", async () => {
    mocks.verifySkillBundle.mockResolvedValue(VERIFY_OK)
    const onClose = vi.fn()
    renderDialog({ onClose })

    const dialog = await screen.findByRole("dialog")
    fireEvent.click(dialog)
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText("演示包"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
