// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

/**
 * 数据管理面板 — niko-buddy 数据隔离 + 一键删除的统一入口。
 *
 * 需求（用户）：改方案后能整批删干净，不要"只能一点点删"。
 * - 按逻辑数据组（章节快照/向量索引/缓存/反AI库/知识库/会话/模拟/配置…）
 *   展示占用 + 一键清空。
 * - 两阶段删除：先移入 `.niko-buddy/.trash-bin/`（可恢复），确认后物理删除。
 * - 整项目重置：所有数据域一次移入回收站。
 *
 * ISO 27001 裁剪：删除可追溯（回收站批次）+ 用户内容强确认（typed confirm）。
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  ArchiveRestore,
  Database,
  Eraser,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react"
import { ask } from "@tauri-apps/plugin-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DATA_DOMAINS,
  domainRequiresTypedConfirm,
  type DataDomain,
} from "@/lib/novel/data-domain-registry"
import {
  listTrash,
  moveAllToTrash,
  moveDomainToTrash,
  purgeTrashStamp,
  restoreDomainFromTrash,
  statAllDomains,
  type DomainStat,
  type TrashEntry,
} from "@/lib/novel/data-manager"
import { useWikiStore } from "@/stores/wiki-store"

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** kebab-case 域 id → camelCase i18n key 片段（chapter-snapshots→chapterSnapshots）。 */
function camelDomainKey(id: string): string {
  return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

const RISK_BADGE: Record<DataDomain["risk"], string> = {
  cache: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  generated: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  user: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
}

export function DataManagerView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const projectPath = project?.path ?? ""

  const [stats, setStats] = useState<Record<string, DomainStat>>({})
  const [trash, setTrash] = useState<TrashEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState("")

  const refresh = useCallback(async () => {
    if (!projectPath) return
    setLoading(true)
    try {
      const all = await statAllDomains(projectPath)
      const map: Record<string, DomainStat> = {}
      for (const s of all) map[s.domainId] = s
      setStats(map)
      setTrash(await listTrash(projectPath))
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const totalBytes = useMemo(
    () => Object.values(stats).reduce((acc, s) => acc + s.totalBytes, 0),
    [stats],
  )

  const newStamp = () =>
    new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)

  const doClearDomain = useCallback(
    async (domain: DataDomain) => {
      if (!projectPath) return
      const needTyped = domainRequiresTypedConfirm(domain)
      if (needTyped && confirmText.trim() !== domain.id) {
        await ask(t("dataManager.confirm.typeToConfirm", { id: domain.id }), {
          title: t("dataManager.confirm.title"),
          kind: "warning",
        })
        return
      }
      const ok = await ask(t("dataManager.confirm.moveToTrash", { name: t(domain.labelKey) }), {
        title: t("dataManager.confirm.title"),
        kind: "warning",
      })
      if (!ok) return
      setBusyId(domain.id)
      try {
        await moveDomainToTrash(projectPath, domain, newStamp())
        setConfirmText("")
        await refresh()
      } finally {
        setBusyId(null)
      }
    },
    [projectPath, confirmText, refresh, t],
  )

  const doResetAll = useCallback(async () => {
    if (!projectPath) return
    if (confirmText.trim() !== "RESET") {
      await ask(t("dataManager.confirm.typeReset"), {
        title: t("dataManager.confirm.title"),
        kind: "warning",
      })
      return
    }
    const ok = await ask(t("dataManager.confirm.resetAll"), {
      title: t("dataManager.confirm.title"),
      kind: "warning",
    })
    if (!ok) return
    setBusyId("__all__")
    try {
      await moveAllToTrash(projectPath, newStamp())
      setConfirmText("")
      await refresh()
    } finally {
      setBusyId(null)
    }
  }, [projectPath, confirmText, refresh, t])

  const doPurge = useCallback(
    async (stamp: string) => {
      const ok = await ask(t("dataManager.confirm.purge"), {
        title: t("dataManager.confirm.title"),
        kind: "warning",
      })
      if (!ok || !projectPath) return
      setBusyId(`purge:${stamp}`)
      try {
        await purgeTrashStamp(projectPath, stamp)
        await refresh()
      } finally {
        setBusyId(null)
      }
    },
    [projectPath, refresh, t],
  )

  const doRestore = useCallback(
    async (stamp: string, domainId: string) => {
      const domain = DATA_DOMAINS.find((d) => d.id === domainId)
      if (!domain || !projectPath) return
      setBusyId(`restore:${stamp}:${domainId}`)
      try {
        await restoreDomainFromTrash(projectPath, domain, stamp)
        await refresh()
      } finally {
        setBusyId(null)
      }
    },
    [projectPath, refresh],
  )

  if (!projectPath) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("dataManager.noProject")}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6" data-testid="data-manager-view">
      {/* 头部：总占用 + 刷新 + 整项目重置 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Database className="h-5 w-5 text-muted-foreground" />
          <div>
            <h2 className="text-base font-semibold">{t("dataManager.title")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("dataManager.total", { size: formatBytes(totalBytes) })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-1">{t("dataManager.refresh")}</span>
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void doResetAll()}
            disabled={busyId !== null}
          >
            {busyId === "__all__" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eraser className="h-4 w-4" />}
            <span className="ml-1">{t("dataManager.resetAll")}</span>
          </Button>
        </div>
      </div>

      {/* 确认输入：用户域需输入 id，整项目重置需输入 RESET */}
      <div className="flex items-center gap-2 rounded-md border border-dashed p-3">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
        <p className="flex-1 text-xs text-muted-foreground">{t("dataManager.confirmHint")}</p>
        <Input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={t("dataManager.confirmPlaceholder")}
          className="h-8 w-44"
          data-testid="data-manager-confirm-input"
        />
      </div>

      {/* 数据域列表 */}
      <div className="grid gap-3">
        {DATA_DOMAINS.map((domain) => {
          const s = stats[domain.id]
          const busy = busyId === domain.id
          return (
            <div
              key={domain.id}
              className="flex items-center justify-between rounded-lg border p-4"
              data-testid={`data-domain-${domain.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{t(domain.labelKey)}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${RISK_BADGE[domain.risk]}`}>
                    {t(`dataManager.risk.${domain.risk}`)}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{t(domain.descKey)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {s
                    ? t("dataManager.stat", {
                        size: formatBytes(s.totalBytes),
                        count: s.presentPaths,
                      })
                    : "…"}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="ml-3 shrink-0"
                onClick={() => void doClearDomain(domain)}
                disabled={busyId !== null || !s || s.presentPaths === 0}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                <span className="ml-1">{t("dataManager.clear")}</span>
              </Button>
            </div>
          )
        })}
      </div>

      {/* 回收站 */}
      <div className="mt-2">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <ArchiveRestore className="h-4 w-4" />
          {t("dataManager.trash.title")}
        </h3>
        {trash.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("dataManager.trash.empty")}</p>
        ) : (
          <div className="grid gap-2">
            {trash.map((entry) => (
              <div key={entry.stamp} className="rounded-lg border border-dashed p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-muted-foreground">{entry.stamp}</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void doPurge(entry.stamp)}
                    disabled={busyId !== null}
                  >
                    {busyId === `purge:${entry.stamp}` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    <span className="ml-1">{t("dataManager.trash.purge")}</span>
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {entry.domainIds.map((id) => (
                    <Button
                      key={id}
                      variant="secondary"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => void doRestore(entry.stamp, id)}
                      disabled={busyId !== null}
                    >
                      <ArchiveRestore className="mr-1 h-3 w-3" />
                      {t(`dataManager.domain.${camelDomainKey(id)}`, id)}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
