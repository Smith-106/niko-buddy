import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { Webhook, Send, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  buildSignedWebhookRequest,
  dispatchNotify,
  verifyWebhookSignature,
  type NotifyEventType,
} from "@/lib/novel/webhook-notifier"

/**
 * WebhookSection — Webhook 守护配置卡（65 号共识 G2 挂载：形态轴 F6 消费侧）。
 *
 * 边界：HMAC 密钥仅函数参数（不落 payload/status.json）；测试 ping 走
 * `dispatchNotify` 端到端签名 + 接收端 `verifyWebhookSignature` 验签演示；
 * transport 内联 fetch（测试环境无网络时优雅降级提示）；零 LLM。
 */
const EVENT_OPTIONS: { value: NotifyEventType; label: string }[] = [
  { value: "run.stalled", label: "run.stalled" },
  { value: "run.completed", label: "run.completed" },
]

export function WebhookSection() {
  const { t } = useTranslation()
  const [url, setUrl] = useState("")
  const [secret, setSecret] = useState("")
  const [eventType, setEventType] = useState<NotifyEventType>("run.stalled")
  const [notice, setNotice] = useState<string | null>(null)
  const [lastSigned, setLastSigned] = useState<{ body: string; signatureHeader: string } | null>(null)

  const ping = useCallback(async () => {
    if (!url.trim()) {
      setNotice(t("novel.webhook.urlRequired") ?? "请输入回调 URL")
      return
    }
    const secretValue = secret.trim() || "test-secret"
    const event: { type: NotifyEventType; projectPath: string; chapterNumber: number; message: string } = {
      type: eventType,
      projectPath: "",
      chapterNumber: 0,
      message: "webhook-section test ping",
    }
    const request = await buildSignedWebhookRequest(event, secretValue, url.trim())
    setLastSigned({ body: request.body, signatureHeader: request.headers["X-Niko-Signature"] })
    try {
      const result = await dispatchNotify(
        {
          post: async (req) => {
            const res = await fetch(req.url, {
              method: req.method,
              headers: req.headers,
              body: req.body,
            })
            return { ok: res.ok, status: res.status }
          },
        },
        request,
      )
      setNotice(`dispatch=${result.ok ? "ok" : `failed(${result.status})`}`)
    } catch (err) {
      setNotice(`${t("novel.webhook.pingFailed") ?? "ping 发送失败（签名已生成可验签）"}：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [url, secret, eventType, t])

  const verify = useCallback(async () => {
    if (!lastSigned) return
    const ok = await verifyWebhookSignature(secret.trim() || "test-secret", lastSigned.body, lastSigned.signatureHeader)
    setNotice(ok ? t("novel.webhook.sigOk") ?? "验签通过（sha256 一致）" : t("novel.webhook.sigBad") ?? "验签失败")
  }, [lastSigned, secret, t])

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-4 webhook-section" data-testid="webhook-section">
      <div className="flex items-center gap-2 text-sm font-semibold">
          <Webhook className="h-4 w-4" />
          {t("novel.webhook.title")}
        </div>
      <div className="space-y-3 pt-2">
        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder={t("novel.webhook.urlPh") ?? "https://example.com/hook"}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="max-w-[240px]"
          />
          <Input
            placeholder={t("novel.webhook.secretPh") ?? "HMAC 密钥"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="max-w-[160px]"
            type="password"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {EVENT_OPTIONS.map((e) => (
            <Button
              key={e.value}
              size="sm"
              variant={eventType === e.value ? "default" : "outline"}
              onClick={() => setEventType(e.value)}
            >
              {e.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={ping} disabled={!url.trim()}>
            <Send className="mr-1 h-3 w-3" />
            {t("novel.webhook.ping") ?? "测试 ping"}
          </Button>
          <Button size="sm" variant="outline" onClick={verify} disabled={!lastSigned}>
            <ShieldCheck className="mr-1 h-3 w-3" />
            {t("novel.webhook.verify") ?? "验签"}
          </Button>
        </div>
      </div>
    </div>
  )
}
