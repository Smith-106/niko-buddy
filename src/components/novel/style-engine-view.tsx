import { useEffect, useState } from "react"
import { loadWritingStyleStore, setEnabledWritingStyle } from "@/lib/novel"
import type { WritingStylePreset } from "@/lib/novel"
import { WikiReader } from "@/components/editor/wiki-reader"

export interface StyleEngineViewProps {
  projectPath: string
}

/** 预览取前 2 段样本，与 style-profile-sidecar 的 MAX_SAMPLES 对齐。 */
const MAX_PREVIEW_SAMPLES = 2

/**
 * 预设预览文本（本地渲染）。
 *
 * 缺口：barrel（src/lib/novel/index.ts）未导出 renderStyleProfileSidecar /
 * StyleProfileSidecarInput，组件不得 deep import @/lib/novel/*，故此处按
 * sidecar 版式（标题 / 源作品 / 风格宪法 / 关键维度 / 模仿锚点）本地渲染；
 * barrel 补齐导出后应切回
 * renderStyleProfileSidecar({ styleProfile: preset.profile, sourceBook: preset.sourceBook })。
 */
function renderPresetPreview(preset: WritingStylePreset): string {
  const lines: string[] = ["# 风格预设预览", `预设：${preset.name}`]
  if (preset.sourceBook) {
    lines.push(`源作品：${preset.sourceBook}`)
  }
  const constitution = (preset.profile.constitution || "").trim()
  if (constitution) {
    lines.push("", "## 风格宪法（硬约束）", constitution)
  }
  const dimensions: Array<{ label: string; value: string }> = [
    { label: "叙事视角", value: preset.profile.narrativeVoice },
    { label: "对白风格", value: preset.profile.dialogueStyle },
    { label: "句式特征", value: preset.profile.sentenceStyle },
  ]
  const kept = dimensions.filter((entry) => entry.value && entry.value.trim())
  if (kept.length > 0) {
    lines.push("", "## 关键维度")
    for (const entry of kept) {
      lines.push(`- ${entry.label}：${entry.value.trim()}`)
    }
  }
  const samples = (preset.profile.samples ?? [])
    .filter((sample) => sample && sample.trim())
    .slice(0, MAX_PREVIEW_SAMPLES)
  if (samples.length > 0) {
    lines.push("", "## 模仿锚点（few-shot）")
    for (const sample of samples) {
      lines.push("", "```", sample.trim(), "```")
    }
  }
  return lines.join("\n")
}

function findSelected(
  presets: WritingStylePreset[],
  selectedId: string | null,
  enabledId: string | null,
): WritingStylePreset | null {
  const ids: Array<string | null> = [selectedId, enabledId]
  for (const id of ids) {
    if (!id) continue
    const hit = presets.find((preset) => preset.id === id)
    if (hit) return hit
  }
  return presets.length > 0 && presets[0] ? presets[0] : null
}

/**
 * 写法引擎视图：风格预设管理。
 *
 * 数据源走 barrel（@/lib/novel）：loadWritingStyleStore 只读装载全量 store
 * （含 styles 列表 + enabledStyleId，不触盘）驱动列表刷新；
 * setEnabledWritingStyle 仅由用户显式切换启用时调用（内部经 saveWritingStyleStore 落盘
 * <projectPath>/.niko-buddy/writing-style.json）。装载分支零写盘（BGH-20261019 M3）。
 */
export function StyleEngineView({ projectPath }: StyleEngineViewProps) {
  const [presets, setPresets] = useState<WritingStylePreset[]>([])
  const [enabledId, setEnabledId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  useEffect(() => {
    let cancelled = false
    async function refresh() {
      if (!projectPath) {
        setPresets([])
        setEnabledId(null)
        setSelectedId(null)
        setLoading(false)
        return
      }
      setLoading(true)
      setError("")
      try {
        const store = await loadWritingStyleStore(projectPath)
        if (cancelled) return
        setPresets(store.styles)
        setEnabledId(store.enabledStyleId)
        setSelectedId((current) => {
          if (current && store.styles.some((preset) => preset.id === current)) return current
          if (store.enabledStyleId) return store.enabledStyleId
          const first = store.styles.length > 0 && store.styles[0] ? store.styles[0] : null
          return first ? first.id : null
        })
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error && err.message ? err.message : "风格预设加载失败，请检查项目文件权限后重试")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void refresh()
    return () => {
      cancelled = true
    }
  }, [projectPath])

  async function handleToggle(preset: WritingStylePreset, nextEnabled: boolean) {
    if (saving) return
    setSaving(true)
    setError("")
    setNotice("")
    try {
      const store = await setEnabledWritingStyle(projectPath, nextEnabled ? preset.id : null)
      setPresets(store.styles)
      setEnabledId(store.enabledStyleId)
      setNotice(nextEnabled ? `已启用风格预设「${preset.name}」` : `已关闭风格预设「${preset.name}」的启用`)
    } catch (err) {
      // 写盘失败显式报错，不静默吞错；启用态保持原值。
      setError(err instanceof Error && err.message ? err.message : "风格预设保存失败，请检查项目文件权限后重试")
    } finally {
      setSaving(false)
    }
  }

  const selected = findSelected(presets, selectedId, enabledId)
  const enabledPreset = enabledId ? (presets.find((preset) => preset.id === enabledId) ?? null) : null

  return (
    <div data-testid="style-engine-view" className="flex h-full flex-col">
      <div className="shrink-0 border-b p-4">
        <div className="text-lg font-semibold">写法引擎 · 风格预设</div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          从拆书提取的文风预设：启用后写入生成上下文；同一时间只启用一份。共 {presets.length} 份预设，
          {enabledPreset ? `当前启用：${enabledPreset.name}` : "当前未启用任何风格预设"}。
        </p>
      </div>

      {error && (
        <div role="alert" data-testid="style-error" className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="shrink-0 border-b px-4 py-2 text-sm text-muted-foreground">
          {notice}
        </div>
      )}

      {loading ? (
        <div className="p-6 text-sm text-muted-foreground">正在加载风格预设…</div>
      ) : presets.length === 0 ? (
        <div data-testid="style-empty" className="m-6 rounded-lg border border-dashed p-6 text-sm leading-6 text-muted-foreground">
          暂无风格预设。先在拆书分析中提取文风，预设会保存在 writing-style.json，之后可在这里启用并预览。
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside className="flex w-72 shrink-0 flex-col border-r bg-muted/30">
            <div className="shrink-0 border-b px-4 py-2 text-sm font-medium">风格预设列表</div>
            <ul data-testid="style-list" className="flex-1 overflow-y-auto p-2">
              {presets.map((preset) => {
                const isEnabled = preset.id === enabledId
                const isSelected = selected !== null && preset.id === selected.id
                return (
                  <li key={preset.id} data-testid="style-item" className="mb-1">
                    <div className={`rounded-md px-3 py-2 ${isSelected ? "qm-selected" : "qm-hover"}`}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(preset.id)}
                        aria-pressed={isSelected}
                        className="w-full text-left"
                      >
                        <span className="block text-sm font-medium">{preset.name}</span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground">《{preset.sourceBook}》</span>
                        {isEnabled && (
                          <span className="mt-1 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                            已启用
                          </span>
                        )}
                      </button>
                      <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          role="switch"
                          aria-checked={isEnabled}
                          aria-label={`启用风格预设「${preset.name}」`}
                          checked={isEnabled}
                          disabled={saving}
                          onChange={(event) => void handleToggle(preset, event.target.checked)}
                        />
                        启用
                      </label>
                    </div>
                  </li>
                )
              })}
            </ul>
          </aside>
          <main className="flex-1 overflow-y-auto p-6">
            {selected ? (
              <div data-testid="style-preview" className="mx-auto max-w-3xl space-y-3">
                <div className="text-sm font-medium">
                  预览：{selected.name}（《{selected.sourceBook}》）
                </div>
                <div className="whitespace-pre-wrap rounded-md border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">
                  <WikiReader body={renderPresetPreview(selected)} />
                </div>
              </div>
            ) : null}
          </main>
        </div>
      )}
    </div>
  )
}
