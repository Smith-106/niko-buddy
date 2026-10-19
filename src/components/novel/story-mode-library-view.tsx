/**
 * story-mode-library-view.tsx — 推进模式库视图（只读浏览）。
 *
 * ## 职责
 *   - 只读展示本项目节奏模式库（`.novel/asset-library/pacing_pattern.json`）：
 *     每张推进模式卡片 = displayName + phases 阶段名 + 出入场门；
 *   - 快照状态诚实呈现：缺失标「未生成」，损坏显失败原因，绝不臆造模式；
 *   - 条目过 `normalizeAdvanceMode` 复核（含重复 phase key 拒绝）；
 *     复核失败的条目 fail-loud 单列，不整页崩。
 *
 * ## 边界
 *   - 纯浏览：不写盘、不迁移、不新增模式；
 *   - 数据源：`loadAssetLibrarySnapshot`（计数/守恒/健康）+
 *     `loadAssetLibraryArtifact`（条目回显），均走 `@/lib/novel` barrel，
 *     不 deep import；
 *   - 门中文名本地映射（本视图展示变体，见 GATE_LABEL 注释；键空间与
 *     audit-taxonomy GateKey 一致，未知键回退原文）：
 *
 * 中文标签直书（与 asset-library-view 同款约定，零新增 i18n 键）。
 *
 * barrel 说明：`@/lib/novel` 未导出 `GateKey` / `GATE_MAPPING`
 * （`src/lib/novel/audit-taxonomy.ts`），且本视图标签为刻意展示变体
 * （设定一致性/反 AI 味/文学质量，spec 锁定），与 GATE_MAPPING.label 不逐字绑定；
 * 故保留本地 `GATE_LABEL` 映射（MINOR-5 定案，非漂移）。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import { AlertTriangle, CheckCircle2, Layers, Loader2, Lock } from "lucide-react"
import {
  loadAssetLibraryArtifact,
  loadAssetLibrarySnapshot,
  normalizeAdvanceMode,
  type AdvanceMode,
  type AssetLibrarySnapshot,
} from "@/lib/novel"

/**
 * 门中文名（本视图刻意展示变体：设定一致性/反 AI 味/文学质量，spec 锁定；
 * 键空间与 audit-taxonomy GateKey 一致，未知键回退原文。MINOR-5 定案）。
 */
const GATE_LABEL: Record<string, string> = {
  consistency: "设定一致性",
  anti_ai: "反 AI 味",
  quality: "文学质量",
}

/** 门列表中文串（空门显「无」，未知键回退原文，不臆造）。 */
function gateText(gates: readonly string[]): string {
  if (gates.length === 0) return "无"
  const parts: string[] = []
  for (const gate of gates) {
    const label = GATE_LABEL[gate] ?? gate
    parts.push(label === gate ? gate : `${label}（${gate}）`)
  }
  return parts.join("、")
}

export interface StoryModeLibraryViewProps {
  readonly projectPath: string
}

interface StoryModeLibraryState {
  readonly snapshot: AssetLibrarySnapshot | null
  readonly modes: readonly AdvanceMode[]
  readonly invalidEntries: readonly string[]
}

function emptyState(): StoryModeLibraryState {
  return { snapshot: null, modes: [], invalidEntries: [] }
}

export function StoryModeLibraryView({ projectPath }: StoryModeLibraryViewProps) {
  const [state, setState] = useState<StoryModeLibraryState>(() => emptyState())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!projectPath) {
      setState(emptyState())
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const snapshot = await loadAssetLibrarySnapshot(projectPath, "pacing_pattern")
        const artifact = await loadAssetLibraryArtifact(projectPath, "pacing_pattern")
        const modes: AdvanceMode[] = []
        const invalidEntries: string[] = []
        if (artifact !== null) {
          for (let index = 0; index < artifact.entries.length; index += 1) {
            try {
              modes.push(normalizeAdvanceMode(artifact.entries[index]))
            } catch (err) {
              invalidEntries.push(
                `条目[${index}]契约违反：${err instanceof Error ? err.message : String(err)}`,
              )
            }
          }
        }
        if (!cancelled) setState({ snapshot, modes, invalidEntries })
      } catch {
        // 装载失败：不臆造模式，落诚实空态（快照区显示「未生成」）。
        if (!cancelled) setState(emptyState())
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const snapshot = state.snapshot
  const present = snapshot !== null && snapshot.present
  const error = snapshot !== null ? snapshot.error : undefined

  return (
    <section data-testid="story-mode-library-view" className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Layers className="h-4 w-4" />
          推进模式库（只读浏览）
        </h2>
        <span data-testid="story-mode-summary" className="text-xs text-muted-foreground">
          {loading ? "读取中…" : `共 ${state.modes.length} 个推进模式`}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        模式来自 <code className="font-mono">.novel/asset-library/pacing_pattern.json</code>
        （生成器产物，只读呈现）。阶段进出以既有三门裁定为准，本页不提供手改入口。
      </p>
      <div
        data-testid="story-mode-snapshot"
        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
      >
        <span className="flex items-center gap-1 text-muted-foreground">
          <Lock className="h-3 w-3" />
          本项目 pacing_pattern 快照：
        </span>
        {loading ? (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            正在读取快照…
          </span>
        ) : present && snapshot !== null ? (
          <>
            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
              已生成 {snapshot.entryCount} 个模式
            </span>
            {snapshot.conserved ? (
              <span className="flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
                <CheckCircle2 className="h-3 w-3" />
                守恒校验通过
              </span>
            ) : (
              <span className="flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-red-900 dark:bg-red-950/40 dark:text-red-200">
                <AlertTriangle className="h-3 w-3" />
                守恒失配（疑似手工篡改）
              </span>
            )}
          </>
        ) : error ? (
          <span className="text-red-700 dark:text-red-300">读取失败：{error}</span>
        ) : (
          <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
            未生成（pacing_pattern.json 缺失）
          </span>
        )}
      </div>
      {loading ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在读取推进模式…
        </p>
      ) : (
        <>
          <ul data-testid="story-mode-list" className="flex flex-col gap-2">
            {state.modes.map((mode) => (
              <li
                key={mode.modeId}
                data-testid={`story-mode-card-${mode.modeId}`}
                className="rounded-md border border-border bg-background px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{mode.displayName}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{mode.modeId}</span>
                </div>
                <ol className="mt-1 flex flex-col gap-1 pl-1">
                  {mode.phases.map((phase, phaseIndex) => (
                    <li
                      key={phase.key}
                      data-testid={`story-mode-phase-${mode.modeId}-${phase.key}`}
                      className="text-xs text-muted-foreground"
                    >
                      <span className="text-foreground">
                        阶段{phaseIndex + 1}：{phase.name}
                      </span>
                      <span className="font-mono text-[11px]">（{phase.key}）</span>
                      <span>
                        入场门：{gateText(phase.entryGates)}；出场门：{gateText(phase.exitGates)}
                      </span>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
          {state.modes.length === 0 ? (
            <p data-testid="story-mode-empty" className="text-xs text-muted-foreground">
              {present
                ? "暂无可展示的推进模式（条目缺失或校验未通过，见快照状态）"
                : "本项目尚未生成节奏模式（pacing_pattern 未生成）"}
            </p>
          ) : null}
          {state.invalidEntries.length > 0 ? (
            <ul
              data-testid="story-mode-invalid"
              className="list-disc pl-5 text-xs text-red-700 dark:text-red-300"
            >
              {state.invalidEntries.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  )
}
