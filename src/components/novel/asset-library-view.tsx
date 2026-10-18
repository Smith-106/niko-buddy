/**
 * asset-library-view.tsx — 资产库可视化（5 库守恒 / 健康 / 只读徽标）。
 *
 * ## 职责
 *   - 展示 `LIBRARY_IDS` 5 个库的磁盘快照：条目数 / 守恒状态 / 只读徽标 /
 *     kb-health 违规清单；
 *   - 未生成的库显式「未生成」（诚实空态，绝不造条目）；
 *   - 读取失败的库显式报错原因（fail-loud 展示，不静默降级为 0 条）。
 *
 * ## 边界
 *   - 纯展示 + 只读装载（`loadAllAssetLibrarySnapshots`）；不写任何库、不改产物；
 *   - 数据源单一：`.novel/asset-library/<libraryId>.json`（生成器产物），
 *     界面不提供手改入口（只读守卫 EB-2）。
 *
 * 中文标签直书（与 kb-health-view / diagnostics-center 同款约定，零新增 i18n 键）。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import { CheckCircle2, AlertTriangle, Database, Loader2, Lock } from "lucide-react"
import {
  LIBRARY_IDS,
  loadAllAssetLibrarySnapshots,
  type AssetLibrarySnapshot,
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
}

export interface AssetLibraryViewProps {
  readonly projectPath: string
  /** 显式注入快照（测试/预览优先，跳过磁盘装载）。 */
  readonly snapshots?: readonly AssetLibrarySnapshot[]
  /** 磁盘装载 deps 注入（jsdom 测试）。 */
  readonly deps?: AssetLibraryStoreDeps
}

export function AssetLibraryView({ projectPath, snapshots, deps }: AssetLibraryViewProps) {
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

  const rows = loaded ?? []
  const generated = rows.filter((row) => row.present)
  const violations = rows.reduce((sum, row) => sum + (row.health?.violations.length ?? 0), 0)

  return (
    <section data-testid="asset-library-view" className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Database className="h-4 w-4" />
          资产库（5 库 · 生成器产物 · 只读）
        </h2>
        <span data-testid="asset-library-summary" className="text-xs text-muted-foreground">
          已生成 {generated.length}/{LIBRARY_IDS.length} · 违规 {violations}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        产物来自 <code className="font-mono">.novel/asset-library/&lt;库&gt;.json</code>
        ，写入须过守恒校验（手工篡改会被检出并标红）。本页只读，不提供手改入口。
      </p>
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
