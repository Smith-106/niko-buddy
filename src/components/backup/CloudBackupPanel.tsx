// 云端备份面板 —— F-004（TASK-007 配置 / 连接测试 + TASK-008 推送 / 拉取 / 冲突裁决）
// + G2a（本地文件夹配对 / 全局开关 / 立即同步 / 上次与下次时间）。
//
// 边界（写在这里以免后人误改）：
//   - 所有判定都由 Rust 侧 `commands/sync_target.rs` 做；本组件只收集输入、展示结果。
//   - 拉取是**显式确认**的恢复动作，结果表现为快照入库——UI 文案明确说「恢复为快照」，
//     不能让人以为工作文件树会被替换。
//   - 冲突是**终止态**：默认裁决恒为「保留两者」，不存在静默覆盖的按钮。
//   - 对外文案用「云端备份」而非「同步」（与既有持续性文件通道区分）。
//   - G2a：传输目标选择器扩到 本地文件夹 / GitHub / WebDAV。**本地目标隐藏整段凭据链**
//     （本地文件夹不需要凭据，Rust 侧配置期也要求 credential_ref 为空串）。
//   - G2a：`enabled` 是**全局**开关，不是单目标启用位；关闭时调度器与一切自动触发全停。
//   - WebDAV 链路零改动：端点 / 前缀 / 凭据 / 推送 / 拉取 / 冲突的字段与文案原样保留。

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { StatusChip } from "@/components/ui/status-visuals"
import {
  cloudBackupStatus,
  configureCloudBackup,
  listCloudConflicts,
  pullCloudBackup,
  pushCloudBackup,
  readCloudBackupConfig,
  readSyncSchedulerStatus,
  runSyncNow,
  startSyncScheduler,
  stopSyncScheduler,
  summarizeConflict,
  testCloudBackup,
  validateSyncConfig,
  type SyncConfig,
  type SyncConfigFile,
  type SyncConflict,
  type SyncSchedulerStatus,
  type SyncStatus,
  type SyncTestResult,
} from "@/lib/novel"
import {
  GITHUB_SYNC_ENDPOINT,
  LOCAL_SYNC_ENDPOINT,
  PICK_KEEP_BOTH,
  applyPerItemDecisionCommand,
  syncBatchesCommand,
  syncTargetKind,
  type RawSyncBatch,
  type RawSyncItemDecisionRequest,
  type SyncPickChoice,
  type SyncTargetKind,
} from "@/commands/sync"
import {
  GITHUB_SECRET_DOMAIN,
  isGitHubCredentialRef,
  parseCredentialRef,
  resolveCredentialTarget,
  resolveCredentialTargetForDomain,
  secretAvailable,
  secretDelete,
  secretPut,
} from "@/lib/secret-client"

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
  localPath: "",
}

/**
 * 可选增强读取：`lib` 未被注入（测试替身 / 降级形态）时安静退化为 `null`。
 *
 * 为什么需要它：完整配置与调度器状态都是**增强信息**——读不到时面板仍要能用
 * `sync_status` 派生出的四字段工作（WebDAV 链路不因新能力缺席而失效）。
 */
async function optionalRead<T>(read: (() => Promise<T>) | undefined): Promise<T | null> {
  /* v8 ignore next -- 台账 CloudBackupPanel.tsx L86：optionalRead 的 typeof read !== "function" —— 全仓 3 个调用点（L171/190/193）一律传箭头函数字面量，从不传 undefined；该形参的 undefined 分支是签名允许但无调用方的死守卫 */
  if (typeof read !== "function") return null
  try {
    return await read()
  } catch {
    return null
  }
}

/** 可选增强副作用：失败不影响主流程（例如调度器启停失败不阻碍配置落盘）。 */
async function optionalCall(action: (() => Promise<unknown>) | undefined): Promise<void> {
  /* v8 ignore next -- 台账 CloudBackupPanel.tsx L96：optionalCall 同理 —— 唯一调用点 L620 传 async 箭头字面量 */
  if (typeof action !== "function") return
  try {
    await action()
  } catch {
    // 调度器启停是增强副作用：失败时由 `sync_scheduler_status` 反映真实状态。
  }
}

/** 传输目标选择器的三档（顺序即展示顺序：本地文件夹 → GitHub → WebDAV）。 */
const TARGET_OPTIONS: readonly { kind: SyncTargetKind; labelKey: string }[] = [
  { kind: LOCAL_SYNC_ENDPOINT, labelKey: "sync.target.local" },
  { kind: GITHUB_SYNC_ENDPOINT, labelKey: "sync.target.github" },
  { kind: "webdav", labelKey: "sync.target.webdav" },
]

/** 时间展示：RFC3339 → 本地可读串；缺失 → null（界面走「尚未同步」）。 */
function formatTimestamp(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

/** 逐项裁决草稿键（批次 + 文件路径；跨批次同名文件互不干扰）。 */
function pickKey(batchId: string, path: string): string {
  return `${batchId}::${path}`
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
  /** 传输目标类型（由 `endpoint` 反解；切换时改写 `endpoint` 字面量）。 */
  const [targetKind, setTargetKind] = useState<SyncTargetKind>("webdav")
  /** 调度器状态：上次 / 下次触发时间与上次结果（不可用时为 null）。 */
  const [scheduleStatus, setScheduleStatus] = useState<SyncSchedulerStatus | null>(null)
  /**
   * 一次性凭据输入：仅本次写入使用。成功后立即清空，失败也不回显——
   * secret 值不进入任何持久状态（C-011）。
   */
  const [secretDraft, setSecretDraft] = useState("")
  /** OS 凭据库可用性探针：null=探测中；false=禁用凭据控件并提示（禁止明文回退）。 */
  const [credentialStoreAvailable, setCredentialStoreAvailable] = useState<boolean | null>(null)
  /** G2b：批次记录（journal + manifest 聚合；不可用时为空数组，不影响主流程）。 */
  const [batches, setBatches] = useState<RawSyncBatch[]>([])
  /** 当前展开的批次（一次只展开一批：逐项列表很长，不铺满屏）。 */
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null)
  /**
   * 逐项裁决草稿：**只有用户显式选过才存在**。
   * 缺省即 Rust 侧默认裁决（恒为 keep_both），绝不在 UI 里预填覆盖。
   */
  const [pickDrafts, setPickDrafts] = useState<Record<string, SyncPickChoice>>({})
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
      // 完整配置（含 github / local / schedule 块）是增强信息：读不到就退化为
      // `sync_status` 派生值，WebDAV 链路不因新能力缺席而失效。
      const file: SyncConfigFile | null = await optionalRead(() =>
        readCloudBackupConfig(projectPath),
      )
      if (runId !== refreshRunRef.current) return
      setStatus(next)
      setConfig({
        endpoint: next.endpoint,
        root: next.root,
        credentialRef: next.credentialRef,
        enabled: next.enabled,
        localPath:
          file?.localPath ?? (next.endpoint === LOCAL_SYNC_ENDPOINT ? next.root : ""),
        github: file?.github,
        schedule: file?.schedule,
      })
      setTargetKind(syncTargetKind(next.endpoint))
      setConflicts(nextConflicts)
      setError("")
      // G2b：批次明细是增强信息（旧后端无此命令时安静退化为空列表）。
      const nextBatches = await optionalRead(() => syncBatchesCommand(projectPath))
      if (runId !== refreshRunRef.current) return
      setBatches(nextBatches ?? [])
      const scheduler = await optionalRead(() => readSyncSchedulerStatus())
      if (runId !== refreshRunRef.current) return
      setScheduleStatus(scheduler)
    } catch (reason) {
      if (runId !== refreshRunRef.current) return
      // 原始错误串是英文诊断；用户可见部分在 UI 层拼本地化引导。
      setError(`${t("backup.cloud.errorLead", "云备份操作失败")}：${String(reason)}`)
    }
  }, [projectPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 挂载时探测凭据库可用性：不可用则凭据控件禁用 + 明示提示，而非等写入失败。 */
  useEffect(() => {
    let cancelled = false
    void secretAvailable()
      .then((available) => {
        if (!cancelled) setCredentialStoreAvailable(available)
      })
      .catch(() => {
        if (!cancelled) setCredentialStoreAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

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

  // 凭据写入目标：**按传输目标域**解析，跨域旧引用不复用。
  // GitHub 目标的域恒为 `github`（`nb:github:<account>`）：首次配置时 credentialRef
  // 为空，若沿用 `resolveCredentialTarget` 的 webdav 回落，token 会被写进
  // `nb:webdav:...`，随后被 Rust 侧 `require_github_credential_ref` 拒收 ——
  // 「凭据已保存但配置永远存不下去」。
  // 非 GitHub 目标仍走 `resolveCredentialTarget`（保留自定义域引用的轮换语义），
  // 只把 GitHub 域的旧引用排除掉（它在 WebDAV 目标下同样会被硬门拒收）。
  const webdavCredentialRef = isGitHubCredentialRef(config.credentialRef) ? "" : config.credentialRef
  const credentialTarget = targetKind === GITHUB_SYNC_ENDPOINT
    ? resolveCredentialTargetForDomain(GITHUB_SECRET_DOMAIN, config.credentialRef, projectPath)
    : resolveCredentialTarget(webdavCredentialRef, projectPath)
  const parsedCredentialRef = parseCredentialRef(config.credentialRef)
  const secretControlsEnabled = credentialStoreAvailable === true
  /** 本地文件夹目标不需要凭据 → 整段凭据链隐藏（不是禁用）。 */
  const showCredentials = targetKind !== LOCAL_SYNC_ENDPOINT

  const saveCredential = useCallback(
    () =>
      run(async () => {
        // 值只作为本次 invoke 实参；成功后立刻清空草稿，界面只保留引用。
        const ref = await secretPut(credentialTarget.domain, credentialTarget.account, secretDraft)
        // 域守卫：Rust 返回的引用必须落在本次写入的域里。写错域时立刻报错（不是静默
        // 回填一个永远过不了配置期硬门的引用）。
        if (credentialTarget.domain === GITHUB_SECRET_DOMAIN && !isGitHubCredentialRef(ref)) {
          throw new Error(`credential_ref must start with nb:github: (got ${ref})`)
        }
        setSecretDraft("")
        setConfig((prev) => ({ ...prev, credentialRef: ref }))
        setCredentialStoreAvailable(true)
        return t("backup.cloud.credentialSaved", { ref })
      }),
    [run, credentialTarget.domain, credentialTarget.account, secretDraft, t],
  )

  const clearCredential = useCallback(
    () =>
      run(async () => {
        const parsed = parsedCredentialRef
        if (parsed === null) return t("backup.cloud.credentialClearNoRef")
        const removed = await secretDelete(parsed.domain, parsed.account)
        setSecretDraft("")
        setConfig((prev) => ({ ...prev, credentialRef: "" }))
        return removed ? t("backup.cloud.credentialCleared") : t("backup.cloud.credentialAbsent")
      }),
    [run, parsedCredentialRef, t],
  )

  /**
   * 切换传输目标：只改 `endpoint` 字面量，并清掉与目标不相容的字段。
   *
   * 本地目标必须清空 `credentialRef`（Rust 配置期硬门：本地目标不带凭据）；
   * 从本地切回远端时也不复用旧的本地路径。**跨域引用一律清掉**：`nb:webdav:*`
   * 在 GitHub 目标下会被配置期硬门拒收，`nb:github:*` 在 WebDAV 目标下同理 ——
   * 保留它只会让用户卡在「引用存在但配置存不下去」。
   */
  const changeTargetKind = useCallback((kind: SyncTargetKind) => {
    setTargetKind(kind)
    setTest(null)
    setConfig((prev) => {
      if (kind === LOCAL_SYNC_ENDPOINT) {
        return { ...prev, endpoint: LOCAL_SYNC_ENDPOINT, credentialRef: "", root: "" }
      }
      if (kind === GITHUB_SYNC_ENDPOINT) {
        return {
          ...prev,
          endpoint: GITHUB_SYNC_ENDPOINT,
          root: "",
          localPath: "",
          // 非 GitHub 域的旧引用不复用（否则 token 会写进错误域）。
          credentialRef: isGitHubCredentialRef(prev.credentialRef) ? prev.credentialRef : "",
          github: prev.github ?? { owner: "", repo: "", branch: "main", pathPrefix: "" },
        }
      }
      return {
        ...prev,
        endpoint: prev.endpoint === LOCAL_SYNC_ENDPOINT || prev.endpoint === GITHUB_SYNC_ENDPOINT
          ? ""
          : prev.endpoint,
        localPath: "",
        // GitHub 域的旧引用在 WebDAV 目标下同样无效。
        credentialRef: isGitHubCredentialRef(prev.credentialRef) ? "" : prev.credentialRef,
      }
    })
  }, [])

  /** 选本地文件夹（Tauri 目录选择器；非 Tauri 运行时安静退化为手填）。 */
  const pickLocalFolder = useCallback(() => {
    void (async () => {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog")
        const picked = await open({ directory: true, multiple: false })
        if (typeof picked === "string" && picked.length > 0) {
          setConfig((prev) => ({ ...prev, localPath: picked }))
        }
      } catch {
        // 浏览器预览 / 单测环境无目录选择器 → 保留手填输入，不报错。
      }
    })()
  }, [])

  /**
   * 「立即同步」：与后台调度**同一条** Rust 路径（`sync_scheduler::run_cycle`）。
   * `ran === false` 不是异常——按 `skipReason` 展示原因（开关关闭 / 无产物 …）。
   */
  const syncNow = useCallback(
    () =>
      run(async () => {
        const result = await runSyncNow(projectPath, deviceId)
        await refresh()
        if (!result.ran) {
          return t("sync.nowSkipped", { reason: result.skipReason ?? "unknown" })
        }
        return t("sync.nowDone", { revision: result.revision, decision: result.decision })
      }),
    [run, projectPath, deviceId, refresh, t],
  )

  const configReasons = validateSyncConfig(config)
  const configValid = configReasons.length === 0
  const lastRunLabel = formatTimestamp(scheduleStatus?.lastRunAt)
  const nextRunLabel = formatTimestamp(scheduleStatus?.nextRunAt)

  /**
   * 逐项裁决落盘（G2b）：只提交**可逐项选择**的项，缺省值恒为 keep_both。
   *
   * `actor` 传本机标识：Rust 侧空 actor 直接拒绝（逐项选择必须是显式用户动作）。
   * 单项失败不回滚其他项，结果按失败数分流文案。
   */
  const applyPicks = useCallback(
    (batch: RawSyncBatch) =>
      run(async () => {
        const items: RawSyncItemDecisionRequest[] = batch.items
          .filter((item) => item.pickable)
          .map((item) => ({
            path: item.path,
            decision: pickDrafts[pickKey(batch.batch_id, item.path)] ?? PICK_KEEP_BOTH,
          }))
        const results = await applyPerItemDecisionCommand(projectPath, batch, deviceId, items)
        setPickDrafts({})
        await refresh()
        const failed = results.filter((result) => result.status === "error").length
        return failed === 0
          ? t("sync.batch.applied", { n: results.length })
          : t("sync.batch.partial", { n: failed })
      }),
    [run, pickDrafts, projectPath, deviceId, refresh, t],
  )

  return (
    <section className="flex flex-col gap-4" data-testid="cloud-backup-panel">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">{t("backup.cloud.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("backup.cloud.subtitle")}</p>
        <div className="flex flex-wrap items-center gap-2" data-testid="cloud-backup-status-rail">
          {status !== null && !status.credentialAvailable && showCredentials ? (
            <StatusChip label={t("backup.cloud.credentialUnavailable")} tone="danger" />
          ) : configReasons[0] !== undefined ? (
            <StatusChip label={configReasons[0]} tone="warning" />
          ) : null}
          <StatusChip
            label={t(conflicts.length > 0 ? "backup.cloud.conflicts" : "backup.cloud.noConflicts")}
            tone={conflicts.length > 0 ? "warning" : "neutral"}
          />
        </div>
      </header>

      {/* 传输目标选择器（G2a）：本地文件夹 / GitHub / WebDAV。 */}
      <label className="flex flex-col gap-1 text-sm" data-testid="cloud-backup-target">
        {t("sync.target.label")}
        <select
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={targetKind}
          disabled={busy}
          onChange={(event) => changeTargetKind(event.target.value as SyncTargetKind)}
        >
          {TARGET_OPTIONS.map((option) => (
            <option key={option.kind} value={option.kind}>
              {t(option.labelKey)}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">{t("sync.target.hint")}</span>
      </label>

      <div className="grid grid-cols-2 gap-3">
        {targetKind === "webdav" && (
          <>
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
          </>
        )}

        {targetKind === GITHUB_SYNC_ENDPOINT && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              {t("sync.github.owner")}
              <Input
                value={config.github?.owner ?? ""}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    github: {
                      owner: event.target.value,
                      repo: config.github?.repo ?? "",
                      branch: config.github?.branch ?? "main",
                      pathPrefix: config.github?.pathPrefix ?? "",
                    },
                  })
                }
                placeholder="niko"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("sync.github.repo")}
              <Input
                value={config.github?.repo ?? ""}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    github: {
                      owner: config.github?.owner ?? "",
                      repo: event.target.value,
                      branch: config.github?.branch ?? "main",
                      pathPrefix: config.github?.pathPrefix ?? "",
                    },
                  })
                }
                placeholder="novel-backups"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("sync.github.branch")}
              <Input
                value={config.github?.branch ?? "main"}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    github: {
                      owner: config.github?.owner ?? "",
                      repo: config.github?.repo ?? "",
                      branch: event.target.value,
                      pathPrefix: config.github?.pathPrefix ?? "",
                    },
                  })
                }
                placeholder="main"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("sync.github.pathPrefix")}
              <Input
                value={config.github?.pathPrefix ?? ""}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    github: {
                      owner: config.github?.owner ?? "",
                      repo: config.github?.repo ?? "",
                      branch: config.github?.branch ?? "main",
                      pathPrefix: event.target.value,
                    },
                  })
                }
                placeholder="backups/qmai"
              />
            </label>
          </>
        )}

        {targetKind === LOCAL_SYNC_ENDPOINT && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              {t("sync.localPath")}
              <Input
                value={config.localPath ?? ""}
                onChange={(event) => setConfig({ ...config, localPath: event.target.value })}
                placeholder="D:/NovelBackups/qmai"
              />
              <span className="text-xs text-muted-foreground">{t("sync.localPathHint")}</span>
            </label>
            <div className="flex items-end">
              <Button variant="outline" disabled={busy} onClick={pickLocalFolder}>
                {t("sync.localPick")}
              </Button>
            </div>
            <p className="col-span-2 text-xs text-muted-foreground">{t("sync.localNoCredential")}</p>
          </>
        )}

        <label className="col-span-2 flex flex-col gap-1 text-sm">
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => setConfig({ ...config, enabled: event.target.checked })}
            />
            {t("sync.enabled")}
          </span>
          <span className="text-xs text-muted-foreground">{t("sync.enabledHint")}</span>
        </label>
      </div>

      {status !== null && !status.credentialAvailable && showCredentials && (
        <p className="text-sm text-destructive">{t("backup.cloud.credentialUnavailable")}</p>
      )}
      {configReasons.length > 0 && (
        <ul className="text-xs text-destructive">
          {configReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      {/* 凭据链（B3）：一次性输入 → secret_put → 回填 credentialRef；不可用时禁用。
          G2a：本地文件夹目标不需要凭据 → 整段隐藏（Rust 配置期也要求引用为空串）。 */}
      {showCredentials && (
        <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="cloud-backup-credentials">
          <div className="text-sm font-medium">{t("backup.cloud.credentialStore")}</div>
          {credentialStoreAvailable === false && (
            <p className="text-xs text-destructive">{t("backup.cloud.credentialStoreDisabled")}</p>
          )}
          <label className="flex flex-col gap-1 text-sm">
            {t("backup.cloud.credentialRef")}
            <Input
              value={config.credentialRef}
              onChange={(event) => setConfig({ ...config, credentialRef: event.target.value })}
              placeholder={
                targetKind === GITHUB_SYNC_ENDPOINT ? "nb:github:account" : "nb:webdav:project"
              }
            />
            <span className="text-xs text-muted-foreground">{t("backup.cloud.credentialHint")}</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("backup.cloud.credentialValue")}
            <Input
              type="password"
              value={secretDraft}
              disabled={!secretControlsEnabled || busy}
              onChange={(event) => setSecretDraft(event.target.value)}
              placeholder="user:password"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={!secretControlsEnabled || busy || secretDraft.trim().length === 0}
              onClick={() => void saveCredential()}
            >
              {t("backup.cloud.credentialSave")}
            </Button>
            {parsedCredentialRef !== null && (
              <Button
                variant="outline"
                disabled={!secretControlsEnabled || busy}
                onClick={() => void clearCredential()}
              >
                {t("backup.cloud.credentialClear")}
              </Button>
            )}
          </div>
          <span className="text-xs text-muted-foreground">{t("backup.cloud.credentialValueHint")}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !configValid}
          onClick={() =>
            run(async () => {
              await configureCloudBackup(projectPath, config)
              // 全局开关的两件事必须一起做：落盘配置 + 启停后台调度器。
              await optionalCall(async () =>
                config.enabled
                  ? startSyncScheduler(projectPath, deviceId, config.schedule?.intervalMinutes)
                  : stopSyncScheduler(),
              )
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
        {/* G2a：立即同步（与后台调度同一条 Rust 路径）。 */}
        <Button
          variant="outline"
          disabled={busy || !status?.enabled}
          onClick={() => void syncNow()}
        >
          {t("sync.now")}
        </Button>
      </div>

      {test !== null && (
        <p className="text-sm">
          {test.ok ? t("backup.cloud.testOk") : t("backup.cloud.testFailed")} — {test.message}
        </p>
      )}

      {/* G2a：上次 / 下次触发时间（调度器状态不可用时安静省略）。 */}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground" data-testid="cloud-backup-schedule">
        <span>
          {t("sync.schedule.last")}：
          {lastRunLabel ?? t("sync.schedule.never")}
        </span>
        <span>
          {t("sync.schedule.next")}：
          {nextRunLabel ?? t("sync.schedule.notScheduled")}
        </span>
        {scheduleStatus?.lastOutcome !== undefined && (
          <span>{t("sync.schedule.lastOutcome", { outcome: scheduleStatus.lastOutcome })}</span>
        )}
      </div>

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

      {/* G2b：批次记录区。按 journal + manifest 逐批次展示每一项结果（文件/方向/状态/耗时/错误）；
          双改文件行展开逐项三选一；无 base 的批次置灰并明说只能「保留两者」（R2 缓解）。 */}
      <div className="flex flex-col gap-2 border-t pt-4" data-testid="cloud-backup-batches">
        <h3 className="text-sm font-medium">{t("sync.batch.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("sync.batch.subtitle")}</p>
        {batches.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("sync.batch.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {batches.map((batch) => {
              const expanded = expandedBatch === batch.batch_id
              const pickable = batch.items.filter((item) => item.pickable)
              return (
                <li
                  key={batch.batch_id}
                  className="rounded border p-2 text-sm"
                  data-testid={`sync-batch-${batch.batch_id}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">
                      {t("sync.batch.row", {
                        manifest: batch.manifest_id,
                        revision: batch.revision,
                        direction: batch.direction,
                        status: t(`sync.batch.status.${batch.status}`, { defaultValue: batch.status }),
                      })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("sync.batch.items", { n: batch.items.length })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("sync.batch.duration", { ms: batch.duration_ms })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {batch.base_rev === undefined
                        ? t("sync.batch.baseMissing")
                        : t("sync.batch.base", { rev: batch.base_rev })}
                    </span>
                    <Button
                      variant="outline"
                      onClick={() => setExpandedBatch(expanded ? null : batch.batch_id)}
                    >
                      {expanded ? t("sync.batch.collapse") : t("sync.batch.expand")}
                    </Button>
                  </div>
                  {/* 无 base 置灰文案：老批次不迁移、不重写，逐项只能保留两者。 */}
                  {!batch.base_available && (
                    <p
                      className="mt-1 text-xs text-muted-foreground"
                      data-testid="sync-batch-no-base"
                    >
                      {t("sync.batch.noBase")}
                    </p>
                  )}
                  {batch.error !== undefined && (
                    <p className="mt-1 text-xs text-destructive">{batch.error}</p>
                  )}
                  {expanded && (
                    <div className="mt-2 flex flex-col gap-2">
                      <ul className="flex flex-col gap-1">
                        {batch.items.map((item) => {
                          const draft = pickDrafts[pickKey(batch.batch_id, item.path)]
                          return (
                            <li
                              key={item.path}
                              className="flex flex-wrap items-center gap-2 text-xs"
                              data-testid={`sync-batch-item-${item.path}`}
                            >
                              <span className="font-mono">{item.path}</span>
                              <span className="text-muted-foreground">{item.direction}</span>
                              <span>
                                {t(`sync.batch.diff.${item.status}`, { defaultValue: item.status })}
                              </span>
                              <span className="text-muted-foreground">
                                {t("sync.batch.duration", { ms: item.duration_ms })}
                              </span>
                              {item.error !== undefined && (
                                <span className="text-destructive">{item.error}</span>
                              )}
                              {item.decision !== undefined && (
                                <span className="text-muted-foreground">
                                  {t(`sync.resolve.${item.decision}`, { defaultValue: item.decision })}
                                </span>
                              )}
                              {item.pickable ? (
                                <select
                                  className="h-7 rounded-md border bg-background px-1 text-xs"
                                  aria-label={t("sync.batch.pick")}
                                  value={draft ?? item.default_decision}
                                  disabled={busy}
                                  onChange={(event) =>
                                    setPickDrafts((prev) => ({
                                      ...prev,
                                      [pickKey(batch.batch_id, item.path)]: event.target
                                        .value as SyncPickChoice,
                                    }))
                                  }
                                >
                                  {item.choices.map((choice) => (
                                    <option key={choice} value={choice}>
                                      {t(`sync.resolve.${choice}`, { defaultValue: choice })}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                // 置灰：无 base / 非双改项不提供覆盖选项（只能保留两者）。
                                <select
                                  className="h-7 rounded-md border bg-background px-1 text-xs"
                                  aria-label={t("sync.batch.pick")}
                                  value={PICK_KEEP_BOTH}
                                  disabled
                                >
                                  <option value={PICK_KEEP_BOTH}>
                                    {t("sync.resolve.keep_both")}
                                  </option>
                                </select>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                      <p className="text-xs text-muted-foreground">{t("sync.resolve.hint")}</p>
                      <p className="text-xs text-muted-foreground">{t("sync.resolve.output")}</p>
                      <Button
                        variant="outline"
                        disabled={busy || pickable.length === 0}
                        onClick={() => void applyPicks(batch)}
                      >
                        {t("sync.batch.apply")}
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
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
