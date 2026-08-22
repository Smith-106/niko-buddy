/**
 * technique-panel.tsx — F-08 技法面板
 *
 * 展示 technique-compiler 的规则包注册表与钩子类型注册表，以及
 * 各规则包的 canon 字段目标、参数、提示词块。
 *
 * 数据源：只读消费 T27b technique-compiler 纯算术输出，不修改上游模块。
 * 分组：与 review-center-view 子面板 tab 集成，不新增 activeView。
 */
import { useMemo, useState, useId } from "react"
import { useTranslation } from "react-i18next"
import { BookOpen, ChevronDown, ChevronRight, Puzzle, Table2 } from "lucide-react"
import type { CompiledTechniqueRegistry, TechniqueRulePack, HookTypeEntry } from "@/lib/novel/craft/technique-compiler"

// ============================================================================
// 单包展开折叠卡片
// ============================================================================

interface PackCardProps {
  pack: TechniqueRulePack
  defaultExpanded?: boolean
}

function PackCard({ pack, defaultExpanded = false }: PackCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div className="rounded-lg border bg-card">
      {/* 包头部 */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/30"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground">{pack.techniqueName}</span>
            <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {pack.packId}
            </code>
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {pack.canonFieldTargets.length} 个 canon 字段 · {pack.promptBlocks.length} 条提示词块 · {Object.keys(pack.params).length} 个参数
          </div>
        </div>
      </button>

      {/* 展开内容 */}
      {expanded && (
        <div className="border-t px-3 py-2.5 space-y-3">
          {/* Canon 字段目标 */}
          <div>
            <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
              <Table2 className="h-3 w-3" aria-hidden="true" />
              Canon 字段目标
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {pack.canonFieldTargets.map((target) => (
                <code
                  key={`${target.table}.${target.field}`}
                  className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-foreground"
                >
                  {target.table}.{target.field}
                </code>
              ))}
            </div>
          </div>

          {/* 参数 */}
          <div>
            <div className="text-[10px] font-medium text-muted-foreground">参数</div>
            <div className="mt-1 space-y-0.5">
              {Object.entries(pack.params).map(([key, value]) => (
                <div key={key} className="flex items-start gap-2 text-[10px]">
                  <code className="shrink-0 text-muted-foreground">{key}</code>
                  <span className="text-foreground break-all">
                    {Array.isArray(value)
                      ? value.join(", ")
                      : String(value)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 提示词块 */}
          <div>
            <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
              <BookOpen className="h-3 w-3" aria-hidden="true" />
              提示词块 ({pack.promptBlocks.length})
            </div>
            <div className="mt-1 space-y-2">
              {pack.promptBlocks.map((block) => (
                <div key={block.blockId} className="rounded border border-border/50 bg-muted/10 p-2">
                  <div className="flex items-center gap-2">
                    <code className="text-[10px] text-muted-foreground">{block.blockId}</code>
                    <span className="rounded bg-primary/10 px-1 py-0.5 text-[9px] font-medium text-primary">
                      {block.injectionPoint}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-foreground">
                    {block.title}
                  </p>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                    {block.body}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* 溯源 */}
          <div className="text-[9px] text-muted-foreground">
            快照版本: {pack.sourceSnapshotVersion} · 记忆源: {pack.sourceMemoryIds.join(", ")}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// 钩子类型表格
// ============================================================================

interface HookTypeTableProps {
  entries: readonly HookTypeEntry[]
}

function HookTypeTable({ entries }: HookTypeTableProps) {
  if (entries.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center text-xs text-muted-foreground">
        暂无钩子类型注册
      </div>
    )
  }

  const edges = entries.filter((e) => e.mountPoint === "edges")
  const episodes = entries.filter((e) => e.mountPoint === "episodes")

  return (
    <div className="space-y-3">
      {/* 开端钩子 */}
      {edges.length > 0 && (
        <div>
          <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">
            开端钩子 (edges.hook_type, {edges.length} 型)
          </div>
          <div className="flex flex-wrap gap-1">
            {edges.map((entry) => (
              <span
                key={entry.hookType}
                className="rounded border border-border/50 bg-muted/20 px-2 py-0.5 text-[10px] text-foreground"
                title={`溯源: ${entry.sourceMemoryId}`}
              >
                {entry.labelZh}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 章末钩子 */}
      {episodes.length > 0 && (
        <div>
          <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">
            章末钩子 (episodes.hook_type, {episodes.length} 型)
          </div>
          <div className="flex flex-wrap gap-1">
            {episodes.map((entry) => (
              <span
                key={entry.hookType}
                className="rounded border border-border/50 bg-muted/20 px-2 py-0.5 text-[10px] text-foreground"
                title={`溯源: ${entry.sourceMemoryId}`}
              >
                {entry.labelZh}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Props
// ============================================================================

export interface TechniquePanelProps {
  /** 技法编译器注册表（T27b technique-compiler 输出）。缺省时显示空状态。 */
  registry?: CompiledTechniqueRegistry | null
}

// ============================================================================
// 主组件
// ============================================================================

export function TechniquePanel({ registry }: TechniquePanelProps) {
  const { t } = useTranslation()
  const headingId = useId()
  const [selectedPackIndex] = useState<number | null>(null)

  // 按包名排序
  const sortedPacks = useMemo(() => {
    if (!registry) return []
    return [...registry.packs].sort((a, b) => a.packId.localeCompare(b.packId))
  }, [registry])

  if (!registry) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center text-sm text-muted-foreground">
        <Puzzle className="mb-2 h-8 w-8 opacity-40" aria-hidden="true" />
        <p>{t("craft.techniquePanel.noData", "暂无技法数据，请先编译技法规则包")}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4" role="region" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-sm font-semibold text-foreground">
        {t("craft.techniquePanel.title", "技法面板")}
      </h3>

      {/* 概览统计 */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border bg-card p-2.5 text-center">
          <div className="text-lg font-bold text-foreground">{registry.packs.length}</div>
          <div className="text-[10px] text-muted-foreground">规则包</div>
        </div>
        <div className="rounded-lg border bg-card p-2.5 text-center">
          <div className="text-lg font-bold text-foreground">{registry.hookTypeRegistry.length}</div>
          <div className="text-[10px] text-muted-foreground">钩子类型</div>
        </div>
        <div className="rounded-lg border bg-card p-2.5 text-center">
          <div className="text-lg font-bold text-foreground">v{registry.snapshotVersion}</div>
          <div className="text-[10px] text-muted-foreground">快照版本</div>
        </div>
      </div>

      {/* 钩子类型注册表 */}
      <div className="rounded-lg border bg-card p-2.5">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
          钩子类型注册表
        </div>
        <HookTypeTable entries={registry.hookTypeRegistry} />
      </div>

      {/* 规则包列表 */}
      <div>
        <div className="mb-2 text-[11px] font-medium text-muted-foreground">
          规则包详情 ({sortedPacks.length} 包)
        </div>
        <div className="space-y-2">
          {sortedPacks.map((pack, idx) => (
            <PackCard
              key={pack.packId}
              pack={pack}
              defaultExpanded={selectedPackIndex === idx}
            />
          ))}
        </div>
      </div>
    </div>
  )
}