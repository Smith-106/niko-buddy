// 云端备份面板 —— F-004（TASK-007 配置 / 连接测试 + TASK-008 推送 / 拉取 / 冲突裁决）。
//
// 边界（写在这里以免后人误改）：
//   - 所有判定都由 Rust 侧 `commands/sync_target.rs` 做；本组件只收集输入、展示结果。
//   - 拉取是**显式确认**的恢复动作，结果表现为快照入库——UI 文案明确说「恢复为快照」，
//     不能让人以为工作文件树会被替换。
//   - 冲突是**终止态**：默认裁决恒为「保留两者」，不存在静默覆盖的按钮。
//   - 对外文案用「云端备份」而非「同步」（与既有持续性文件通道区分）。

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  cloudBackupStatus,
  configureCloudBackup,
  listCloudConflicts,
  pullCloudBackup,
  pushCloudBackup,
  summarizeConflict,
  testCloudBackup,
  validateSyncConfig,
  type SyncConfig,
  type SyncConflict,
  type SyncStatus,
  type SyncTestResult,
} from "@/lib/novel"

export interface CloudBackupPanelProps {
  /** 项目根路径（Rust 命令首参）。 */
  projectPath: string
  /** 本机标识（冲突副本命名用）。 */
  deviceId: string
}

const EMPTY_CONFIG: SyncConfig = {
  endpoint: "",
  root: "",
  credentialRef: "",
  enabled: false,
}

export function CloudBackupPanel({ projectPath, deviceId }: CloudBackupPanelProps) {
  const { t } = useTranslation()

  const [config, setConfig] = useState<SyncConfig>(EMPTY_CONFIG)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [test, setTest] = useState<SyncTestResult | null>(null)
  const [conflicts, setConflicts] = useState<SyncConflict[]>([])
  const [artifactPath, setArtifactPath] = useState("")
  const [manifestId, setManifestId] = useState("")
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  /**
   * 代数计数器：项目切换时旧响应不得覆盖新状态。
   * 旧实现在 `refresh` 里直接 setState，projectPath 切换后旧请求回包会把
   * 上一个项目的 config/conflicts 写回界面。
   */
  const refreshRunRef = useRef(0)

  const refresh = useCallback(async () => {
    const runId = ++refreshRunRef.current
    try {
      const next = await cloudBackupStatus(projectPath)
      const nextConflicts = await listCloudConflicts(projectPath)
      if (runId !== refreshRunRef.current) return
      setStatus(next)
      setConfig({
        endpoint: next.endpoint,
        root: next.root,
        credentialRef: next.credentialRef,
        enabled: next.enabled,
      })
      setConflicts(nextConflicts)
      setError("")
    } catch (reason) {
      if (runId !== refreshRunRef.current) return
      // 原始错误串是英文诊断；用户可见部分在 UI 层拼本地化引导。
      setError(`${t("backup.cloud.errorLead", "云备份操作失败")}：${String(reason)}`)
    }
  }, [projectPath])

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
      setError(`${t("backup.cloud.errorLead", "云备份操作失败")}：${String(reason)}`)
    } finally {
      setBusy(false)
    }
  }, [])

  const configReasons = validateSyncConfig(config)
  const configValid = configReasons.length === 0

  return (
    <section className="flex flex-col gap-4" data-testid="cloud-backup-panel">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">{t("backup.cloud.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("backup.cloud.subtitle")}</p>
      </header>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {t("backup.cloud.endpoint")}
          <Input
            value={config.endpoint}
            onChange={(event) => setConfig({ ...config, endpoint: event.target.value })}
            placeholder="https://dav.example.com"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("backup.cloud.root")}
          <Input
            value={config.root}
            onChange={(event) => setConfig({ ...config, root: event.target.value })}
            placeholder="niko-buddy/backups"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("backup.cloud.credentialRef")}
          <Input
            value={config.credentialRef}
            onChange={(event) => setConfig({ ...config, credentialRef: event.target.value })}
            placeholder="nb:webdav:project"
          />
          <span className="text-xs text-muted-foreground">{t("backup.cloud.credentialHint")}</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => setConfig({ ...config, enabled: event.target.checked })}
          />
          {t("backup.cloud.enabled")}
        </label>
      </div>

      {status !== null && !status.credentialAvailable && (
        <p className="text-sm text-destructive">{t("backup.cloud.credentialUnavailable")}</p>
      )}
      {configReasons.length > 0 && (
        <ul className="text-xs text-destructive">
          {configReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !configValid}
          onClick={() =>
            run(async () => {
              await configureCloudBackup(projectPath, config)
              await refresh()
              return t("backup.cloud.saved")
            })
          }
        >
          {t("backup.cloud.save")}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !status?.configured}
          onClick={() =>
            run(async () => {
              const result = await testCloudBackup(projectPath)
              setTest(result)
              return result.message
            })
          }
        >
          {t("backup.cloud.test")}
        </Button>
      </div>

      {test !== null && (
        <p className="text-sm">
          {test.ok ? t("backup.cloud.testOk") : t("backup.cloud.testFailed")} — {test.message}
        </p>
      )}

      <div className="flex flex-col gap-2 border-t pt-4">
        <label className="flex flex-col gap-1 text-sm">
          {t("backup.cloud.artifactPath")}
          <Input value={artifactPath} onChange={(event) => setArtifactPath(event.target.value)} />
        </label>
        <Button
          disabled={busy || artifactPath.length === 0 || !status?.enabled}
          onClick={() =>
            run(async () => {
              const result = await pushCloudBackup(projectPath, artifactPath, deviceId)
              await refresh()
              return t("backup.cloud.pushDone", {
                revision: result.revision,
                blocks: result.blockCount,
              })
            })
          }
        >
          {t("backup.cloud.push")}
        </Button>

        <label className="flex flex-col gap-1 text-sm">
          {t("backup.cloud.manifestId")}
          <Input value={manifestId} onChange={(event) => setManifestId(event.target.value)} />
        </label>
        <Button
          variant="outline"
          disabled={busy || manifestId.length === 0 || !status?.enabled}
          onClick={() =>
            run(async () => {
              const result = await pullCloudBackup(projectPath, manifestId, deviceId)
              await refresh()
              return `${t(`backup.cloud.decision.${result.decision}`)} — ${result.message}`
            })
          }
        >
          {t("backup.cloud.pull")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("backup.cloud.pullHint")}</span>
      </div>

      <div className="flex flex-col gap-2 border-t pt-4">
        <h3 className="text-sm font-medium">{t("backup.cloud.conflicts")}</h3>
        {conflicts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("backup.cloud.noConflicts")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {conflicts.map((conflict) => (
              <li key={conflict.name} className="rounded border p-2 text-sm">
                <div className="font-mono text-xs">{summarizeConflict(conflict)}</div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="radio" readOnly checked name={`resolution-${conflict.name}`} />
                  {t("backup.cloud.keepBoth")}
                  <span aria-hidden="true">·</span>
                  {t("backup.cloud.conflictTerminal")}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {status !== null && (
        <footer className="text-xs text-muted-foreground">
          {t("backup.cloud.journalEntries", { n: status.journalEntries })}
          {status.lastDirection !== undefined && status.lastRevision !== undefined && (
            <> · {t("backup.cloud.lastTransfer", { direction: status.lastDirection, revision: status.lastRevision })}</>
          )}
        </footer>
      )}

      {notice.length > 0 && <p className="text-sm">{notice}</p>}
      {error.length > 0 && <p className="text-sm text-destructive">{error}</p>}
    </section>
  )
}
