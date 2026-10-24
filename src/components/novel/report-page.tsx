/**
 * report-page.tsx — 只读报告页的共用骨架。
 *
 * 这些页面的数据仍是诊断、清单和空态，不改成仪表盘，也不新增写操作。
 * 骨架只负责桌面写作工作台的阅读层次：页题、分区、状态条。
 *
 * @license MIT © Niko Buddy
 */

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export type ReportTone = "error" | "warn" | "ok" | "neutral"

const TONE_CLASS: Record<ReportTone, string> = {
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
  ok: "border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  neutral: "border-border bg-muted/40 text-foreground",
}

export function ReportPage({
  testId,
  title,
  description,
  actions,
  children,
}: {
  readonly testId?: string
  readonly title: string
  readonly description?: ReactNode
  readonly actions?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div data-testid={testId} className="h-full w-full min-w-0 overflow-y-auto bg-background">
      <div className="flex w-full min-w-0 flex-col gap-4 px-6 py-5">
        <header className="flex items-start justify-between gap-4 border-b border-border pb-3">
          <div className="min-w-0 space-y-1">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
            {description ? (
              <div className="text-sm leading-6 text-muted-foreground">{description}</div>
            ) : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </header>
        {children}
      </div>
    </div>
  )
}

export function ReportSection({
  testId,
  title,
  children,
  className,
}: {
  readonly testId?: string
  readonly title?: string
  readonly children: ReactNode
  readonly className?: string
}) {
  return (
    <section data-testid={testId} className={cn("rounded-md border border-border bg-card", className)}>
      {title ? (
        <h3 className="border-b border-border px-4 py-2 text-sm font-medium text-foreground">{title}</h3>
      ) : null}
      <div className="space-y-2 px-4 py-3 text-sm leading-6">{children}</div>
    </section>
  )
}

export function ReportCallout({
  testId,
  tone,
  children,
}: {
  readonly testId?: string
  readonly tone: ReportTone
  readonly children: ReactNode
}) {
  return (
    <p data-testid={testId} className={cn("rounded-md border px-3 py-2 text-sm leading-6", TONE_CLASS[tone])}>
      {children}
    </p>
  )
}

export function reportToneClass(tone: ReportTone): string {
  return TONE_CLASS[tone]
}
