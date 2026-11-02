// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

/**
 * 同步设置区（G2a B5）：全局开关 + 间隔三档 + 手动同步。
 *
 * 边界：
 *   - 所有判定都在 Rust 侧（`commands/sync_target.rs` / `commands/sync_scheduler.rs`）；
 *     本组件只收集输入、展示结果，不复制任何校验规则。
 *   - `enabled` 是**全局**同步开关（`sync_enabled`）：关闭时调度器与一切自动触发全停，
 *     因此这里同时负责「保存开关」与「启停调度器」两件事。
 *   - 「立即同步」复用 `runSyncNow`（= `sync_now` 命令 = 后台调度同一条 `run_cycle`），
 *     不存在手动 / 自动两套判定。
 *   - 非 Tauri 运行时（浏览器预览 / 单测）安静降级：不触发 IPC、不抛错。
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  DEFAULT_SYNC_ENABLED,
  SYNC_SCHEDULE_INTERVALS,
  cloudBackupStatus,
  configureCloudBackup,
  isSyncScheduleInterval,
  readCloudBackupConfig,
  readSyncSchedulerStatus,
  runSyncNow,
  startSyncScheduler,
  stopSyncScheduler,
  type SyncConfig,
  type SyncConfigFile,
  type SyncScheduleIntervalMinutes,
  type SyncSchedulerStatus,
} from "@/lib/novel"
import { isTauri } from "@/lib/platform"
import { getDeviceId } from "@/lib/device-id"
import { useWikiStore } from "@/stores/wiki-store"

export interface SyncSettingsSectionProps {
  /** 项目根路径覆盖（缺省取当前打开项目）。 */
  projectPath?: string
}

/** 落盘配置 → 面板可编辑的域模型（开关 / 间隔的写回都基于它）。 */
function toSyncConfig(file: SyncConfigFile): SyncConfig {
  return {
    endpoint: file.endpoint,
    root: file.root,
    credentialRef: file.credentialRef,
    enabled: file.enabled,
    localPath: file.localPath,
    github: file.github,
    schedule: file.schedule,
  }
}

/** RFC3339 → 本地可读串；缺失 → null（界面走「尚未同步」文案）。 */
function formatTimestamp(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

export function SyncSettingsSection({ projectPath }: SyncSettingsSectionProps = {}) {
  const { t } = useTranslation()
  const currentProject = useWikiStore((s) => s.project)
  const resolvedProjectPath = projectPath ?? currentProject?.path ?? ""

  /** 全局开关（`sync_enabled`）：只有显式 true 才算开启（读不出来 = 关闭）。 */
  const [enabled, setEnabled] = useState(DEFAULT_SYNC_ENABLED)
  const [intervalMinutes, setIntervalMinutes] =
    useState<SyncScheduleIntervalMinutes>(SYNC_SCHEDULE_INTERVALS[0])
  const [scheduler, setScheduler] = useState<SyncSchedulerStatus | null>(null)
  const [configured, setConfigured] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")

  const refresh = useCallback(async () => {
    if (!isTauri() || resolvedProjectPath.length === 0) return
    try {
      const status = await cloudBackupStatus(resolvedProjectPath)
      setConfigured(status.configured)
      setEnabled(status.enabled === true)
      const file = await readCloudBackupConfig(resolvedProjectPath).catch(() => null)
      const configuredInterval = file?.schedule?.intervalMinutes
      if (configuredInterval !== undefined && isSyncScheduleInterval(configuredInterval)) {
        setIntervalMinutes(configuredInterval)
      }
      const next = await readSyncSchedulerStatus().catch(() => null)
      setScheduler(next)
      setError("")
    } catch (reason) {
      setError(`${t("sync.errorLead")}：${String(reason)}`)
    }
  }, [resolvedProjectPath, t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = useCallback(async (action: () => Promise<string>) => {
    setBusy(true)
    setNotice("")
    setError("")
    try {
      setNotice(await action())
    } catch (reason) {
      setError(`${t("sync.errorLead")}：${String(reason)}`)
    } finally {
      setBusy(false)
    }
  }, [t])

  /**
   * 保存开关并同步启停调度器。
   *
   * 两件事必须一起做，否则界面与实际脱节：
   *   1. 把 `enabled` 写回落盘配置（全局开关，其它字段原样保留）；
   *   2. 开启 → 按当前档启动调度器；关闭 → 立刻停机（不等下一档）。
   * 调度器启动在 Rust 侧还有一道显式门禁（开关关闭时直接拒绝启动），
   * 所以「界面状态」与「调度器实际状态」不可能长期不一致。
   */
  const applyEnabled = useCallback(
    (nextEnabled: boolean) =>
      run(async () => {
        setEnabled(nextEnabled)
        if (!isTauri() || resolvedProjectPath.length === 0) return t("sync.saved")
        const file = await readCloudBackupConfig(resolvedProjectPath)
        if (file === null) return t("sync.notConfigured")
        await configureCloudBackup(resolvedProjectPath, {
          ...toSyncConfig(file),
          enabled: nextEnabled,
        })
        if (!nextEnabled) {
          await stopSyncScheduler().catch(() => null)
          setScheduler(await readSyncSchedulerStatus().catch(() => null))
          return t("sync.disabledNotice")
        }
        const status = await startSyncScheduler(
          resolvedProjectPath,
          getDeviceId(),
          intervalMinutes,
        )
        setEnabled(status.syncEnabled)
        setScheduler(status)
        return t("sync.schedule.started")
      }),
    [run, resolvedProjectPath, intervalMinutes, t],
  )

  /** 切换间隔档：先落盘（否则重启后丢档），调度器在跑则按新档重启。 */
  const applyInterval = useCallback(
    (next: SyncScheduleIntervalMinutes) =>
      run(async () => {
        setIntervalMinutes(next)
        if (!isTauri() || resolvedProjectPath.length === 0) return t("sync.saved")
        const file = await readCloudBackupConfig(resolvedProjectPath)
        if (file === null) return t("sync.notConfigured")
        await configureCloudBackup(resolvedProjectPath, {
          ...toSyncConfig(file),
          schedule: { intervalMinutes: next },
        })
        if (scheduler?.running !== true) return t("sync.schedule.intervalSaved")
        const status = await startSyncScheduler(resolvedProjectPath, getDeviceId(), next)
        setScheduler(status)
        return t("sync.schedule.restarted", { minutes: next })
      }),
    [run, resolvedProjectPath, scheduler?.running, t],
  )

  /** 手动同步：与后台调度同一条 `run_cycle`。 */
  const syncNow = useCallback(
    () =>
      run(async () => {
        if (!isTauri() || resolvedProjectPath.length === 0) return t("sync.saved")
        const result = await runSyncNow(resolvedProjectPath, getDeviceId())
        await refresh()
        if (!result.ran) {
          return t("sync.nowSkipped", { reason: result.skipReason ?? "unknown" })
        }
        return t("sync.nowDone", { revision: result.revision, decision: result.decision })
      }),
    [run, resolvedProjectPath, refresh, t],
  )

  const lastRunLabel = formatTimestamp(scheduler?.lastRunAt)
  const nextRunLabel = formatTimestamp(scheduler?.nextRunAt)

  return (
    <section className="flex flex-col gap-3" data-testid="sync-settings-section">
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{t("sync.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("sync.subtitle")}</p>
      </header>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => void applyEnabled(event.target.checked)}
        />
        <span className="flex flex-col gap-1">
          {t("sync.enabled")}
          <span className="text-xs text-muted-foreground">{t("sync.enabledHint")}</span>
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t("sync.schedule.interval")}
        <select
          className="h-9 w-48 rounded-md border bg-background px-2 text-sm"
          value={intervalMinutes}
          disabled={busy}
          onChange={(event) => {
            const next = Number(event.target.value)
            if (isSyncScheduleInterval(next)) void applyInterval(next)
          }}
        >
          {SYNC_SCHEDULE_INTERVALS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {t("sync.schedule.minutes", { minutes })}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">{t("sync.schedule.intervalHint")}</span>
      </label>

      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground" data-testid="sync-schedule-status">
        <span>
          {t("sync.schedule.state")}：{t(scheduler?.running === true ? "sync.schedule.running" : "sync.schedule.stopped")}
        </span>
        <span>
          {t("sync.schedule.last")}：{lastRunLabel ?? t("sync.schedule.never")}
        </span>
        <span>
          {t("sync.schedule.next")}：{nextRunLabel ?? t("sync.schedule.notScheduled")}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={busy || !configured || !enabled} onClick={() => void syncNow()}>
          {t("sync.now")}
        </Button>
        {!configured && <span className="text-xs text-muted-foreground">{t("sync.notConfigured")}</span>}
      </div>

      {notice.length > 0 && <p className="text-sm">{notice}</p>}
      {error.length > 0 && <p className="text-sm text-destructive">{error}</p>}
    </section>
  )
}

export default SyncSettingsSection
