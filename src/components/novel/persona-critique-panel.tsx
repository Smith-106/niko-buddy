/**
 * EPIC-005 / ADR-34 — advisory multi-persona critique UI.
 * Consultative only: never writes decision_gates / status.json.
 */
import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, Loader2, Sparkles, X } from "lucide-react"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import {
  DEFAULT_PERSONA_IDS,
  PERSONA_CATALOG,
  runPersonaCritique,
  type PersonaCritiqueResult,
  type PersonaId,
} from "@/lib/novel/persona-sidecar-runner"
import { loadNovelSessionStatus } from "@/lib/novel/novel-session-status"
import { useWikiStore } from "@/stores/wiki-store"

interface Props {
  projectPath: string
  onClose: () => void
  /** Optional explicit draft/conversation id; defaults to status.current draft. */
  draftId?: string
}

export function PersonaCritiquePanel({ projectPath, onClose, draftId: draftIdProp }: Props) {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const [selected, setSelected] = useState<PersonaId[]>([...DEFAULT_PERSONA_IDS])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [results, setResults] = useState<PersonaCritiqueResult[]>([])
  const [resolvedDraftId, setResolvedDraftId] = useState<string | null>(draftIdProp ?? null)
  const [draftStatus, setDraftStatus] = useState<string | null>(null)

  const allPersonas = useMemo(
    () => DEFAULT_PERSONA_IDS.map((id) => PERSONA_CATALOG[id]),
    [],
  )

  const toggle = (id: PersonaId) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    setReason(null)
    setResults([])
    try {
      if (!hasUsableLlm(llmConfig)) {
        setError(t("novel.persona.needLlm"))
        return
      }
      let draftId = draftIdProp ?? resolvedDraftId
      let statusDraft = draftStatus
      if (!draftId) {
        const status = await loadNovelSessionStatus(projectPath)
        draftId = status?.draft?.draft_id ?? status?.current_task?.conversation_id ?? null
        statusDraft = status?.draft?.draft_status ?? null
        setResolvedDraftId(draftId)
        setDraftStatus(statusDraft)
      }
      if (!draftId) {
        setError(t("novel.persona.noDraft"))
        return
      }
      if (selected.length === 0) {
        setError(t("novel.persona.pickOne"))
        return
      }
      const res = await runPersonaCritique({
        projectPath,
        draftId,
        personaIds: selected,
        llmConfig,
      })
      if (!res.ok) {
        if (res.reason === "draft-not-ready") {
          setReason(t("novel.persona.draftNotReady", { status: res.draftStatus ?? "unknown" }))
        } else if (res.reason === "draft-missing") {
          setReason(t("novel.persona.draftMissing"))
        } else {
          setReason(t("novel.persona.emptyPersonas"))
        }
      }
      setDraftStatus(res.draftStatus ?? statusDraft)
      setResults(res.results)
    } catch (err) {
      // PAT-DC1: message only
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }, [draftIdProp, draftStatus, llmConfig, projectPath, resolvedDraftId, selected, t])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
            {t("novel.persona.title")}
          </h3>
          <p className="truncate text-[11px] text-muted-foreground">{t("novel.persona.advisoryHint")}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("common.close")}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto scroll-fade-y p-3 text-sm">
        <div className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-muted-foreground">
          <div className="mb-1 flex items-center gap-1 font-medium text-foreground">
            <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
            {t("novel.persona.isolationTitle")}
          </div>
          {t("novel.persona.isolationBody")}
        </div>

        {(resolvedDraftId || draftStatus) && (
          <p className="text-xs text-muted-foreground">
            {t("novel.persona.draftMeta", {
              id: resolvedDraftId ?? "—",
              status: draftStatus ?? "—",
            })}
          </p>
        )}

        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("novel.persona.pickPersonas")}</p>
          <div className="flex flex-wrap gap-2">
            {allPersonas.map((p) => {
              const on = selected.includes(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggle(p.id)}
                  disabled={running}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
                    on
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent"
                  }`}
                  aria-pressed={on}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {running ? t("novel.persona.running") : t("novel.persona.run")}
        </button>

        {error ? (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        {reason ? (
          <div role="status" className="rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
            {reason}
          </div>
        ) : null}

        {results.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t("novel.persona.results")}</p>
            {results.map((r) => (
              <div key={r.personaId} className="rounded-lg border p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">{r.label}</p>
                  <span
                    className={`text-[11px] ${
                      r.status === "ok"
                        ? "text-success"
                        : r.status === "error"
                          ? "text-destructive"
                          : "text-muted-foreground"
                    }`}
                  >
                    {r.status === "ok"
                      ? t("novel.persona.statusOk")
                      : r.status === "error"
                        ? t("novel.persona.statusError")
                        : t("novel.persona.statusSkipped")}
                  </span>
                </div>
                {r.summary ? <p className="mt-1 text-xs text-foreground">{r.summary}</p> : null}
                {r.findings && r.findings.length > 0 ? (
                  <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                    {r.findings.map((f, i) => (
                      <li key={`${r.personaId}-${i}`}>{f}</li>
                    ))}
                  </ul>
                ) : null}
                {r.error ? <p className="mt-1 text-xs text-destructive">{r.error}</p> : null}
                {r.writtenPath ? (
                  <p className="mt-1 truncate text-[10px] text-muted-foreground/80" title={r.writtenPath}>
                    {t("novel.persona.written", { path: r.writtenPath })}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
