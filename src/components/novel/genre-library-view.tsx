/**
 * genre-library-view.tsx — 题材基底库视图（只读浏览）。
 *
 * ## 职责
 *   - 男女频切换 + 主分类 → 子类型树浏览（子类型只渲染 label，不写盘）；
 *   - 本项目 `.novel/asset-library/genre_base.json` 快照状态
 *    （present / 条目数 / 内容哈希），缺失时诚实标注「未生成」，绝不造条目。
 *
 * ## 数据源
 *   - 静态分类树：barrel 转出的 `CHANNELS`（真源 `src/lib/novel/outline-genres.ts`
 *    男频 18 + 女频 18 主分类静态树；BGH-20261019 m5 已删除本地内嵌快照）；
 *   - 项目快照：barrel 转出的 `loadAssetLibrarySnapshot(projectPath, "genre_base")`
 *    （见 `src/lib/novel/asset-library-store.ts`，缺失 → present:false）。
 *
 * ## 缺口记录（2026-10-19，纪律：走 barrel、不 deep import `@/lib/novel/*`）
 *   - BGH-20261019 m5 已解决：`outline-genres.ts` 补 `export CHANNELS` + barrel 转出，
 *     本视图改从 `@/lib/novel` 导入，内嵌快照与 max-len 豁免已删除。
 *
 * 中文 UI；只读（切换频道/分类只改本地 state，不写盘）。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import { BookOpen, Database, Loader2 } from "lucide-react"
import { CHANNELS, loadAssetLibrarySnapshot, type AssetLibrarySnapshot, type ChannelGenre, type MainGenre, type SubGenre } from "@/lib/novel"

/** 频道（男频 / 女频）——真源 `outline-genres.ts` 经 barrel 转出（BGH-20261019 m5）。 */
type GenreChannel = ChannelGenre
type GenreMainCategory = MainGenre
type GenreSubType = SubGenre



export interface GenreLibraryViewProps {
  /** 项目根路径（快照装载用 `{projectPath}/.novel/asset-library/genre_base.json`）。 */
  readonly projectPath: string
  /** 显式注入快照（测试/预览优先；提供后跳过磁盘装载）。 */
  readonly snapshot?: AssetLibrarySnapshot | null
}

type ChannelKey = "male" | "female"

function channelByKey(key: ChannelKey): GenreChannel {
  for (const channel of CHANNELS) {
    if (channel.key === key) return channel
  }
  const fallback = CHANNELS.find((channel) => channel.key === "male")
  if (!fallback) throw new Error("genre channels missing")
  return fallback
}

function firstMainKeyOf(channel: GenreChannel): string {
  if (channel.mainGenres.length === 0) return ""
  return channel.mainGenres[0].key
}

function countSubTypes(channel: GenreChannel): number {
  let total = 0
  for (const main of channel.mainGenres) total += main.subGenres.length
  return total
}

export function GenreLibraryView({ projectPath, snapshot: snapshotOverride }: GenreLibraryViewProps) {
  const [channelKey, setChannelKey] = useState<ChannelKey>("male")
  const channel = channelByKey(channelKey)
  const [mainKey, setMainKey] = useState<string>(() => firstMainKeyOf(channelByKey("male")))
  const [snapshot, setSnapshot] = useState<AssetLibrarySnapshot | null>(snapshotOverride ?? null)
  const [loading, setLoading] = useState(snapshotOverride === undefined && projectPath !== "")

  const switchChannel = (next: ChannelKey) => {
    setChannelKey(next)
    setMainKey(firstMainKeyOf(channelByKey(next)))
  }

  useEffect(() => {
    if (snapshotOverride !== undefined) {
      setSnapshot(snapshotOverride)
      setLoading(false)
      return
    }
    if (projectPath === "") {
      setSnapshot(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void loadAssetLibrarySnapshot(projectPath, "genre_base")
      .then((result) => {
        if (!cancelled) setSnapshot(result)
      })
      .catch(() => {
        // 装载失败不臆造条目：落诚实空态（显示「未生成」）。
        if (!cancelled) setSnapshot(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectPath, snapshotOverride])

  let selectedMain: GenreMainCategory | null = null
  for (const main of channel.mainGenres) {
    if (main.key === mainKey) selectedMain = main
  }
  if (selectedMain === null && channel.mainGenres.length > 0) selectedMain = channel.mainGenres[0]
  const subTypes: readonly GenreSubType[] = selectedMain === null ? [] : selectedMain.subGenres

  const snapshotError = snapshot !== null && !snapshot.present ? (snapshot.error ?? null) : null

  return (
    <section data-testid="genre-library-view" className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <BookOpen className="h-4 w-4" />
          题材基底库（只读浏览）
        </h2>
        <div className="flex items-center gap-2" role="group" aria-label="频道切换">
          {CHANNELS.map((item) => (
            <button
              key={item.key}
              type="button"
              data-testid={`genre-channel-${item.key}`}
              aria-pressed={item.key === channelKey}
              onClick={() => switchChannel(item.key)}
              className="rounded border border-border px-2 py-1 text-xs"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        静态分类树来自大纲生成器（男频 18 主分类 · 女频 18 主分类），子类型只展示名称；
        本页只读，不写盘、不改产物。
      </p>

      <div data-testid="genre-snapshot" className="rounded-md border border-border bg-background px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Database className="h-3.5 w-3.5" />
          本项目题材基底快照
          <span className="font-mono text-[11px] text-muted-foreground">genre_base.json</span>
        </div>
        {loading ? (
          <p data-testid="genre-snapshot-loading" className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            正在读取题材基底库…
          </p>
        ) : snapshot !== null && snapshot.present ? (
          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <div className="flex gap-1">
              <dt>状态：</dt>
              <dd data-testid="genre-snapshot-present">已生成</dd>
            </div>
            <div className="flex gap-1">
              <dt>条目数：</dt>
              <dd data-testid="genre-snapshot-count">{snapshot.entryCount} 条</dd>
            </div>
            <div className="flex gap-1">
              <dt>内容哈希：</dt>
              <dd data-testid="genre-snapshot-hash" className="font-mono">
                {snapshot.contentHash ?? "未知"}
              </dd>
            </div>
          </dl>
        ) : (
          <div className="mt-1">
            <p data-testid="genre-empty" className="text-xs text-muted-foreground">
              未生成
              {projectPath === ""
                ? "（未指定项目路径）"
                : "（本项目尚未生成 `.novel/asset-library/genre_base.json`）"}
            </p>
            {snapshotError !== null ? (
              <p data-testid="genre-snapshot-error" className="mt-1 text-xs text-red-700 dark:text-red-300">
                读取失败：{snapshotError}
              </p>
            ) : null}
          </div>
        )}
      </div>

      <div data-testid="genre-tree" className="flex flex-col gap-2">
        <p data-testid="genre-tree-summary" className="text-xs text-muted-foreground">
          {channel.label}：{channel.mainGenres.length} 主分类 · {countSubTypes(channel)} 子类型
        </p>
        <ul className="flex flex-wrap gap-1.5" aria-label="主分类">
          {channel.mainGenres.map((main) => (
            <li key={main.key}>
              <button
                type="button"
                data-testid={`genre-main-${main.key}`}
                aria-pressed={main.key === (selectedMain !== null ? selectedMain.key : "")}
                onClick={() => setMainKey(main.key)}
                className="rounded border border-border px-2 py-1 text-xs"
              >
                {main.label}（{main.subGenres.length}）
              </button>
            </li>
          ))}
        </ul>
        {selectedMain !== null ? (
          <div className="rounded-md border border-border bg-background px-3 py-2">
            <p data-testid="genre-selected-main" className="text-sm font-medium text-foreground">
              {selectedMain.label}
            </p>
            <ul className="mt-1 flex flex-wrap gap-1.5" aria-label={`${selectedMain.label}子类型`}>
              {subTypes.map((sub) => (
                <li
                  key={sub.key}
                  data-testid={`genre-sub-${sub.key}`}
                  className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                >
                  {sub.label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  )
}
