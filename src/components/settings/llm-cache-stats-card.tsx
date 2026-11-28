// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useMemo, useState } from "react"
import { RefreshCw } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { getLlmRequestTraceSnapshot, type LlmRequestTraceSnapshot } from "@/lib/llm-client"
import {
  summarizeLlmCacheHits,
  summarizeLlmCacheHitsByProvider,
} from "@/lib/llm-request-trace"

export interface LlmCacheStatsCardProps {
  /** 测试或外部面板可直接注入只读快照；未传时从会话 trace 缓冲读取。 */
  snapshot?: LlmRequestTraceSnapshot
}

export function LlmCacheStatsCard({ snapshot: controlledSnapshot }: LlmCacheStatsCardProps) {
  const { t } = useTranslation()
  const [localSnapshot, setLocalSnapshot] = useState<LlmRequestTraceSnapshot>(() =>
    getLlmRequestTraceSnapshot(),
  )

  const snapshot = controlledSnapshot ?? localSnapshot

  const handleRefresh = useCallback(() => {
    setLocalSnapshot(getLlmRequestTraceSnapshot())
  }, [])

  const summary = useMemo(
    () => summarizeLlmCacheHits(snapshot.requests),
    [snapshot.requests],
  )
  const byProvider = useMemo(
    () => summarizeLlmCacheHitsByProvider(snapshot.requests),
    [snapshot.requests],
  )
  const providerEntries = useMemo(
    () => Object.entries(byProvider).sort(([a], [b]) => a.localeCompare(b)),
    [byProvider],
  )

  return (
    <div
      className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4"
      data-testid="llm-cache-stats-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold">
            {t("settings.llmCacheStats.title", { defaultValue: "Prompt 缓存命中诊断" })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("settings.llmCacheStats.description", {
              defaultValue: "统计当前会话内已收到用量回传的 LLM 请求前缀缓存命中情况。",
            })}
          </p>
        </div>
        {!controlledSnapshot && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={handleRefresh}
            data-testid="llm-cache-stats-refresh"
          >
            <RefreshCw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
            {t("settings.llmCacheStats.refresh", { defaultValue: "刷新" })}
          </Button>
        )}
      </div>

      {snapshot.requests.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="llm-cache-stats-empty">
          {t("settings.llmCacheStats.empty", {
            defaultValue: "暂无缓存命中采样数据，发送对话或写作请求后将在此显示。",
          })}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-md border border-border/50 bg-background/70 px-3 py-2">
              <div className="text-[11px] text-muted-foreground">
                {t("settings.llmCacheStats.hitRate", { defaultValue: "命中率" })}
              </div>
              <div className="text-base font-semibold tabular-nums" data-testid="llm-cache-hit-rate">
                {summary.hitRatePct.toFixed(1)}%
              </div>
              <div className="text-[11px] text-muted-foreground">
                {t("settings.llmCacheStats.hitsRatio", {
                  defaultValue: "{{hits}} / {{requests}} 次命中",
                  hits: summary.hits,
                  requests: summary.requests,
                })}
              </div>
            </div>

            <div className="rounded-md border border-border/50 bg-background/70 px-3 py-2">
              <div className="text-[11px] text-muted-foreground">
                {t("settings.llmCacheStats.savedTokens", { defaultValue: "节省输入" })}
              </div>
              <div className="text-base font-semibold tabular-nums" data-testid="llm-cache-saved-tokens">
                {summary.savedTokens.toLocaleString()}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {t("settings.llmCacheStats.savedPct", {
                  defaultValue: "占总输入 {{pct}}%",
                  pct: summary.savedInputPct.toFixed(1),
                })}
              </div>
            </div>

            <div className="rounded-md border border-border/50 bg-background/70 px-3 py-2">
              <div className="text-[11px] text-muted-foreground">
                {t("settings.llmCacheStats.totalInput", { defaultValue: "累计输入" })}
              </div>
              <div className="text-base font-semibold tabular-nums" data-testid="llm-cache-total-input">
                {summary.inputTokens.toLocaleString()}
              </div>
            </div>
          </div>

          {providerEntries.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                {t("settings.llmCacheStats.byProvider", { defaultValue: "按通道明细" })}
              </div>
              <ul className="space-y-1">
                {providerEntries.map(([provider, stats]) => (
                  <li
                    key={provider}
                    className="flex items-center justify-between gap-2 rounded border border-border/40 bg-background/50 px-2.5 py-1 text-xs"
                    data-testid={`llm-cache-provider-${provider}`}
                  >
                    <span className="font-medium">{provider}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {t("settings.llmCacheStats.providerSummary", {
                        defaultValue: "{{hits}}/{{requests}} 命中 · {{hitRate}}% · 省 {{saved}} tokens",
                        hits: stats.hits,
                        requests: stats.requests,
                        hitRate: stats.hitRatePct.toFixed(1),
                        saved: stats.savedTokens.toLocaleString(),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {snapshot.omittedRequestCount > 0 && (
            <p className="text-[11px] text-muted-foreground" data-testid="llm-cache-omitted-note">
              {t("settings.llmCacheStats.omitted", {
                defaultValue: "缓冲上限 32 条，已滚动淘汰 {{count}} 条较早记录。",
                count: snapshot.omittedRequestCount,
              })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
