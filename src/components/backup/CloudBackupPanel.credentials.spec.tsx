// @vitest-environment jsdom
/**
 * CloudBackupPanel 凭据链专项（B3）：
 *   - secret_available=false → 凭据控件禁用 + 明示提示（不是等写入失败）；
 *   - 一次性输入 → secret_put → credentialRef 回填、输入清空；
 *   - 清除凭据 → secret_delete → 引用清空；
 *   - 失败可见（错误提示，不静默）。
 *
 * 安全面断言：输入框 type=password；测试中出现的字符串是假凭据，仅用于流程验证。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { act, fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { CloudBackupPanel } from "./CloudBackupPanel"

const mocks = vi.hoisted(() => ({
  cloudBackupStatus: vi.fn(),
  listCloudConflicts: vi.fn(),
  configureCloudBackup: vi.fn(),
  testCloudBackup: vi.fn(),
  pushCloudBackup: vi.fn(),
  pullCloudBackup: vi.fn(),
  secretAvailable: vi.fn(),
  secretPut: vi.fn(),
  secretDelete: vi.fn(),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/lib/novel", () => ({
  cloudBackupStatus: mocks.cloudBackupStatus,
  listCloudConflicts: mocks.listCloudConflicts,
  configureCloudBackup: mocks.configureCloudBackup,
  testCloudBackup: mocks.testCloudBackup,
  pushCloudBackup: mocks.pushCloudBackup,
  pullCloudBackup: mocks.pullCloudBackup,
  summarizeConflict: (conflict: { name: string; size: number }) =>
    `${conflict.name} (${conflict.size} B)`,
  validateSyncConfig: () => [],
}))

vi.mock("@/lib/secret-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/secret-client")>()
  return {
    ...actual,
    secretAvailable: mocks.secretAvailable,
    secretPut: mocks.secretPut,
    secretDelete: mocks.secretDelete,
  }
})

const STATUS = {
  configured: true,
  enabled: false,
  endpoint: "https://dav.example.com",
  root: "backups",
  credentialRef: "",
  credentialAvailable: true,
  journalEntries: 0,
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function renderPanel(projectPath = "/p/mybook"): void {
  render(<CloudBackupPanel projectPath={projectPath} deviceId="dev-1" />)
}

describe("CloudBackupPanel 凭据链（B3）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.cloudBackupStatus.mockResolvedValue({ ...STATUS })
    mocks.listCloudConflicts.mockResolvedValue([])
    mocks.secretAvailable.mockResolvedValue(true)
    mocks.secretPut.mockResolvedValue("nb:webdav:mybook")
    mocks.secretDelete.mockResolvedValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("凭据库可用：输入为密码框，保存 → secret_put 以派生账户写入并回填引用、清空输入", async () => {
    renderPanel()
    await flushAsync()

    const secretInput = screen.getByPlaceholderText("user:password") as HTMLInputElement
    expect(secretInput.type).toBe("password")
    expect(secretInput.disabled).toBe(false)

    fireEvent.change(secretInput, { target: { value: "user:not-a-real-secret" } })
    fireEvent.click(screen.getByText("backup.cloud.credentialSave"))
    await flushAsync()

    expect(mocks.secretPut).toHaveBeenCalledWith("webdav", "mybook", "user:not-a-real-secret")
    // 引用回填到配置输入；一次性输入已清空。
    const refInput = screen.getByPlaceholderText("nb:webdav:project") as HTMLInputElement
    expect(refInput.value).toBe("nb:webdav:mybook")
    expect((screen.getByPlaceholderText("user:password") as HTMLInputElement).value).toBe("")
    // 引用已建立 → 清除按钮出现。
    expect(screen.getByText("backup.cloud.credentialClear")).toBeTruthy()
  })

  it("已有引用时轮换凭据：复用引用中的 domain/account", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({ ...STATUS, credentialRef: "nb:webdav:proj-42" })
    renderPanel()
    await flushAsync()

    const secretInput = screen.getByPlaceholderText("user:password") as HTMLInputElement
    fireEvent.change(secretInput, { target: { value: "rotate-me" } })
    fireEvent.click(screen.getByText("backup.cloud.credentialSave"))
    await flushAsync()

    expect(mocks.secretPut).toHaveBeenCalledWith("webdav", "proj-42", "rotate-me")
  })

  it("凭据库不可用：控件禁用 + 明示提示（禁止明文回退，不是沉默失败）", async () => {
    mocks.secretAvailable.mockResolvedValue(false)
    renderPanel()
    await flushAsync()

    expect(screen.getByText("backup.cloud.credentialStoreDisabled")).toBeTruthy()
    expect((screen.getByPlaceholderText("user:password") as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByText("backup.cloud.credentialSave") as HTMLButtonElement).disabled).toBe(true)
  })

  it("可用性探测失败按不可用处理（禁用而非放行）", async () => {
    mocks.secretAvailable.mockRejectedValue(new Error("probe down"))
    renderPanel()
    await flushAsync()

    expect(screen.getByText("backup.cloud.credentialStoreDisabled")).toBeTruthy()
    expect((screen.getByPlaceholderText("user:password") as HTMLInputElement).disabled).toBe(true)
  })

  it("保存失败可见：错误提示出现，输入保留供重试", async () => {
    mocks.secretPut.mockRejectedValue("[secret_store] OS keyring unavailable")
    renderPanel()
    await flushAsync()

    const secretInput = screen.getByPlaceholderText("user:password") as HTMLInputElement
    fireEvent.change(secretInput, { target: { value: "will-fail" } })
    fireEvent.click(screen.getByText("backup.cloud.credentialSave"))
    await flushAsync()

    expect(screen.getByText(/backup.cloud.errorLead/)).toBeTruthy()
    expect((screen.getByPlaceholderText("user:password") as HTMLInputElement).value).toBe("will-fail")
    const refInput = screen.getByPlaceholderText("nb:webdav:project") as HTMLInputElement
    expect(refInput.value).toBe("")
  })

  it("清除凭据：secret_delete 以引用解析出的 domain/account 调用，随后引用清空", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({ ...STATUS, credentialRef: "nb:webdav:proj-42" })
    renderPanel()
    await flushAsync()

    fireEvent.click(screen.getByText("backup.cloud.credentialClear"))
    await flushAsync()

    expect(mocks.secretDelete).toHaveBeenCalledWith("webdav", "proj-42")
    const refInput = screen.getByPlaceholderText("nb:webdav:project") as HTMLInputElement
    expect(refInput.value).toBe("")
    expect(screen.queryByText("backup.cloud.credentialClear")).toBeNull()
  })

  it("清除失败可见：错误提示出现，引用保留", async () => {
    mocks.cloudBackupStatus.mockResolvedValue({ ...STATUS, credentialRef: "nb:webdav:proj-42" })
    mocks.secretDelete.mockRejectedValue("[secret_store] delete failed")
    renderPanel()
    await flushAsync()

    fireEvent.click(screen.getByText("backup.cloud.credentialClear"))
    await flushAsync()

    expect(screen.getByText(/backup.cloud.errorLead/)).toBeTruthy()
    const refInput = screen.getByPlaceholderText("nb:webdav:project") as HTMLInputElement
    expect(refInput.value).toBe("nb:webdav:proj-42")
  })
})
