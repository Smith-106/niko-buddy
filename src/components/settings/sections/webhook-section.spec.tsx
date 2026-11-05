/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, waitFor } from "@testing-library/react"
import { render, screen } from "@testing-library/react"
import { WebhookSection } from "./webhook-section"

const mocks = vi.hoisted(() => ({
  t: vi.fn((k: string) => k),
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

vi.mock("react-i18next", () => ({  initReactI18next: { type: "3rdParty", init: () => {} },  useTranslation: () => ({ t: mocks.t }) }))

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

describe("WebhookSection ping/验签行为（覆盖战役补齐）", () => {
  const FAKE_REQ = {
    url: "https://example.com/hook",
    method: "POST",
    headers: { "X-Niko-Signature": "sig-abc" },
    body: '{"t":1}',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    novelMocks.buildSignedWebhookRequest.mockResolvedValue({ ...FAKE_REQ })
    // 默认走真实内联 transport：dispatchNotify 被调时实际执行组件内联的 post
    //（fetch 全局 mock），既覆盖 post 分支，又钉住「签名请求确经 fetch 发出」。
    novelMocks.dispatchNotify.mockImplementation(async (transport: { post: (req: unknown) => Promise<unknown> }, _request: unknown) => {
      const fakeReq = { url: FAKE_REQ.url, method: FAKE_REQ.method, headers: FAKE_REQ.headers, body: FAKE_REQ.body }
      return transport.post(fakeReq) as Promise<{ ok: boolean; status: number }>
    })
    novelMocks.verifyWebhookSignature.mockResolvedValue(true)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200 })),
    )
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("默认事件 stalled：输入 URL 后 ping 成功，notice 显示 dispatch=ok", async () => {
    render(<WebhookSection />)
    fireEvent.change(screen.getByLabelText("novel.webhook.urlLabel"), {
      target: { value: "https://example.com/hook" },
    })
    fireEvent.click(screen.getByText("novel.webhook.ping").closest("button")!)
    await waitFor(() => {
      expect(novelMocks.buildSignedWebhookRequest).toHaveBeenCalledWith(
        expect.objectContaining({ type: "run.stalled" }),
        "test-secret",
        "https://example.com/hook",
      )
    })
    await waitFor(() => {
      expect(screen.getByText("dispatch=ok")).toBeTruthy()
    })
    // 内联 transport 确经 fetch 发出（URL/方法/签名头透传）。
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/hook",
      expect.objectContaining({
        method: "POST",
        headers: { "X-Niko-Signature": "sig-abc" },
        body: '{"t":1}',
      }),
    )
    // ping 成功后验签按钮可用
    expect(screen.getByText("novel.webhook.verify").closest("button")?.hasAttribute("disabled")).toBe(false)
  })

  it("切换事件到 run.completed 后 ping 携带新类型", async () => {
    render(<WebhookSection />)
    fireEvent.click(screen.getByText("run.completed"))
    fireEvent.change(screen.getByLabelText("novel.webhook.urlLabel"), {
      target: { value: "https://example.com/hook" },
    })
    fireEvent.click(screen.getByText("novel.webhook.ping").closest("button")!)
    await waitFor(() => {
      expect(novelMocks.buildSignedWebhookRequest).toHaveBeenCalledWith(
        expect.objectContaining({ type: "run.completed" }),
        expect.anything(),
        expect.anything(),
      )
    })
  })

  it("空 URL 时 ping 不可触发（disabled 原生拦截）：无 notice、无请求", async () => {
    render(<WebhookSection />)
    // 该按钮 disabled 时，浏览器/jsdom 均不派发 click（React 亦按 fiber disabled 跳过），
    // 因此组件内 `if (!url.trim())` 的 setNotice+return 是纯防御分支（见报告不可达台账）。
    // 本用例钉住可观测行为：空 URL 下点击 ping 既不提示也不发请求。
    const ping = screen.getByText("novel.webhook.ping").closest("button")!
    expect(ping.hasAttribute("disabled")).toBe(true)
    ping.removeAttribute("disabled")
    fireEvent.click(ping)
    ;(ping as HTMLButtonElement).disabled = false
    ping.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText("novel.webhook.urlRequired")).toBeNull()
    expect(novelMocks.buildSignedWebhookRequest).not.toHaveBeenCalled()
    expect(novelMocks.dispatchNotify).not.toHaveBeenCalled()
  })

  it("dispatch 返回失败：notice 显示 dispatch=failed(500)", async () => {
    novelMocks.dispatchNotify.mockResolvedValue({ ok: false, status: 500 })
    render(<WebhookSection />)
    fireEvent.change(screen.getByLabelText("novel.webhook.urlLabel"), {
      target: { value: "https://example.com/hook" },
    })
    fireEvent.click(screen.getByText("novel.webhook.ping").closest("button")!)
    await waitFor(() => {
      expect(screen.getByText("dispatch=failed(500)")).toBeTruthy()
    })
  })

  it("dispatch 抛错（断网）：notice 带 pingFailed 前缀且仍可验签", async () => {
    novelMocks.dispatchNotify.mockRejectedValue(new Error("fetch failed"))
    render(<WebhookSection />)
    fireEvent.change(screen.getByLabelText("novel.webhook.urlLabel"), {
      target: { value: "https://example.com/hook" },
    })
    fireEvent.click(screen.getByText("novel.webhook.ping").closest("button")!)
    await waitFor(() => {
      expect(screen.getByText(/novel\.webhook\.pingFailed.*fetch failed/)).toBeTruthy()
    })
    // 签名已生成（catch 之前 setLastSigned），验签可用
    expect(screen.getByText("novel.webhook.verify").closest("button")?.hasAttribute("disabled")).toBe(false)
  })

  it("自定义密钥参与签名与验签（非默认 test-secret）", async () => {
    render(<WebhookSection />)
    fireEvent.change(screen.getByLabelText("novel.webhook.urlLabel"), {
      target: { value: "https://example.com/hook" },
    })
    fireEvent.change(screen.getByLabelText("novel.webhook.secretLabel"), {
      target: { value: "s3cr3t" },
    })
    fireEvent.click(screen.getByText("novel.webhook.ping").closest("button")!)
    await waitFor(() => {
      expect(novelMocks.buildSignedWebhookRequest).toHaveBeenCalledWith(
        expect.anything(),
        "s3cr3t",
        expect.anything(),
      )
    })
    fireEvent.click(screen.getByText("novel.webhook.verify").closest("button")!)
    await waitFor(() => {
      expect(novelMocks.verifyWebhookSignature).toHaveBeenCalledWith("s3cr3t", '{"t":1}', "sig-abc")
    })
    await waitFor(() => {
      expect(screen.getByText("novel.webhook.sigOk")).toBeTruthy()
    })
  })

  it("验签失败显示 sigBad", async () => {
    novelMocks.verifyWebhookSignature.mockResolvedValue(false)
    render(<WebhookSection />)
    fireEvent.change(screen.getByLabelText("novel.webhook.urlLabel"), {
      target: { value: "https://example.com/hook" },
    })
    fireEvent.click(screen.getByText("novel.webhook.ping").closest("button")!)
    await waitFor(() => {
      expect(screen.getByText("novel.webhook.verify").closest("button")?.hasAttribute("disabled")).toBe(false)
    })
    fireEvent.click(screen.getByText("novel.webhook.verify").closest("button")!)
    await waitFor(() => {
      expect(screen.getByText("novel.webhook.sigBad")).toBeTruthy()
    })
  })
})
