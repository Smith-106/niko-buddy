import { useMemo } from "react"
import { Activity } from "lucide-react"

import { projectMethodologyUsage, type MethodologyProjection } from "@/lib/novel"

/**
 * 创作方法论生效面板（**只读**）。真源 = 钩子注册表投影（`projectMethodologyUsage()`，
 * 经 `@/lib/novel` barrel 进入 —— boundaries 门禁禁止深导入）。
 *
 * 本组件不写状态、不执行钩子、不调 LLM；**所有计数都来自 projection**（不硬编码）。
 * 缺真源的格子渲染显式中文 N/A（文案写在 UI 里，不改 i18n 资源）。
 */
export interface MethodologyPanelProps {
  /** 注入投影（测试可替换）；默认读钩子注册表。 */
  readonly projection?: MethodologyProjection
}

export function MethodologyPanel({ projection }: MethodologyPanelProps) {
  const resolved = useMemo(() => projection ?? projectMethodologyUsage(), [projection])

  return (
    <section data-testid="methodology-panel" className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
        <Activity className="h-4 w-4" />
        创作方法论生效（只读）
      </h3>
      <p className="text-[10px] text-muted-foreground" data-testid="methodology-panel-scope">
        {`有钩子的阶段 ${resolved.stages.length} 个 · 已启用钩子 ${resolved.enabledHookCount} 个 · 声明钩子 ${resolved.declaredHookCount} 个 · 已知阶段 ${resolved.knownStages.length} 个`}
      </p>
      <p className="text-[10px] text-muted-foreground" data-testid="methodology-panel-boundary">
        本面板只枚举注册表里的声明，不执行钩子、不记录调用；命中次数与 promptHint 无真源，故显式 N/A。
      </p>

      {resolved.stages.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="methodology-panel-empty">
          当前注册表没有声明任何钩子：没有阶段行可展示（不造 0 行假装统计过）。
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {resolved.stages.map((row) => (
            <li
              key={row.stage}
              data-testid={`methodology-stage-${row.stage}`}
              className="rounded border border-border px-2 py-1"
            >
              <p className="text-xs font-medium text-foreground">
                {`${row.stage} · ${row.hookCount} 个钩子`}
                {row.declaredHookCount > row.hookCount
                  ? `（声明 ${row.declaredHookCount}，其中 ${row.declaredHookCount - row.hookCount} 个未启用）`
                  : ""}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {row.hookIds.length > 0
                  ? `钩子：${row.hookIds.join(" ")}`
                  : "钩子：无（该阶段只有未启用钩子）"}
              </p>
              <ul className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
                <li data-testid={`methodology-na-prompt-hint-${row.stage}`}>
                  {row.hasPromptHint === null
                    ? "N/A：是否有 promptHint（NovelSkillHook 无该字段，注册表读不到）"
                    : `promptHint：${row.hasPromptHint ? "有" : "无"}`}
                </li>
                <li data-testid={`methodology-na-trigger-${row.stage}`}>
                  {row.triggerCount === null
                    ? "N/A：命中/触发次数（无埋点真源，不估算、不造 0）"
                    : `命中 ${row.triggerCount} 次`}
                </li>
              </ul>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-0.5">
        <p className="text-[10px] font-medium text-muted-foreground">以下真源不存在，故显式 N/A：</p>
        <ul className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
          {resolved.missingSources.map((reason, index) => (
            <li key={reason} data-testid={`methodology-na-source-${index}`}>
              {`N/A：${reason}`}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
