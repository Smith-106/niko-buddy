import { describe, expect, it, vi } from "vitest"
import {
  buildSignedWebhookRequest,
  dispatchNotify,
  verifyWebhookSignature,
  type NotifyEvent,
  type NotifyTransport,
} from "./webhook-notifier"
import { hmacSha256Hex } from "./checkpoint-digest"
import { shouldNotify, type WatchdogVerdict } from "./watchdog"

const EVENT: NotifyEvent = {
  type: "run.completed",
  occurredAt: "2026-09-06T00:00:00.000Z",
  projectId: "a1b2c3",
  payload: { chapters: 12 },
}

const verdict = (action: "continue" | "block_fallback", triggered: boolean): WatchdogVerdict => ({
  action,
  elapsedMs: 100,
  triggered,
})

describe("webhook-notifier (64 号实施：P0-7 守护 + Webhook HMAC)", () => {
  it("buildSignedWebhookRequest：签名头 + 规范体 + 事件头", async () => {
    const req = await buildSignedWebhookRequest(EVENT, "s3cret", "https://im.example/hook")
    expect(req.method).toBe("POST")
    expect(req.headers["X-Niko-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(req.headers["X-Niko-Event"]).toBe("run.completed")
    expect(JSON.parse(req.body).type).toBe("run.completed")
  })

  it("签名稳定：同 secret 同事件同签名", async () => {
    const a = await buildSignedWebhookRequest(EVENT, "s3cret", "https://x")
    const b = await buildSignedWebhookRequest(EVENT, "s3cret", "https://x")
    expect(a.headers["X-Niko-Signature"]).toBe(b.headers["X-Niko-Signature"])
  })

  it("错误 secret → 签名不同", async () => {
    const a = await buildSignedWebhookRequest(EVENT, "s3cret", "https://x")
    const b = await buildSignedWebhookRequest(EVENT, "other", "https://x")
    expect(a.headers["X-Niko-Signature"]).not.toBe(b.headers["X-Niko-Signature"])
  })

  it("verifyWebhookSignature：正确签名通过；篡改失败；坏头拒绝", async () => {
    const req = await buildSignedWebhookRequest(EVENT, "s3cret", "https://x")
    expect(await verifyWebhookSignature("s3cret", req.body, req.headers["X-Niko-Signature"])).toBe(true)
    expect(await verifyWebhookSignature("s3cret", req.body + "x", req.headers["X-Niko-Signature"])).toBe(false)
    expect(await verifyWebhookSignature("s3cret", req.body, "naked-hex")).toBe(false)
  })

  it("键序无关：stableStringify 规范化后签名相同", async () => {
    const { stableStringify } = await import("./checkpoint-digest")
    const a = await hmacSha256Hex("k", stableStringify({ a: 1, b: 2 }))
    const b = await hmacSha256Hex("k", stableStringify({ b: 2, a: 1 }))
    expect(a).toBe(b)
  })

  it("dispatchNotify：transport 注入被调用", async () => {
    const transport: NotifyTransport = {
      post: vi.fn(async () => ({ ok: true, status: 200 })),
    }
    const req = await buildSignedWebhookRequest(EVENT, "s3cret", "https://x")
    const res = await dispatchNotify(transport, req)
    expect(res.ok).toBe(true)
    expect(transport.post).toHaveBeenCalledTimes(1)
  })

  it("shouldNotify：continue→block_fallback 边沿 → run.stalled 一次", () => {
    expect(shouldNotify(verdict("continue", false), verdict("block_fallback", true))).toEqual({ type: "run.stalled" })
  })

  it("shouldNotify：已 triggered 持续 → 不再通知", () => {
    expect(shouldNotify(verdict("block_fallback", true), verdict("block_fallback", true))).toBeNull()
  })

  it("shouldNotify：无边沿（继续运行）→ null", () => {
    expect(shouldNotify(verdict("continue", false), verdict("continue", false))).toBeNull()
  })
})
