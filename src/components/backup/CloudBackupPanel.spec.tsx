// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/backup/CloudBackupPanel.tsx（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { CloudBackupPanel } from "./CloudBackupPanel"
import { render, screen } from "@/test-helpers/component-test-utils"
import type { ComponentType } from "react"
describe("CloudBackupPanel.tsx smoke", () => {
  it("renders CloudBackupPanel without crashing", () => {
    const C = CloudBackupPanel as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    const rail = screen.getByTestId("cloud-backup-status-rail")
    expect(rail.querySelector("meter")).toBeNull()
    expect(rail).toHaveTextContent("endpoint must be an http(s) URL")
    expect(rail).toHaveTextContent("backup.cloud.noConflicts")
    expect(rail).not.toHaveTextContent("backup.cloud.enabled")
    unmount()
  })
})
