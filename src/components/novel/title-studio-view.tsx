/**
 * title-studio-view.tsx — 标题工坊视图（机械筛选，无 LLM 许诺）。
 *
 * ## 职责
 *   - 读取 `.novel/asset-library/title_seed.json` 的种子条目（经 barrel 的
 *     `loadAssetLibraryArtifact`，与 asset-library-store 同款磁盘归口）；
 *   - 展示种子模式列表（pattern＋constraints）；
 *   - 候选标题输入（多行文本，每行一个候选）＋「筛选」按钮调纯函数
 *     `forgeTitles`，输出通过/淘汰两组结果＋逐条命中明细；
 *   - 无种子时诚实空态（不造条目、不许诺生成效果）。
 *
 * ## 边界
 *   - 机械层（ADR-19）：筛选是「候选标题须含锚点子串」机械判据，零模型调用；
 *     本视图不生成标题，只做可证筛选。
 *   - 快照说明：`loadAssetLibrarySnapshot` 只给计数/守恒/健康、不含种子条目，
 *     故种子行取自同一文件的 `loadAssetLibraryArtifact`（同一磁盘真源）。
 *
 * 中文标签直书（与 asset-library-view 同款约定，零新增 i18n 键）。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import {
  forgeTitles,
  loadAssetLibraryArtifact,
  TITLE_SEED_ENTRY_SCHEMA,
  type TitleForgeReport,
  type TitleSeedEntry,
} from "@/lib/novel"
import { toErrorMessage } from "@/lib/utils"

export interface TitleStudioViewProps {
  readonly projectPath: string
}

/**
 * artifact 条目收窄为标题种子（BGH-20261019 m9/MINOR-2：改走真源 schema 规范化入口；
 * `passthrough()` 容忍历史脏字段，失败项丢弃不猜；已知的可选字段 projectId/modelHint
 * 透传保留，其余未知键剥离不渲染）。
 */
function toTitleSeedEntry(entry: unknown): TitleSeedEntry | null {
  const parsed = TITLE_SEED_ENTRY_SCHEMA.passthrough().safeParse(entry)
  if (!parsed.success) return null
  const { entryId, pattern, constraints, examples, projectId, modelHint } = parsed.data
  return { entryId, pattern, constraints, examples, projectId, modelHint }
}

/** 淘汰/通过原因码 → 中文（machine-readable 原因码保留展示，可对账）。 */
function reasonLabel(reason: string): string {
  if (reason === "no_seed_pattern_match") return "未命中任何种子模式"
  if (reason === "below_min_constraint_hits") return "约束命中数不足"
  if (reason === "admitted") return "通过"
  return reason
}

export function TitleStudioView({ projectPath }: TitleStudioViewProps) {
  const [seeds, setSeeds] = useState<readonly TitleSeedEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [report, setReport] = useState<TitleForgeReport | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    if (!projectPath) {
      setSeeds([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    void loadAssetLibraryArtifact(projectPath, "title_seed")
      .then((artifact) => {
        if (cancelled) return
        const entries = artifact === null ? [] : artifact.entries
        const normalized: TitleSeedEntry[] = []
        for (const entry of entries) {
          const seed = toTitleSeedEntry(entry)
          if (seed !== null) normalized.push(seed)
        }
        setSeeds(normalized)
      })
      .catch((error) => {
        // 装载失败：不臆造种子，落诚实空态并展示原因。
        if (cancelled) return
        setSeeds([])
        setLoadError(toErrorMessage(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const seedList = seeds ?? []
  const hasSeeds = seedList.length > 0

  const runFilter = () => {
    const lines = draft.split("\n")
    const candidates: Array<{ candidateId: string; title: string }> = []
    for (let index = 0; index < lines.length; index += 1) {
      const title = (lines[index] ?? "").trim()
      if (title.length === 0) continue
      candidates.push({ candidateId: `candidate-${candidates.length + 1}`, title })
    }
    if (candidates.length === 0) {
      setReport(null)
      setHint("请先输入候选标题（每行一个）。")
      return
    }
    setHint(null)
    // 机械筛选：纯函数 forgeTitles，零模型调用；ts 由调用方（本视图）注入。
    setReport(forgeTitles({ candidates, seeds: seedList, ts: new Date().toISOString() }))
  }

  const renderGroup = (admitted: boolean) => {
    const rows = (report?.rows ?? []).filter((row) => row.admitted === admitted)
    const testId = admitted ? "title-admitted" : "title-rejected"
    const heading = admitted ? `通过（${rows.length}）` : `淘汰（${rows.length}）`
    return (
      <section data-testid={testId} className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">{heading}</h3>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">无</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li
                key={row.candidateId}
                data-testid={`title-row-${row.candidateId}`}
                className="rounded-md border border-border bg-background px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{row.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {`命中种子 ${row.seedMatchCount} · 命中约束 ${row.totalConstraintHits} · ${reasonLabel(row.reason)}`}
                    <code className="ml-1 font-mono text-[11px]">{row.reason}</code>
                  </span>
                </div>
                <ul className="mt-1 flex flex-col gap-1 pl-4 text-xs text-muted-foreground">
                  {row.seedRows.map((seedRow) => (
                    <li key={seedRow.seedEntryId}>
                      <span>
                        {`种子 ${seedRow.seedEntryId}：模式${seedRow.patternMatched ? "命中" : "未命中"} · 约束 ${seedRow.matchedCount}/${seedRow.totalCount}`}
                      </span>
                      {seedRow.constraintChecks.length > 0 ? (
                        <ul className="list-disc pl-5">
                          {seedRow.constraintChecks.map((check) => (
                            <li key={`${seedRow.seedEntryId}:${check.constraint}`}>
                              {`${check.hit ? "命中" : "缺失"}约束锚「${check.constraint}」`}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }

  return (
    <section data-testid="title-studio-view" className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">标题工坊（机械筛选 · 无模型调用）</h2>
        <p className="text-xs text-muted-foreground">
          候选标题按标题种子 constraints 做机械命中筛选（标题须含锚点子串）。本页不生成标题、不调用模型，只输出通过/淘汰＋逐条命中证据。
        </p>
      </div>
      {loading ? (
        <p data-testid="title-loading" className="text-xs text-muted-foreground">
          正在读取标题种子…
        </p>
      ) : null}
      {!loading && loadError ? (
        <p data-testid="title-error" className="text-xs text-red-700 dark:text-red-300">
          读取失败：{loadError}
        </p>
      ) : null}
      {!loading && !hasSeeds ? (
        <p data-testid="title-empty" className="text-xs text-muted-foreground">
          暂无标题种子（title_seed 库未生成或为空），无法筛选。请先生成标题种子后再试。
        </p>
      ) : null}
      {!loading && hasSeeds ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">种子模式（{seedList.length}）</h3>
          <ul data-testid="title-seeds" className="flex flex-col gap-2">
            {seedList.map((seed) => (
              <li
                key={seed.entryId}
                data-testid={`title-seed-${seed.entryId}`}
                className="rounded-md border border-border bg-background px-3 py-2 text-xs"
              >
                <div className="text-sm font-medium text-foreground">{`模式：${seed.pattern}`}</div>
                <div className="mt-0.5 text-muted-foreground">
                  {seed.constraints.length > 0
                    ? `约束：${seed.constraints.join(" / ")}`
                    : "无约束（仅按模式命中）"}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label htmlFor="title-studio-input" className="text-sm font-medium text-foreground">
          候选标题（每行一个）
        </label>
        <textarea
          id="title-studio-input"
          data-testid="title-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={6}
          placeholder={"江湖剑恩仇传\n星际远航"}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
        />
      </div>
      <div>
        <button
          type="button"
          data-testid="title-filter"
          onClick={runFilter}
          disabled={loading || !hasSeeds}
          className="rounded border border-border px-3 py-1 text-sm"
        >
          筛选
        </button>
      </div>
      {hint ? (
        <p data-testid="title-hint" className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {report ? (
        <div data-testid="title-result" className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {`共 ${report.rows.length} 个候选：通过 ${report.admitted.length} · 淘汰 ${report.rejected.length}（机械判据，可按约束逐条对账）`}
          </p>
          {renderGroup(true)}
          {renderGroup(false)}
        </div>
      ) : null}
    </section>
  )
}
