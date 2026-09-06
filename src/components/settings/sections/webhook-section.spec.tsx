/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@testing-library/react"
import { WebhookSection } from "./webhook-section"

const mocks = vi.hoisted(() => ({
  t: vi.fn((k: string) => k),
}))

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }))

describe("WebhookSection", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it("渲染配置卡（事件选项 + 输入槽）", () => {
    render(<WebhookSection />)
    expect(screen.getByTestId("webhook-section")).toBeTruthy()
    expect(screen.getByText("run.stalled")).toBeTruthy()
    expect(screen.getByText("run.completed")).toBeTruthy()
  })

  it("URL 为空时 ping 按钮禁用（优雅降级）", () => {
    render(<WebhookSection />)
    const ping = screen.getByText("novel.webhook.ping").closest("button")
    expect(ping?.hasAttribute("disabled")).toBe(true)
  })

  it("未生成签名前验签按钮禁用", () => {
    render(<WebhookSection />)
    const verify = screen.getByText("novel.webhook.verify").closest("button")
    expect(verify?.hasAttribute("disabled")).toBe(true)
  })
})
