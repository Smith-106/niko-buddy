/** @vitest-environment jsdom */
/**
 * WebhookSection — 防御守卫 + 翻译缺失回退分支（覆盖率战役补齐）。
 *
 * 与 `webhook-section.spec.tsx` 互补（不重写、不删既有用例）：
 * - 既有 spec 走真实 `Button`，`disabled` 使「URL 为空仍点 ping」「未签名先验签」不可达；
 * - 本文件把 `Button` 换成不实现 `disabled` 的原生按钮，钉住组件自身的守卫行为
 *   （防御焦点：按钮禁用是 UI 层约定，handler 仍须自证不越界）；
 * - 另覆盖 `t(...) ?? <中文默认>` 的回退分支（i18n key 缺失时的可观测文案）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { WebhookSection } from "./webhook-section"

const mocks = vi.hoisted(() => ({
  t: vi.fn((k: string): string | undefined => k),
}))

const novelMocks = vi.hoisted(() => ({
  buildSignedWebhookRequest: vi.fn(),
  dispatchNotify: vi.fn(),
  verifyWebhookSignature: vi.fn(),
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    buildSignedWebhookRequest: novelMocks.buildSignedWebhookRequest,
    dispatchNotify: novelMocks.dispatchNotify,
    verifyWebhookSignature: novelMocks.verifyWebhookSignature,
  }
})

// 不实现 disabled 的按钮替身：让 handler 守卫成为唯一防线。
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled: _ignored }: { children?: unknown; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick}>
      {children as never}
    </button>
  ),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

const FAKE_REQ = {
  url: "https://example.com/hook",
  method: "POST",
  headers: { "X-Niko-Signature": "sig-abc" },
  body: '{"t":1}',
}

/** 只对指定 key 返回 undefined，模拟 i18n 缺词条（其余照常回 key）。 */
function tUndefinedFor(keys: string[]) {
  mocks.t.mockImplementation((k: string) => (keys.includes(k) ? undefined : k))
}

describe("WebhookSection 守卫分支（Button 不实现 disabled）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.t.mockImplementation((k: string) => k)
    novelMocks.buildSignedWebhookRequest.mockResolvedValue({ ...FAKE_REQ })
    novelMocks.dispatchNotify.mockResolvedValue({ ok: true, status: 200 })
    novelMocks.verifyWebhookSignature.mockResolvedValue(true)
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })))
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("URL 为空时点击 ping：提示 urlRequired，且不生成签名、不派发", async () => {
    render(<WebhookSection />)
    fireEvent.click(screen.getByText("novel.webhook.ping"))
    await waitFor(() => expect(screen.getByText("novel.webhook.urlRequired")).toBeTruthy())
    expect(novelMocks.buildSignedWebhookRequest).not.toHaveBeenCalled()
    expect(novelMocks.dispatchNotify).not.toHaveBeenCalled()
  })

  it("URL 仅有空白字符同样拦截（trim 语义）", async () => {
    render(<WebhookSection />)
    fireEvent.change(screen.getByLabelText("novel.webhook.urlLabel"), { target: { value: "   " } })
    fireEvent.click(screen.getByText("novel.webhook.ping"))
    await waitFor(() => expect(screen.getByText("novel.webhook.urlRequired")).toBeTruthy())
    expect(novelMocks.buildSignedWebhookRequest).not.toHaveBeenCalled()
  })

  it("缺 urlRequired 词条时回退中文提示", async () => {
    tUndefinedFor(["novel.webhook.urlRequired"])
    render(<WebhookSection />)
    fireEvent.click(screen.getByText("novel.webhook.ping"))
    await waitFor(() => expect(screen.getByText("请输入回调 URL")).toBeTruthy())
    expect(novelMocks.buildSignedWebhookRequest).not.toHaveBeenCalled()
  })

  it("未生成签名时点击验签：直接返回，不调用 verifyWebhookSignature", async () => {
    render(<WebhookSection />)
    fireEvent.click(screen.getByText("novel.webhook.verify"))
    // 给潜在 promise 一个落地窗口，确认确实没有异步副作用
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(novelMocks.verifyWebhookSignature).not.toHaveBeenCalled()
    // 无 notice（notice 区块整体不渲染）
    expect(screen.queryByText("novel.webhook.sigOk")).toBeNull()
    expect(screen.queryByText("novel.webhook.sigBad")).toBeNull()
  })
})

describe("WebhookSection 翻译缺失回退（t 返回 undefined）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    novelMocks.buildSignedWebhookRequest.mockResolvedValue({ ...FAKE_REQ })
    novelMocks.dispatchNotify.mockResolvedValue({ ok: true, status: 200 })
    novelMocks.verifyWebhookSignature.mockResolvedValue(true)
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })))
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("placeholder / 按钮文案缺词条时回退中文默认", () => {
    tUndefinedFor(["novel.webhook.urlPh", "novel.webhook.secretPh", "novel.webhook.ping", "novel.webhook.verify"])
    render(<WebhookSection />)
    expect(screen.getByPlaceholderText("https://example.com/hook")).toBeTruthy()
    expect(screen.getByPlaceholderText("HMAC 密钥")).toBeTruthy()
    expect(screen.getByText("测试 ping")).toBeTruthy()
    expect(screen.getByText("验签")).toBeTruthy()
  })

  it("ping 抛错且缺 pingFailed 词条时回退中文前缀", async () => {
    tUndefinedFor(["novel.webhook.pingFailed"])
    novelMocks.dispatchNotify.mockRejectedValue(new Error("fetch failed"))
    render(<WebhookSection />)
    fireEvent.change(screen.getByLabelText("novel.webhook.urlLabel"), {
      target: { value: "https://example.com/hook" },
    })
    fireEvent.click(screen.getByText("novel.webhook.ping"))
    await waitFor(() => {
      expect(screen.getByText(/^ping 发送失败（签名已生成可验签）：fetch failed$/)).toBeTruthy()
    })
  })

  it("验签通过且缺 sigOk 词条时回退中文", async () => {
    tUndefinedFor(["novel.webhook.sigOk"])
    render(<WebhookSection />)
    fireEvent.change(screen.getByLabelText("novel.webhook.urlLabel"), {
      target: { value: "https://example.com/hook" },
    })
    fireEvent.click(screen.getByText("novel.webhook.ping"))
    await waitFor(() => expect(screen.getByText("dispatch=ok")).toBeTruthy())
    fireEvent.click(screen.getByText("novel.webhook.verify"))
    await waitFor(() => expect(screen.getByText("验签通过（sha256 一致）")).toBeTruthy())
    expect(novelMocks.verifyWebhookSignature).toHaveBeenCalledWith("test-secret", '{"t":1}', "sig-abc")
  })

  it("验签失败且缺 sigBad 词条时回退中文", async () => {
    tUndefinedFor(["novel.webhook.sigBad"])
    novelMocks.verifyWebhookSignature.mockResolvedValue(false)
    render(<WebhookSection />)
    fireEvent.change(screen.getByLabelText("novel.webhook.urlLabel"), {
      target: { value: "https://example.com/hook" },
    })
    fireEvent.click(screen.getByText("novel.webhook.ping"))
    await waitFor(() => expect(screen.getByText("dispatch=ok")).toBeTruthy())
    fireEvent.click(screen.getByText("novel.webhook.verify"))
    await waitFor(() => expect(screen.getByText("验签失败")).toBeTruthy())
  })
})
