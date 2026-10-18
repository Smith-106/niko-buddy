import { useMemo, useState } from "react"
import { ListChecks } from "lucide-react"

import { groupPromptRegistry, listPromptRegistry, type PromptRegistryEntry } from "@/lib/novel"

/**
 * 提示词注册表（只读）。真源 = `PROMPTS`，本面板只枚举键/场景/参数/占位符预览。
 *
 * 明确不做的两件事（避免"看起来有"的假功能）：
 * 1. **使用点统计**：没有"谁在何处调用"的真源，不估算。
 * 2. **场景组合预览**：需要真实上下文包才能渲染，不在只读面板里伪造。
 */
export interface PromptRegistryPanelProps {
  /** 注入注册表（测试可替换）；默认读 PROMPTS。 */
  readonly entries?: readonly PromptRegistryEntry[]
}

export function PromptRegistryPanel({ entries }: PromptRegistryPanelProps) {
  const resolved = useMemo(() => (entries ? [...entries] : listPromptRegistry()), [entries])
  const groups = useMemo(() => groupPromptRegistry(resolved), [resolved])
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <section data-testid="prompt-registry-panel" className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
        <ListChecks className="h-4 w-4" />
        提示词注册表（{resolved.length} 条 · {groups.length} 个场景）
      </h3>
      <p className="text-[10px] text-muted-foreground" data-testid="prompt-registry-scope">
        预览是用占位符（«argN»）做的一次哨兵渲染，不是真实上下文；真值哨兵会绕过空值分支，读全局设置的片段（如输出语言指令）也会出现在预览里。
      </p>
      <ul className="flex flex-col gap-2">
        {groups.map((group) => (
          <li key={group.scene} data-testid={`prompt-registry-scene-${group.scene}`}>
            <p className="text-xs font-medium text-foreground">
              {group.scene}（{group.entries.length}）
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.entries.map((entry) => (
                <li key={entry.id} data-testid={`prompt-registry-entry-${entry.id}`} className="text-[11px]">
                  <button
                    type="button"
                    data-testid={`prompt-registry-toggle-${entry.id}`}
                    onClick={() => setExpanded((prev) => (prev === entry.id ? null : entry.id))}
                    className="text-left text-foreground hover:underline"
                  >
                    {`${entry.id} · 检测到 ${entry.slotCount} 个槽位`}
                    {entry.slotCountExceedsDeclared ? `（声明 ${entry.declaredParams}，含默认参数）` : ""}
                    {entry.slotProbeCapped ? " · 可能有剩余参数" : ""}
                    {entry.preview === null
                      ? " · 预览不可用"
                      : entry.truncated
                        ? ` · 预览已截断${entry.missingSlots.length > 0 ? `，窗口内未出现 ${entry.missingSlots.join(" ")}` : ""}`
                        : ""}
                  </button>
                  {expanded === entry.id ? (
                    <pre
                      data-testid={`prompt-registry-preview-${entry.id}`}
                      className="mt-1 whitespace-pre-wrap rounded bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground"
                    >
                      {entry.preview ?? entry.error ?? ""}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <ul className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
        <li data-testid="prompt-registry-na-usage">N/A：使用点统计（无「谁在何处调用」真源，不做估算）</li>
        <li data-testid="prompt-registry-na-compose">N/A：场景组合预览（需真实上下文包，不在只读面板伪造）</li>
      </ul>
    </section>
  )
}
