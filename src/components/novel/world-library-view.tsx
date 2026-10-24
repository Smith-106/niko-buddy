import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CircleAlert, Globe2, Loader2 } from "lucide-react"
import { fileExists } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import {
  WORLD_LAYERS,
  loadAssetLibraryArtifact,
  loadAssetLibrarySnapshot,
  loadSettingProjection,
  loadWorldBlueprint,
  validateWorldBlueprint,
  type WorldBlueprint,
  type WorldLayer,
  type WorldValidation,
  type SettingProjection,
  type SettingProjectionLoader,
} from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"

/**
 * 世界构建只读视图（Wave 2）：复用 `loadWorldBlueprint` + `validateWorldBlueprint`
 * （零新真源、不写文件）。写回模型仍 DEFER —— 本视图只呈现磁盘上已有的蓝图与校验结论。
 */
export interface WorldBlueprintSnapshot {
  blueprint: WorldBlueprint
  validation: WorldValidation
}

export type WorldBlueprintLoader = (projectPath: string) => Promise<WorldBlueprintSnapshot | null>

export const loadWorldBlueprintSnapshot: WorldBlueprintLoader = async (projectPath) => {
  const blueprint = await loadWorldBlueprint(projectPath)
  if (!blueprint) {
    // 缺文件 = 还没生成（空态）；文件存在却读不出 = 解析/IO 失败（必须进错误态，
    // 不能把「坏了」说成「还没做」——loadWorldBlueprint 默认把两类都收成 null）。
    const exists = await fileExists(`${normalizePath(projectPath)}/.novel/world-blueprint.json`)
    if (exists) {
      throw new Error("世界蓝图存在，但无法解析")
    }
    return null
  }
  return { blueprint, validation: validateWorldBlueprint(blueprint) }
}

/** 结构化关系库视图模型（只读；缺库 -> null）。 */
export interface RelationshipLibrarySnapshotView {
  readonly entries: readonly { from: string; to: string; kind: string; strength?: number; note?: string }[]
}

export type RelationshipLibraryLoader = (projectPath: string) => Promise<RelationshipLibrarySnapshotView | null>

/** 默认装载：读 asset-library 快照；未生成 -> null（不是空数组，避免"已迁移但没数据"混淆）。 */
export const loadRelationshipLibrarySnapshot: RelationshipLibraryLoader = async (projectPath) => {
  const snapshot = await loadAssetLibrarySnapshot(projectPath, "relationship_edge")
  if (!snapshot.present) return null
  const raw = await loadAssetLibraryArtifact(projectPath, "relationship_edge")
  if (!raw) return null
  const entries = raw.entries.map((entry) => {
    const record = entry as { from: string; to: string; kind: string; strength?: number; note?: string }
    return { from: record.from, to: record.to, kind: record.kind, strength: record.strength, note: record.note }
  })
  return { entries }
}

export interface WorldLibraryViewProps {
  /** 测试注入（缺省走真实蓝图读取）。路径取 store 里的 project.path。 */
  loader?: WorldBlueprintLoader
  /** 角色关系只读投影装载（缺省读既有 character-states 真源）。 */
  settingLoader?: SettingProjectionLoader
  /**
   * 结构化关系库装载器（Wave 3B 产物 `.novel/asset-library/relationship_edge.json`）。
   * 未迁移时返回 null —— 此时继续显示三条 N/A，不得假装有类型/强度。
   */
  relationshipLoader?: RelationshipLibraryLoader
}

export function WorldLibraryView({
  loader = loadWorldBlueprintSnapshot,
  settingLoader = loadSettingProjection,
  relationshipLoader = loadRelationshipLibrarySnapshot,
}: WorldLibraryViewProps) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [snapshot, setSnapshot] = useState<WorldBlueprintSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [setting, setSetting] = useState<SettingProjection | null>(null)
  const [settingError, setSettingError] = useState<string | null>(null)
  const [settingLoading, setSettingLoading] = useState(true)
  const [structured, setStructured] = useState<RelationshipLibrarySnapshotView | null>(null)

  const projectPath = project ? normalizePath(project.path) : null

  useEffect(() => {
    if (!projectPath) {
      setSnapshot(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void loader(projectPath)
      .then((next) => {
        if (!cancelled) setSnapshot(next)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSnapshot(null)
          setError(toErrorMessage(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loader, projectPath, dataVersion])

  useEffect(() => {
    if (!projectPath) {
      setSetting(null)
      setSettingError(null)
      setSettingLoading(false)
      return
    }
    let cancelled = false
    // 换项目先清空：否则新蓝图先到时，旧的 cast 会挂在新世界下面
    setSetting(null)
    setSettingError(null)
    setSettingLoading(true)
    void settingLoader(projectPath)
      .then((next) => {
        if (!cancelled) setSetting(next)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSetting(null)
          setSettingError(toErrorMessage(err))
        }
      })
      .finally(() => {
        if (!cancelled) setSettingLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [settingLoader, projectPath, dataVersion])

  useEffect(() => {
    if (!projectPath) {
      setStructured(null)
      return
    }
    let cancelled = false
    setStructured(null)
    void relationshipLoader(projectPath)
      .then((next) => {
        if (!cancelled) setStructured(next)
      })
      .catch(() => {
        // 关系库坏了不阻塞设定中心：按"未迁移"处理（下面显式标注未迁移）
        if (!cancelled) setStructured(null)
      })
    return () => {
      cancelled = true
    }
  }, [relationshipLoader, projectPath, dataVersion])

  const layerCount = (layer: WorldLayer): number => snapshot?.blueprint.layers[layer]?.length ?? 0
  const filledLayers = WORLD_LAYERS.filter((layer) => layerCount(layer) > 0).length
  const errors = snapshot?.validation.findings.filter((f) => f.severity === "error") ?? []
  const warns = snapshot?.validation.findings.filter((f) => f.severity === "warn") ?? []
  const worldNextStep = !projectPath
    ? "下一步：先打开项目。"
    : loading
      ? null
      : error
        ? "下一步：读取失败。先看下面的原因。"
        : !snapshot
          ? "下一步：还没有蓝图。"
          : snapshot.validation.verdict === "complete"
            ? "下一步：先看世界类型和各层。"
            : "下一步：先看空层和下面的问题。"

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4" data-testid="world-library-view">
      <div className="flex items-center gap-2">
        <Globe2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("novel.worldLibrary.title")}</h2>
        <span className="text-xs text-muted-foreground">{t("novel.worldLibrary.readOnly")}</span>
      </div>
      {worldNextStep ? (
        <p className="text-sm font-medium">{worldNextStep}</p>
      ) : null}

      {!projectPath ? (
        <p className="text-xs text-muted-foreground" data-testid="world-library-no-project">
          {t("novel.worldLibrary.noProject")}
        </p>
      ) : loading ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="world-library-loading">
          <Loader2 className="h-3 w-3 animate-spin" />
          …
        </p>
      ) : error ? (
        <p className="flex items-center gap-1 text-xs text-destructive" data-testid="world-library-error">
          <CircleAlert className="h-3 w-3 shrink-0" />
          {t("novel.worldLibrary.loadFailed")}: {error}
          {error === "世界蓝图存在，但无法解析" ? <span className="sr-only">world-blueprint.json</span> : null}
        </p>
      ) : !snapshot ? (
        <p className="text-xs text-muted-foreground" data-testid="world-library-empty">
          {t("novel.worldLibrary.empty")}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="world-library-summary">
            <span className="rounded bg-accent/15 px-1.5 py-0.5" data-testid="world-library-world-type">
              {t("novel.worldLibrary.worldType", { type: snapshot.blueprint.worldType || t("novel.worldLibrary.na") })}
            </span>
            <span className="text-muted-foreground" data-testid="world-library-layer-count">
              {t("novel.worldLibrary.layerCount", { filled: filledLayers, total: WORLD_LAYERS.length })}
            </span>
            <span
              className={snapshot.validation.verdict === "complete" ? "text-success" : "text-warning"}
              data-testid="world-library-verdict"
            >
              {snapshot.validation.verdict === "complete"
                ? t("novel.worldLibrary.verdictComplete")
                : t("novel.worldLibrary.verdictIncomplete")}
            </span>
            <span className="text-muted-foreground" data-testid="world-library-findings-count">
              {t("novel.worldLibrary.findings", { errors: errors.length, warns: warns.length })}
            </span>
          </div>

          <table className="w-full text-left text-xs" data-testid="world-library-layers">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-normal">{t("novel.worldLibrary.colLayer")}</th>
                <th className="py-1 pr-2 font-normal">{t("novel.worldLibrary.colItems")}</th>
                <th className="py-1 pr-2 font-normal">{t("novel.worldLibrary.colEntries")}</th>
              </tr>
            </thead>
            <tbody>
              {WORLD_LAYERS.map((layer) => {
                const entries = snapshot.blueprint.layers[layer] ?? []
                return (
                  <tr
                    key={layer}
                    className={entries.length === 0 ? "border-t border-border/50 opacity-60" : "border-t border-border/50"}
                    data-testid={`world-library-layer-${layer}`}
                  >
                    <td className="py-1 pr-2">{t(`novel.worldLibrary.layer.${layer}`, { defaultValue: layer })}</td>
                    <td className="py-1 pr-2 tabular-nums" data-testid={`world-library-layer-count-${layer}`}>
                      {entries.length === 0 ? t("novel.worldLibrary.na") : entries.length}
                    </td>
                    <td className="py-1 pr-2" data-testid={`world-library-layer-entries-${layer}`}>
                      {entries.length === 0 ? t("novel.worldLibrary.layerEmpty") : entries.join("、")}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <div className="flex flex-col gap-1 text-xs" data-testid="world-library-crossrefs">
            <span className="text-xs font-semibold">{t("novel.worldLibrary.crossRefsTitle")}</span>
            {snapshot.blueprint.crossRefs && snapshot.blueprint.crossRefs.length > 0 ? (
              <ul className="flex flex-col gap-0.5">
                {snapshot.blueprint.crossRefs.map((ref, index) => (
                  <li key={`${ref.from}-${ref.to}-${ref.term}-${index}`} data-testid={`world-library-crossref-${index}`}>
                    {`${ref.from} → ${ref.to}: ${ref.term}`}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground" data-testid="world-library-crossrefs-empty">
                {t("novel.worldLibrary.crossRefsEmpty")}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1 text-xs" data-testid="world-library-findings">
            <span className="text-xs font-semibold">{t("novel.worldLibrary.findingsTitle")}</span>
            {snapshot.validation.findings.length === 0 ? (
              <p className="text-muted-foreground" data-testid="world-library-findings-empty">
                {t("novel.worldLibrary.findingsEmpty")}
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {snapshot.validation.findings.map((finding, index) => (
                  <li
                    key={`${finding.code}-${finding.layer ?? "any"}-${index}`}
                    className={finding.severity === "error" ? "text-destructive" : "text-warning"}
                    data-testid={`world-library-finding-${index}`}
                  >
                    {finding.message}
                    <span className="sr-only">{finding.code}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 设定中心 3A：角色与关系只读投影（自由文本，缺结构化字段处显式 N/A） */}
          <div className="flex flex-col gap-1 text-xs" data-testid="setting-center">
            <span className="text-xs font-semibold">{t("novel.settingCenter.title")}</span>
            {settingError ? (
              <p className="text-destructive" data-testid="setting-center-error">
                {t("novel.settingCenter.loadFailed")}: {settingError}
              </p>
            ) : settingLoading ? (
              <p className="text-muted-foreground" data-testid="setting-center-loading">
                {t("novel.settingCenter.loading")}
              </p>
            ) : !setting || setting.cast.length === 0 ? (
              <p className="text-muted-foreground" data-testid="setting-center-empty">
                {t("novel.settingCenter.empty")}
              </p>
            ) : (
              <>
                <p className="text-muted-foreground" data-testid="setting-center-summary">
                  {t("novel.settingCenter.summary", {
                    cast: setting.cast.length,
                    edges: setting.edges.length,
                    missing: setting.charactersWithoutRelations,
                  })}
                </p>
                <ul className="flex flex-col gap-0.5" data-testid="setting-center-cast">
                  {setting.cast.map((row) => (
                    <li
                      key={row.name}
                      className="flex flex-wrap items-center gap-1"
                      data-testid={`setting-center-cast-${row.name}`}
                    >
                      <span className="font-medium">{row.name}</span>
                      <span className="text-muted-foreground">
                        {row.location ?? t("novel.settingCenter.na")}
                      </span>
                      <span className="text-muted-foreground">
                        {row.lastChapter === null
                          ? t("novel.settingCenter.lastChapterNa")
                          : t("novel.settingCenter.lastChapter", { chapter: row.lastChapter })}
                      </span>
                      {row.isAlive === false ? (
                        <span className="text-destructive">{t("novel.settingCenter.dead")}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {setting.edges.length === 0 ? (
                  <p className="text-muted-foreground" data-testid="setting-center-edges-empty">
                    {t("novel.settingCenter.edgesEmpty")}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-0.5" data-testid="setting-center-edges">
                    {setting.edges.map((edge, index) => (
                      <li key={`${edge.from}-${edge.to}-${index}`} data-testid={`setting-center-edge-${index}`}>
                        {`${edge.from} → ${edge.to}：${edge.description}`}
                      </li>
                    ))}
                  </ul>
                )}
                {structured && structured.entries.length > 0 ? (
                  <ul className="flex flex-col gap-0.5" data-testid="setting-center-structured">
                    {structured.entries.map((edge, index) => (
                      <li key={`${edge.from}-${edge.to}-${index}`} data-testid={`setting-center-structured-${index}`}>
                        {`${edge.from} → ${edge.to} · ${edge.kind}${edge.strength === undefined ? "" : ` · ${edge.strength}`}`}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {structured && structured.entries.length > 0 ? (
                    <li data-testid="setting-center-structured-source">{t("novel.settingCenter.structuredSource")}</li>
                  ) : (
                    <>
                      <li data-testid="setting-center-na-type">{t("novel.settingCenter.naType")}</li>
                      <li data-testid="setting-center-na-strength">{t("novel.settingCenter.naStrength")}</li>
                    </>
                  )}
                  <li data-testid="setting-center-na-graph">{t("novel.settingCenter.naGraph")}</li>
                </ul>
              </>
            )}
          </div>

          <p className="text-xs text-muted-foreground" data-testid="world-library-defer-note">
            {t("novel.worldLibrary.writeBackDeferred")}
          </p>
        </>
      )}
    </div>
  )
}
