// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// Spec for src/components/skills/SkillBundleImportDialog.tsx
//
// 三模型审计 round-1（glm 独立发现，源码复核成立）：
//   ① 校验/导入失败的 `String(cause)` 直接渲染 → 中文界面露出英文报错；
//   ② `rejected` / `warnings` 是 Rust 侧英文诊断串（`Vec<String>`），被当正文渲染；
//   ③ role="dialog" 有 aria-modal 但标题未关联 → 读屏只播报空对话框。
// 本 spec 锁定「可读文案走 i18n、诊断串只进折叠区、对话框有可访问名」。

import { cleanup } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@/test-helpers/component-test-utils"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string, _options?: Record<string, unknown>) => key),
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

import { SkillBundleImportDialog } from "./SkillBundleImportDialog"

const VERIFY_OK = {
  ok: true,
  manifest: {
    id: "demo",
    name: "演示包",
    version: "1.0.0",
    schema: "nbskill/1.0",
    min_nb_version: "0.1.0",
    source: "local",
    trust_level: "untrusted",
    allowlist: { readable_state: [], writable_artifacts: ["prompts/x.md"] },
  },
  rejected: [] as string[],
  mismatched: [] as string[],
  entries: [],
  warnings: [],
}

function renderDialog() {
  return render(
    <SkillBundleImportDialog
      open
      bundlePath="C:/packs/demo.nbskill"
      destRoot="C:/proj"
      onClose={() => {}}
    />,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("SkillBundleImportDialog / 诊断与外泄边界", () => {
  it("校验失败时展示本地化文案，原始错误只进诊断详情", async () => {
    mocks.verifySkillBundle.mockRejectedValue(new Error("failed to read zip: Permission denied"))

    renderDialog()

    expect(await screen.findByText("skillbundle.import.verifyFailed")).toBeTruthy()
    // 英文原始串不得作为主文案出现（只在 <details> 诊断里）
    const details = screen.getByText("skillbundle.import.diagnostics").closest("details")
    expect(details).toBeTruthy()
    expect(details?.textContent).toContain("Permission denied")
  })

  it("拒绝项与导入告警的英文诊断串不进入主文案层", async () => {
    mocks.verifySkillBundle.mockResolvedValue({
      ...VERIFY_OK,
      rejected: ["[skill_bundle] requires Niko Buddy >= 9.9.9, current 2.8.2"],
    })

    renderDialog()

    const summary = await screen.findByText("skillbundle.import.diagnostics")
    const details = summary.closest("details")
    expect(details?.textContent).toContain("requires Niko Buddy")
    // 主标题仍是本地化结论；诊断串在折叠区内
    expect(screen.getByText("skillbundle.import.rejected")).toBeTruthy()
    expect(summary.tagName.toLowerCase()).toBe("summary")
  })

  it("对话框有可访问名（aria-labelledby 指向标题）", async () => {
    mocks.verifySkillBundle.mockResolvedValue(VERIFY_OK)

    renderDialog()

    const dialog = screen.getByRole("dialog")
    expect(dialog.getAttribute("aria-labelledby")).toBe("skillbundle-import-title")
    await waitFor(() =>
      expect(document.getElementById("skillbundle-import-title")?.textContent).toBe(
        "skillbundle.import.title",
      ),
    )
  })
})
