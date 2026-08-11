import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { X, RefreshCw, MapPin, Swords, Package } from "lucide-react"
import { loadCognitionState, type CognitionState } from "@/lib/novel/character-cognition"
import { loadCharacterStates, type CharacterState } from "@/lib/novel/character-state"
import { useWikiStore } from "@/stores/wiki-store"

interface Props {
  projectPath: string
  onClose: () => void
}

export function CognitionPanel({ projectPath, onClose }: Props) {
  const { t } = useTranslation()
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [state, setState] = useState<CognitionState | null>(null)
  // ISS-20260709-008: CharacterProfile 孤儿组件合并进 CognitionPanel。
  // 角色单卡视图(location/status/equipment/abilities)折叠展示，避免第三个
  // 只读角色面板。dataVersion 监听与 cognition 同步(chapter-ingest
  // saveCharacterStates+bumpDataVersion 后 refetch)。
  const [charStates, setCharStates] = useState<Map<string, CharacterState>>(new Map())
  const [loading, setLoading] = useState(true)
  // ISS-20260712-010: error vs empty must not share the same UI branch (Fix Don't Hide).
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, chars] = await Promise.all([
        loadCognitionState(projectPath),
        loadCharacterStates(projectPath),
      ])
      setState(s)
      setCharStates(new Map(chars.characters.map((c) => [c.characterName, c])))
    } catch (err) {
      setState(null)
      setCharStates(new Map())
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  // cancelled flag 防 race: dataVersion 快速 bump(章节 ingest 连续保存)时,
  // 旧 fetch 的 setState 可能后于新 fetch 解析,用陈旧数据覆盖最新状态。
  // 加 ignore 守卫让 cancelled 后的 setState 静默丢弃。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const [s, chars] = await Promise.all([
          loadCognitionState(projectPath),
          loadCharacterStates(projectPath),
        ])
        if (!cancelled) {
          setState(s)
          setCharStates(new Map(chars.characters.map((c) => [c.characterName, c])))
        }
      } catch (err) {
        if (!cancelled) {
          setState(null)
          setCharStates(new Map())
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [projectPath, dataVersion])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-sm font-semibold">{t("novel.cognition.title")}</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={load}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={t("novel.cognition.refresh")}
            aria-label={t("novel.cognition.refresh")}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("common.close")}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scroll-fade-y p-3 text-sm">
        {loading ? (
          <div className="space-y-2" role="status" aria-label={t("novel.cognition.loading")}>
            <div className="skeleton-bar h-20 w-full rounded-lg" />
            <div className="skeleton-bar h-20 w-full rounded-lg" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 pt-8 text-destructive" role="alert">
            <p className="font-medium">{t("novel.cognition.loadError")}</p>
            <p className="max-w-full break-words px-2 text-center text-xs text-muted-foreground">{error}</p>
            <button
              type="button"
              onClick={load}
              className="mt-1 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              {t("novel.cognition.retry")}
            </button>
          </div>
        ) : !state || (state.characters.length === 0 && state.readerKnows.length === 0) ? (
          <div className="flex flex-col items-center gap-2 pt-8 text-muted-foreground">
            <p>{t("novel.cognition.noData")}</p>
            <p className="text-xs italic">
              {t("novel.cognition.noDataHint")}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {state.lastUpdatedChapter > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("novel.cognition.lastUpdated", { chapter: state.lastUpdatedChapter })}
              </p>
            )}
            {state.characters.map((char) => {
              const cs = charStates.get(char.character)
              const hasStateDetail = cs && (
                cs.currentLocation || cs.status || cs.equipment.length > 0 || cs.abilities.length > 0
              )
              return (
              <div key={char.character} className="rounded-lg border p-3">
                <p className="font-semibold text-foreground">{char.character}</p>
                {hasStateDetail && cs && (
                  <details className="mt-1 group">
                    <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
                      {t("novel.character.status")}
                    </summary>
                    <div className="mt-2 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-md border p-2">
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <MapPin className="h-3 w-3" aria-hidden="true" />
                            {t("novel.character.location")}
                          </div>
                          <p className="mt-1 text-xs font-medium">{cs.currentLocation || t("novel.character.unknown")}</p>
                        </div>
                        <div className="rounded-md border p-2">
                          <div className="text-xs text-muted-foreground">{t("novel.character.status")}</div>
                          <p className="mt-1 text-xs font-medium">{cs.status || t("novel.character.unknown")}</p>
                        </div>
                      </div>
                      {cs.equipment.length > 0 && (
                        <div className="rounded-md border p-2">
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Package className="h-3 w-3" aria-hidden="true" />
                            {t("novel.character.equipment")}
                          </div>
                          <p className="mt-1 text-xs">{cs.equipment.join("、")}</p>
                        </div>
                      )}
                      {cs.abilities.length > 0 && (
                        <div className="rounded-md border p-2">
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Swords className="h-3 w-3" aria-hidden="true" />
                            {t("novel.character.abilities")}
                          </div>
                          <p className="mt-1 text-xs">{cs.abilities.join("、")}</p>
                        </div>
                      )}
                    </div>
                  </details>
                )}
                {(char.knows.length > 0 || char.doesNotKnow.length > 0) && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div className="rounded-md border-l-2 border-success/50 bg-success/5 p-2">
                      <span className="text-xs font-medium text-success">
                        {t("novel.cognition.knows")}
                      </span>
                      {char.knows.length > 0 ? (
                        <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                          {char.knows.map((item, i) => (
                            <li key={`${i}-${item.slice(0, 16)}`}>{item}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-0.5 text-xs italic text-muted-foreground/60">{t("novel.cognition.empty")}</p>
                      )}
                    </div>
                    <div className="rounded-md border-l-2 border-destructive/50 bg-destructive/5 p-2">
                      <span className="text-xs font-medium text-destructive">
                        {t("novel.cognition.doesNotKnow")}
                      </span>
                      {char.doesNotKnow.length > 0 ? (
                        <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                          {char.doesNotKnow.map((item, i) => (
                            <li key={`${i}-${item.slice(0, 16)}`}>{item}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-0.5 text-xs italic text-muted-foreground/60">{t("novel.cognition.empty")}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
              )
            })}
            {state.readerKnows.length > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
                <p className="font-semibold text-foreground">{t("novel.cognition.readerKnows")}</p>
                <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                  {state.readerKnows.map((item, i) => (
                    <li key={`${i}-${item.slice(0, 16)}`}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
