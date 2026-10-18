/**
 * asset-library-view.tsx — 资产库可视化（全库守恒 / 健康 / 只读徽标；唯一写操作是显式迁移按钮）。
 *
 * ## 职责
 *   - 展示 `LIBRARY_IDS` 全部库的磁盘快照：条目数 / 守恒状态 / 只读徽标 /
 *     kb-health 违规清单；
 *   - 未生成的库显式「未生成」（诚实空态，绝不造条目）；
 *   - 读取失败的库显式报错原因（fail-loud 展示，不静默降级为 0 条）。
 *
 * ## 边界
 *   - 装载只读（`loadAllAssetLibrarySnapshots`）；不改产物、不手改条目；唯一的写操作是
 *   - 数据源单一：`.novel/asset-library/<libraryId>.json`（生成器产物），
 *     用户显式点击的「迁移角色关系库」（内部走守恒校验，可与既有内容冲突而不覆盖；只读守卫 EB-2）。
 *
 * 中文标签直书（与 kb-health-view / diagnostics-center 同款约定，零新增 i18n 键）。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import { CheckCircle2, AlertTriangle, Database, Loader2, Lock } from "lucide-react"
import { readFile } from "@/commands/fs"

import { AssetExtractionGapPanel } from "./asset-extraction-gap-panel"
import { AssetLinkagePanel } from "./asset-linkage-panel"
import {
  LIBRARY_IDS,
  loadAllAssetLibrarySnapshots,
  chapterDraftPath,
  loadCharacterStates,
  loadNovelSessionStatus,
  listBindableNovelCharacters,
  migrateRelationshipLibrary,
  type AssetLibrarySnapshot,
  type CharacterState,
  type AssetLibraryStoreDeps,
  type LibraryId,
} from "@/lib/novel"

/** 库中文名（与 asset-library 的 LIBRARY_IDS 一一对应）。 */
const LIBRARY_LABEL: Record<LibraryId, string> = {
  genre_base: "题材基线库",
  pacing_pattern: "节奏模式库",
  title_seed: "书名种子库",
  world_sample: "世界样本库",
  character_archetype: "人物原型库",
  relationship_edge: "角色关系库",
}

export interface AssetLibraryViewProps {
  readonly projectPath: string
  /** 显式注入快照（测试/预览优先，跳过磁盘装载）。 */
  readonly snapshots?: readonly AssetLibrarySnapshot[]
  /** 注入迁移实现（测试可替换）；默认走 Wave 3B 的关系库迁移。 */
  readonly migrateRelationships?: (projectPath: string) => Promise<{
    status: "written" | "noop" | "conflict" | "empty"
    entryCount: number
  }>
  /** 磁盘装载 deps 注入（jsdom 测试）。 */
  readonly deps?: AssetLibraryStoreDeps
}

export function AssetLibraryView({ projectPath, snapshots, deps, migrateRelationships }: AssetLibraryViewProps) {
  const [loaded, setLoaded] = useState<readonly AssetLibrarySnapshot[] | null>(snapshots ?? null)
  const [loading, setLoading] = useState(snapshots === undefined)

  useEffect(() => {
    if (snapshots !== undefined) {
      setLoaded(snapshots)
      setLoading(false)
      return
    }
    if (!projectPath) {
      setLoaded([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const result = await loadAllAssetLibrarySnapshots(projectPath, deps)
        if (!cancelled) setLoaded(result)
      } catch {
        // 装载失败：不臆造条目，落诚实空态（各库显示「未生成/不可读」）。
        if (!cancelled) setLoaded([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectPath, snapshots, deps])

  // 角色状态（联动比对左侧真源）：未装载前保持 null，让审计报 N/A 而不是判漂移。
  const [characters, setCharacters] = useState<readonly CharacterState[] | null>(null)
  useEffect(() => {
    if (!projectPath) {
      // 无项目 ≠ 已确认零角色：保持 null（面板走 N/A，不给绿态）。
      setCharacters(null)
      return
    }
    let cancelled = false
    void loadCharacterStates(projectPath)
      .then((store) => {
        if (!cancelled) setCharacters(store?.characters ?? [])
      })
      .catch(() => {
        if (!cancelled) setCharacters(null)
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  // 提取缺口（续写/拆书）：需要当前章正文 + wiki 人物实体名。
  // 两者都单列「是否已装载」，读失败保持 false → 面板整段 N/A，不当作「没有缺口」。
  const [extraction, setExtraction] = useState<{
    chapterNumber: number | null
    chapterText: string
    wikiCharacterNames: readonly string[]
    wikiLoaded: boolean
  }>({ chapterNumber: null, chapterText: "", wikiCharacterNames: [], wikiLoaded: false })
  useEffect(() => {
    if (!projectPath) {
      setExtraction({ chapterNumber: null, chapterText: "", wikiCharacterNames: [], wikiLoaded: false })
      return
    }
    let cancelled = false
    void (async () => {
      const status = await loadNovelSessionStatus(projectPath).catch(() => null)
      const raw = status?.current_task?.chapter_number
      const chapterNumber = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null
      const chapterText =
        chapterNumber === null
          ? ""
          : await readFile(chapterDraftPath(projectPath, chapterNumber)).catch(() => "")
      const wikiCharacterNames = await listBindableNovelCharacters(projectPath).catch(() => null)
      if (cancelled) return
      setExtraction({
        chapterNumber,
        chapterText,
        wikiCharacterNames: wikiCharacterNames ?? [],
        wikiLoaded: wikiCharacterNames !== null,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const [migrateState, setMigrateState] = useState<{
    status: "written" | "noop" | "conflict" | "empty"
    entryCount: number
  } | null>(null)
  const [migrating, setMigrating] = useState(false)

  const runMigrate = () => {
    setMigrating(true)
    void (migrateRelationships ?? ((path: string) => migrateRelationshipLibrary(path)))(projectPath)
      .then((result) => {
        setMigrateState(result)
        // 写成功后重新装载：否则状态行说 written，行内仍停在「未生成」
        if (result.status === "written") {
          void loadAllAssetLibrarySnapshots(projectPath, deps).then((next) => setLoaded(next))
        }
      })
      .catch(() => setMigrateState(null))
      .finally(() => setMigrating(false))
  }

  const rows = loaded ?? []
  const generated = rows.filter((row) => row.present)
  const violations = rows.reduce((sum, row) => sum + (row.health?.violations.length ?? 0), 0)
  const relationshipRow = rows.find((row) => row.libraryId === "relationship_edge")
  const relationshipArtifactDigest =
    relationshipRow?.present && relationshipRow.contentHash
      ? { contentHash: relationshipRow.contentHash, entryCount: relationshipRow.entryCount }
      : null

  return (
    <section data-testid="asset-library-view" className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Database className="h-4 w-4" />
          资产库（全部库 · 生成器产物 · 只读）
        </h2>
        <span data-testid="asset-library-summary" className="text-xs text-muted-foreground">
          已生成 {generated.length}/{LIBRARY_IDS.length} · 违规 {violations}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        产物来自 <code className="font-mono">.novel/asset-library/&lt;库&gt;.json</code>
        ，写入须过守恒校验（手工篡改会被检出并标红）。本页不提供手改入口；唯一的写操作是下方显式的「迁移角色关系库」按钮（点击才写，且必须过守恒校验）。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="asset-library-migrate-relationships"
          onClick={runMigrate}
          disabled={migrating}
          className="rounded border border-border px-2 py-1 text-xs"
        >
          {migrating ? "迁移中…" : "迁移角色关系库（relationship_edge）"}
        </button>
        {migrateState ? (
          <span data-testid="asset-library-migrate-status" className="text-xs text-muted-foreground">
            {`迁移结果：${migrateState.status}（${migrateState.entryCount} 条边）`}
            {migrateState.status === "conflict" ? " · 已存在不同内容，未覆盖" : ""}
          </span>
        ) : null}
      </div>
      {/* 联动一致性：只读比对「角色状态 ↔ 关系产物」，不自动修复。
          快照事实面在本页不加载 → 由审计自己报 N/A，不假装「已检查」。 */}
      <AssetLinkagePanel
        input={{
          characters: characters ?? [],
          charactersLoaded: characters !== null,
          relationshipArtifact: relationshipArtifactDigest,
          // 本页不装载快照：不传该字段 = 「未检查」；传 [] 会被当成「已装载且零条关系变更」。
          snapshotRelationLines: undefined,
        }}
      />
      {/* 提取缺口：正文出现但资产没接的人物/关系 → 只列清单 + 草稿建议，不写盘。 */}
      <AssetExtractionGapPanel
        input={{
          chapterNumber: extraction.chapterNumber,
          chapterText: extraction.chapterText,
          characters: characters ?? [],
          charactersLoaded: characters !== null,
          wikiCharacterNames: extraction.wikiCharacterNames,
          wikiLoaded: extraction.wikiLoaded,
        }}
      />
      {loading ? (
        <p data-testid="asset-library-loading" className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在读取资产库…
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {LIBRARY_IDS.map((libraryId, index) => {
            const row = rows.find((item) => item.libraryId === libraryId)
            const present = row?.present ?? false
            const conserved = row?.conserved ?? false
            const violationList = row?.health?.violations ?? []
            const error = row?.error
            void index
            return (
              <li
                key={libraryId}
                data-testid={`asset-library-row-${libraryId}`}
                className="rounded-md border border-border bg-background px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    {LIBRARY_LABEL[libraryId]}
                    <span className="font-mono text-[11px] text-muted-foreground">{libraryId}</span>
                  </span>
                  <span className="flex items-center gap-2 text-xs">
                    {present ? (
                      <span
                        data-testid={`asset-library-count-${libraryId}`}
                        className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                      >
                        {row?.entryCount ?? 0} 条
                      </span>
                    ) : (
                      <span
                        data-testid={`asset-library-empty-${libraryId}`}
                        className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                      >
                        未生成
                      </span>
                    )}
                    {present && conserved ? (
                      <span
                        data-testid={`asset-library-conserved-${libraryId}`}
                        className="flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
                      >
                        <CheckCircle2 className="h-3 w-3" />
                        守恒校验通过
                      </span>
                    ) : null}
                    {present && !conserved ? (
                      <span
                        data-testid={`asset-library-drift-${libraryId}`}
                        className="flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-red-900 dark:bg-red-950/40 dark:text-red-200"
                      >
                        <AlertTriangle className="h-3 w-3" />
                        守恒失配
                      </span>
                    ) : null}
                    <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                      <Lock className="h-3 w-3" />
                      只读
                    </span>
                  </span>
                </div>
                {error ? (
                  <p data-testid={`asset-library-error-${libraryId}`} className="mt-1 text-xs text-red-700 dark:text-red-300">
                    读取失败：{error}
                  </p>
                ) : null}
                {violationList.length > 0 ? (
                  <ul
                    data-testid={`asset-library-violations-${libraryId}`}
                    className="mt-1 list-disc pl-5 text-xs text-amber-700 dark:text-amber-300"
                  >
                    {violationList.map((violation) => (
                      <li key={violation}>{violation}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
