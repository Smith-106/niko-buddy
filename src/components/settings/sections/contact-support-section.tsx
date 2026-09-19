// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { HeartHandshake, MessageCircle, QrCode } from "lucide-react"
import { useTranslation } from "react-i18next"

/** Donation payment channels (QR images pending real assets). */
const DONATION_CHANNELS = [
  { key: "wechatPay" },
  { key: "alipayPay" },
] as const

/** Placeholder shown while the real QR image asset is not yet provided. */
function QrPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex aspect-[3/4] w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/30 p-4 text-center">
      <QrCode className="h-8 w-8 text-muted-foreground/60" />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

/**
 * Contact & support section showing WeChat contact info and donation QR codes.
 */
export function ContactSupportSection() {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.contactSupport.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.contactSupport.description")}
        </p>
      </div>

      {/* WeChat contact card */}
      <section className="rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <MessageCircle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">
              {t("settings.sections.contactSupport.contact.title")}
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("settings.sections.contactSupport.contact.description")}
            </p>
            <div className="mt-4 flex justify-center sm:justify-start">
              <div className="w-full max-w-[320px]">
                <QrPlaceholder
                  label={t("settings.sections.contactSupport.contact.alt")}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Donation channels */}
      <section className="rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <HeartHandshake className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">
              {t("settings.sections.contactSupport.donation.title")}
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("settings.sections.contactSupport.donation.description")}
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {DONATION_CHANNELS.map((channel) => (
                <div
                  key={channel.key}
                  className="rounded-md border border-border/70 bg-muted/20 p-3"
                >
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <QrCode className="h-4 w-4 text-primary" />
                    <span>
                      {t(`settings.sections.contactSupport.donation.${channel.key}.title`)}
                    </span>
                  </div>
                  <QrPlaceholder
                    label={t(`settings.sections.contactSupport.donation.${channel.key}.alt`)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
