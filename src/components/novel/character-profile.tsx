import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { User, Loader2, MapPin, Swords, Package } from "lucide-react"
import { loadCharacterStates, type CharacterState } from "@/lib/novel/character-state"
import { loadCognitionState, type CognitionState } from "@/lib/novel/character-cognition"
import { useWikiStore } from "@/stores/wiki-store"

export function CharacterProfile({ characterName, projectPath }: { characterName: string; projectPath: string }) {
  const { t } = useTranslation()
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [charState, setCharState] = useState<CharacterState | null>(null)
  const [cognition, setCognition] = useState<CognitionState | null>(null)
  const [loading, setLoading] = useState(true)

  // dataVersion 监听: chapter-ingest saveCharacterStates+bumpDataVersion 后须 refetch,
  // 否则显示陈旧 charState(location/status/equipment/abilities — 正是本面板渲染的核心字段)。
  // 此前 deps 仅 [characterName, projectPath] 不监听 dataVersion, 与 cognition-panel 不一致(PAT-G2 twin)。
  // cancelled flag 防 race: characterName/projectPath/dataVersion 快速变化时旧 Promise 的 setState 覆盖最新。
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      loadCharacterStates(projectPath),
      loadCognitionState(projectPath),
    ]).then(([chars, cog]) => {
      if (cancelled) return
      setCharState(chars.characters.find(c => c.characterName === characterName) ?? null)
      setCognition(cog)
    }).catch(() => {
      if (!cancelled) {
        setCharState(null)
        setCognition(null)
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [characterName, projectPath, dataVersion])

  const charCognition = cognition?.characters.find(c => c.character === characterName)

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-4 p-3 text-sm">
      <div className="flex items-center gap-2">
        <User className="h-5 w-5 text-primary" />
        <h3 className="text-lg font-semibold">{characterName}</h3>
      </div>

      {charState ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border p-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="h-3 w-3" />
                {t("novel.character.location")}
              </div>
              <p className="mt-1 font-medium">{charState.currentLocation || t("novel.character.unknown")}</p>
            </div>
            <div className="rounded-md border p-2">
              <div className="text-xs text-muted-foreground">{t("novel.character.status")}</div>
              <p className="mt-1 font-medium">{charState.status || t("novel.character.unknown")}</p>
            </div>
          </div>

          {charState.equipment.length > 0 && (
            <div className="rounded-md border p-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Package className="h-3 w-3" />
                {t("novel.character.equipment")}
              </div>
              <p className="mt-1">{charState.equipment.join("、")}</p>
            </div>
          )}

          {charState.abilities.length > 0 && (
            <div className="rounded-md border p-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Swords className="h-3 w-3" />
                {t("novel.character.abilities")}
              </div>
              <p className="mt-1">{charState.abilities.join("、")}</p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("novel.character.noStateData")}</p>
      )}

      {charCognition ? (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground">{t("novel.cognition.title")}</h4>
          {charCognition.knows.length > 0 && (
            <div className="rounded-md border border-success/30 bg-success/10 p-2">
              <p className="text-xs font-medium text-success">{t("novel.cognition.knows")}</p>
              <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                {charCognition.knows.map((item, i) => <li key={`${i}-${item.slice(0, 16)}`}>{item}</li>)}
              </ul>
            </div>
          )}
          {charCognition.doesNotKnow.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2">
              <p className="text-xs font-medium text-destructive">{t("novel.cognition.doesNotKnow")}</p>
              <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                {charCognition.doesNotKnow.map((item, i) => <li key={`${i}-${item.slice(0, 16)}`}>{item}</li>)}
              </ul>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}