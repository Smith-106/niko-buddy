import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react"
import {
  MAIN_CONTROL_RERUN_INTENT,
  createFsRunEventLedgerStoreDeps,
  listChapterDrafts,
  loadRunEventLedgerStore,
  readLatestGateRunGroup,
  rerunMainControlGates,
  type ChapterDraft,
  type DeepChapterDecisionGateKey,
  type GateRunEvidenceGroup,
  type MainControlGateRow,
  type RerunMainControlGatesResult,
  type RunEventLedger,
  type RunEventLedgerStoreDeps,
} from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"

/**
 * 主控 live 页签的「重跑门控」区块（F1b）。
 *
 * 判定唯一真源是 `buildDecisionGates`，编排唯一入口是 `evaluateChapterGates`——
 * 本组件零判定：只调 `rerunMainControlGates`，再把结果行原样渲染。
 *
 * 未评估一律呈现为「未评估」（`skipped`），绝不呈现为通过：
 * - 门 status=pending → skipped（`mapDecisionGateToRunStatus` 同源）；
 * - 契约维度缺席（taskBrief 无契约段）/ AI 审稿关闭 → 显式提示，不给绿色结论。
 *
 * F17：已落库（status=saved）的草稿不再提供重跑按钮——重跑只会产出与正式正文
 * 不一致的判定。口径与采纳块（main-control-draft-adopt-block.tsx）一致：saved 只
 * 渲染「已写入正式章」徽章。过滤只发生在渲染层，lib 侧 `rerunMainControlGates`
 * 的草稿查表语义保持不变。
 *
 * B9（回读）：落账的全部意义是「页签切回来结论还在」，因此组件挂载/重跑后都用
 * `readLatestGateRunGroup(ledger, { intent: MAIN_CONTROL_RERUN_INTENT })` 从账本
 * 回读上一次重跑结论，渲染为独立的「历史记录」块（带账本时间）。内存结论与回读
 * 结论分两个可见面，`evidenceTs === history.ts` 时在历史块额外标「本次运行」——
 * 用户永远能分清「刚才跑的」与「账本里存着的」。
 *
 * RVF-11：`evidenceRecorded` / `evidenceError` 不再是被丢弃的死返回——落账成功
 * 报「已落账（N 门）」，失败报原因（结论仍有效，只是不可回读）。
 */
const GATE_LABEL_KEYS: Record<DeepChapterDecisionGateKey, string> = {
  consistency: "mainControl.draftGateConsistency",
  anti_ai: "mainControl.draftGateAntiAi",
  quality: "mainControl.draftGateQuality",
}

const GATE_STATUS_LABEL_KEYS: Record<MainControlGateRow["status"], string> = {
  pass: "mainControl.draftGatePass",
  fail: "mainControl.draftGateFail",
  skipped: "mainControl.draftGatePending",
}

const OVERALL_LABEL_KEYS: Record<RerunMainControlGatesResult["overall"], string> = {
  pass: "mainControl.draftGatePass",
  warning: "mainControl.draftGateWarning",
  fail: "mainControl.draftGateFail",
  manual_review: "mainControl.draftGateManual",
  pending: "mainControl.draftGatePending",
}

export interface MainControlGateRerunBlockProps {
  readonly projectPath: string
  /** 显式注入账本（测试/预览；`null` = 不读磁盘，历史面诚实为空）。 */
  readonly ledger?: RunEventLedger | null
  /** 账本 deps 注入（jsdom 测试；缺省生产 deps = Tauri fs 只读）。 */
  readonly deps?: RunEventLedgerStoreDeps
}

/** 账本 ts → 可读时间（去掉毫秒，保持确定性：不做本地时区换算）。 */
function formatLedgerTs(ts: string): string {
  return ts.replace("T", " ").replace(/\.\d+Z$/, "Z")
}

export function MainControlGateRerunBlock({ projectPath, ledger, deps }: MainControlGateRerunBlockProps) {
  const { t } = useTranslation()
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const [drafts, setDrafts] = useState<ChapterDraft[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [result, setResult] = useState<RerunMainControlGatesResult | null>(null)
  /** 账本回读的上一次重跑结论（B9：页签切回来结论仍在）。 */
  const [history, setHistory] = useState<GateRunEvidenceGroup | null>(null)
  /** 回读失败原因（非致命：只是历史面缺失，不影响本次重跑）。 */
  const [historyError, setHistoryError] = useState<string | null>(null)
  /** 重跑后触发账本重新回读（写入发生在 lib 侧，组件只能重新读）。 */
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    void listChapterDrafts(projectPath)
      .then((rows) => {
        if (!cancelled) setDrafts(rows)
      })
      .catch((error) => {
        if (!cancelled) setNote(toErrorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  // B9：挂载 / 重跑后回读账本里上一次 `main-control-rerun` 的结论。
  useEffect(() => {
    if (ledger !== undefined) {
      // 显式注入（测试/预览）：null = 不读磁盘，历史面诚实为空
      setHistory(ledger === null ? null : readLatestGateRunGroup(ledger, { intent: MAIN_CONTROL_RERUN_INTENT }))
      setHistoryError(null)
      return
    }
    if (!projectPath) return
    let cancelled = false
    void (async () => {
      try {
        const file = await loadRunEventLedgerStore(deps ?? createFsRunEventLedgerStoreDeps(), projectPath)
        if (cancelled) return
        setHistory(readLatestGateRunGroup(file, { intent: MAIN_CONTROL_RERUN_INTENT }))
        setHistoryError(null)
      } catch (error) {
        // 账本损坏/不可读：历史面诚实缺失（不臆造历史结论），不影响本次重跑
        if (cancelled) return
        setHistory(null)
        setHistoryError(toErrorMessage(error))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectPath, ledger, deps, reloadToken])

  async function rerun(draft: ChapterDraft): Promise<void> {
    if (busyId) return
    setBusyId(draft.id)
    setNote(null)
    setResult(null)
    try {
      const outcome = await rerunMainControlGates({
        projectPath,
        draftId: draft.id,
        goal: draft.chapterName,
        novelConfig,
        llmConfig,
      })
      setResult(outcome)
      setNote(t("mainControl.draftGateRerunDone", { overall: t(OVERALL_LABEL_KEYS[outcome.overall]) }))
      // 落账后重新回读账本（本轮结论进历史面；写入归 lib，组件只能重读）
      setReloadToken((token) => token + 1)
    } catch (error) {
      setNote(t("mainControl.draftGateRerunFailed", { message: toErrorMessage(error) }))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="rounded-lg border p-2" data-testid="main-control-gate-rerun">
      <h3 className="mb-1 text-xs font-semibold">{t("mainControl.draftGateBlockTitle")}</h3>
      <p className="text-xs text-muted-foreground">{t("mainControl.draftGateBlockHint")}</p>
      {drafts.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="main-control-gate-rerun-empty">
          {t("mainControl.draftAdoptEmpty")}
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {drafts.map((draft) => (
            <li
              key={draft.id}
              className="flex items-center gap-2 text-xs"
              data-testid={`main-control-gate-rerun-row-${draft.id}`}
            >
              <span className="text-primary">{draft.chapterName}</span>
              {draft.status === "saved" ? (
                <span
                  className="ml-auto flex items-center gap-1 text-success"
                  data-testid={`main-control-gate-rerun-saved-${draft.id}`}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  {t("mainControl.draftSavedAlready")}
                </span>
              ) : (
                <button
                  type="button"
                  className="ml-auto flex h-7 items-center gap-1 rounded-md border px-2 text-xs disabled:opacity-40"
                  data-testid={`main-control-gate-rerun-${draft.id}`}
                  disabled={busyId !== null}
                  onClick={() => void rerun(draft)}
                >
                  {busyId === draft.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  {t("mainControl.draftGateRerun")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {busyId ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="main-control-gate-rerun-running">
          {t("mainControl.draftGateRerunRunning")}
        </p>
      ) : null}
      {note ? (
        <p
          className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"
          data-testid="main-control-gate-rerun-note"
          role="status"
          aria-live="polite"
        >
          <CircleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
          {note}
        </p>
      ) : null}
      {result ? (
        <div className="mt-1 flex flex-col gap-1" data-testid="main-control-gate-rerun-result">
          <p className="flex items-center gap-1 text-xs font-medium" data-testid="main-control-gate-rerun-result-label">
            {t("mainControl.draftGateRerunCurrent")}
          </p>
          <ul className="flex flex-col gap-0.5">
            {result.rows.map((row) => (
              <li key={row.key} className="text-xs" data-testid={`main-control-gate-row-${row.key}`}>
                <span className="mr-1 font-medium">{t(GATE_LABEL_KEYS[row.key])}</span>
                <span className={row.status === "pass" ? "text-success" : row.status === "fail" ? "text-destructive" : "text-muted-foreground"}>
                  {t(GATE_STATUS_LABEL_KEYS[row.status])}
                </span>
                <span className="ml-1 text-muted-foreground">· {row.findings}</span>
              </li>
            ))}
          </ul>
          {!result.llmMediated ? (
            <p className="text-xs text-warning-foreground" data-testid="main-control-gate-rerun-no-review">
              {t("mainControl.draftGateRerunNoReview")}
            </p>
          ) : null}
          {!result.contractEvaluated ? (
            <p className="text-xs text-warning-foreground" data-testid="main-control-gate-rerun-contract">
              {t("mainControl.draftGateContractUnassessed")}
            </p>
          ) : null}
          {/* RVF-11：落账结果的可见面（成功 / 失败都说清楚，不丢死返回） */}
          {result.evidenceError !== undefined ? (
            <p className="text-xs text-warning-foreground" data-testid="main-control-gate-rerun-evidence-error">
              {t("mainControl.draftGateRerunEvidenceFailed", { message: result.evidenceError })}
            </p>
          ) : result.evidenceRecorded !== undefined && result.evidenceRecorded.length > 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="main-control-gate-rerun-evidence-recorded">
              {t("mainControl.draftGateRerunEvidenceRecorded", { gates: result.evidenceRecorded.length })}
            </p>
          ) : null}
        </div>
      ) : null}
      {history !== null ? (
        <div
          className="mt-1 flex flex-col gap-0.5 border-t pt-1"
          data-testid="main-control-gate-rerun-history"
        >
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            {t("mainControl.draftGateRerunHistory", { ts: formatLedgerTs(history.ts) })}
            {result?.evidenceTs !== undefined && result.evidenceTs === history.ts ? (
              <span
                className="rounded border px-1 text-xs"
                data-testid="main-control-gate-rerun-history-current"
              >
                {t("mainControl.draftGateRerunCurrent")}
              </span>
            ) : null}
          </p>
          <ul className="flex flex-col gap-0.5">
            {history.rows.map((row) => (
              <li
                key={row.gate}
                className="text-xs"
                data-testid={`main-control-gate-history-row-${row.gate}`}
              >
                <span className="mr-1 font-medium">{t(GATE_LABEL_KEYS[row.gate])}</span>
                <span
                  className={
                    row.status === "pass"
                      ? "text-success"
                      : row.status === "fail"
                        ? "text-destructive"
                        : "text-muted-foreground"
                  }
                >
                  {t(GATE_STATUS_LABEL_KEYS[row.status])}
                </span>
                <span className="ml-1 text-muted-foreground">· {row.findingsCount}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {historyError !== null ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="main-control-gate-rerun-history-error">
          {historyError}
        </p>
      ) : null}
    </div>
  )
}
