/**
 * 64 号实施（63 号共识 §6 P0-7）：WebhookNotifier — 守护 + IM/Webhook 通知.
 *
 * 定位：引擎 = 边沿判定（shouldNotify）+ 签名载荷（buildSignedWebhookRequest）
 * + 注入式 dispatch（NotifyTransport）。纯函数零 IO（ADR-19）；HTTP 由调用方
 * 注入 transport（参考 feedback.ts 的 plugin-http 模式，本文件不写死 URL）。
 *
 * 守护语义：不是 OS 级后台服务——调用方在 subscribeStatusJson 与 watchdog
 * poll 的边沿触发 shouldNotify（run.stalled 边沿一次；completed 互斥）。不
 * 新建轮询真源。密钥仅函数参数（禁止写入 status.json / telemetry）。
 * CWE-532：payload 禁正文、禁绝对路径、禁 token。
 */

import { hmacSha256Hex } from "./checkpoint-digest"
import { stableStringify } from "./checkpoint-digest"

export type NotifyEventType =
  | "run.stalled"
  | "run.completed"
  | "chapter.accepted"
  | "translation.finalized"

export interface NotifyEvent {
  type: NotifyEventType
  /** 调用方注入 ISO 时间（纯函数禁隐式取时）。 */
  occurredAt: string
  /** 项目短 id（digest 前缀），禁止绝对路径。 */
  projectId: string
  /** 禁正文/禁绝对路径/禁 token。 */
  payload: Record<string, string | number | boolean | null>
}

export interface SignedWebhookRequest {
  url: string
  method: "POST"
  headers: {
    "Content-Type": "application/json"
    "X-Niko-Signature": string
    "X-Niko-Event": NotifyEventType
  }
  body: string
}

export interface NotifyTransport {
  post(req: SignedWebhookRequest, signal?: AbortSignal): Promise<{ ok: boolean; status: number }>
}

/** 构建签名 webhook 请求（签名不覆盖 signature 字段——载荷无该字段）。 */
export async function buildSignedWebhookRequest(
  event: NotifyEvent,
  secret: string,
  url: string,
): Promise<SignedWebhookRequest> {
  const body = stableStringify(event)
  const signature = await hmacSha256Hex(secret, body)
  return {
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Niko-Signature": `sha256=${signature}`,
      "X-Niko-Event": event.type,
    },
    body,
  }
}

/** 派发通知（transport 注入；未配置 secret → 调用方不应调用本函数）。 */
export async function dispatchNotify(
  transport: NotifyTransport,
  req: SignedWebhookRequest,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number }> {
  return transport.post(req, signal)
}

/** 校验回调签名（webhook 接收端用）：sha256=<hex> 且与本地重算一致。 */
export async function verifyWebhookSignature(
  secret: string,
  canonicalBody: string,
  signatureHeader: string,
): Promise<boolean> {
  const prefix = "sha256="
  if (!signatureHeader.startsWith(prefix)) return false
  const hex = signatureHeader.slice(prefix.length)
  const { verifyHmacSha256Hex } = await import("./checkpoint-digest")
  return verifyHmacSha256Hex(secret, canonicalBody, hex)
}
