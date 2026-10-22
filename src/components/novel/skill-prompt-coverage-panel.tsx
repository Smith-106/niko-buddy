import { useMemo } from "react"
import { Table2 } from "lucide-react"

import { buildSkillPromptCoverage, type SkillPromptCoverage } from "@/lib/novel"

/**
 * skills × 提示词对齐覆盖面板（**只读**）。真源经 `@/lib/novel` barrel 进入
 * （boundaries 门禁禁止组件深导入 `@/lib/novel/*`）。
 *
 * 本组件不写状态、不读盘、不执行钩子、不调 LLM；**所有数字都来自 coverage**（不硬编码）。
 * 缺真源的格子渲染显式中文 `N/A`（文案直接写在 UI 里，**不改 i18n 资源**）。
 *
 * 明确不做的三件事（避免「看起来有」的假功能）：
 * 1. **skill ↔ 提示词关联**：既有真源没有该字段，不做关键词猜测；无关联真源时页眉与每个键的覆盖状态都标
 *    显式 N/A（`associationSourceDeclared === false`），只有真给了关联声明才区分 covered / uncovered。
 * 2. **提示词使用点统计**：没有「谁在何处调用」真源，不估算。
 * 3. **项目盘配置**：只读面板不读盘（需 projectPath + 异步 IO），默认投影会话默认配置。
 */
export interface SkillPromptCoveragePanelProps {
  /** 注入覆盖表（测试可替换）；默认调 `buildSkillPromptCoverage()`。 */
  readonly coverage?: SkillPromptCoverage
}

export function SkillPromptCoveragePanel({ coverage }: SkillPromptCoveragePanelProps) {
  const resolved = useMemo(() => coverage ?? buildSkillPromptCoverage(), [coverage])

  return (
    <section data-testid="skill-prompt-coverage-panel" className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
        <Table2 className="h-4 w-4" />
        技能与提示词覆盖（只读）
      </h3>
      <p className="text-[10px] text-muted-foreground" data-testid="skill-prompt-coverage-scope">
        {`技能 ${resolved.skills.length} 个（内建 ${resolved.builtInSkillCount} · 项目 ${resolved.projectSkillCount} · 停用 ${resolved.disabledSkillCount}）· 钩子 ${resolved.hooks.length} 个 · 提示词键 ${resolved.promptKeys.length} 个 · 有覆盖 ${resolved.associationSourceDeclared ? `${resolved.coveredPromptKeyCount} 个` : "不适用（没有关联记录）"} · 未覆盖 ${resolved.associationSourceDeclared ? `${resolved.uncoveredPromptKeys.length} 个` : "不适用（没有关联记录）"}`}
        <span className="sr-only">
          {`skill ${resolved.skills.length} 个（内建 ${resolved.builtInSkillCount} · 项目 ${resolved.projectSkillCount} · 停用 ${resolved.disabledSkillCount}）· 钩子 ${resolved.hooks.length} 个 · 提示词键 ${resolved.promptKeys.length} 个 · 有覆盖 ${resolved.associationSourceDeclared ? `${resolved.coveredPromptKeyCount} 个` : "N/A（无关联真源）"} · uncovered ${resolved.associationSourceDeclared ? `${resolved.uncoveredPromptKeys.length} 个` : "N/A（无关联真源）"}`}
        </span>
      </p>
      <p className="text-[10px] text-muted-foreground" data-testid="skill-prompt-coverage-boundary">
        只列出已经登记的内容：不按关键词猜测技能和提示词的关联、不读盘、不执行钩子；缺资料的格子写不适用。
      </p>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-foreground">{`技能（${resolved.skills.length}）`}</p>
        <ul className="flex flex-col gap-1">
          {resolved.skills.map((row) => (
            <li
              key={row.id}
              data-testid={`skill-prompt-row-${row.id}`}
              className="rounded border border-border px-2 py-1"
            >
              <p className="text-xs text-foreground">
                {`${row.name} · ${row.builtIn ? "内建" : "项目"}`}
                <span className="sr-only">{row.id}</span>
                {row.enabled ? "" : " · 已停用"}
                {row.isDefault ? " · 当前默认" : ""}
                {row.isFactoryDefault ? " · 出厂默认" : ""}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {`声明阶段 ${row.coveredStageCount} 个`}
                <span className="sr-only">{`stage ${row.declaredStages.join(" ")}`}</span>
              </p>
              <ul className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
                <li
                  data-testid={
                    row.promptKeyCount === null
                      ? `skill-prompt-na-prompt-keys-${row.id}`
                      : `skill-prompt-prompt-keys-${row.id}`
                  }
                >
                  {row.promptKeyCount === null
                    ? (
                      <>
                        不适用：没有关联的提示词键，不猜测。
                        <span className="sr-only">N/A：关联的提示词键数量（DeAiSkill 无 prompt 键字段，无关联真源，不猜测）</span>
                      </>
                    )
                    : `关联提示词键 ${row.promptKeyCount} 个`}
                </li>
              </ul>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-foreground">
          {`提示词键（${resolved.promptKeys.length}）：${resolved.associationSourceDeclared ? `未覆盖 ${resolved.uncoveredPromptKeys.length} · 有覆盖 ${resolved.coveredPromptKeyCount}` : "未覆盖和有覆盖都不适用（没有关联记录）"}`}
          <span className="sr-only">
            {resolved.associationSourceDeclared
              ? `uncovered ${resolved.uncoveredPromptKeys.length}`
              : "uncovered/有覆盖 N/A（无关联真源）"}
          </span>
        </p>
        {resolved.promptKeys.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="skill-prompt-keys-empty">
            提示词键全集为空：没有可展示的行（不造行假装统计过）。
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {resolved.promptKeys.map((row) => (
              <li key={row.key} data-testid={`skill-prompt-key-${row.key}`} className="text-[11px]">
                <span className="text-foreground">{row.key}</span>
                <span
                  data-testid={
                    resolved.associationSourceDeclared
                      ? row.uncovered
                        ? `skill-prompt-uncovered-${row.key}`
                        : `skill-prompt-covered-${row.key}`
                      : `skill-prompt-na-${row.key}`
                  }
                  data-coverage-state={
                    resolved.associationSourceDeclared ? (row.uncovered ? "uncovered" : "covered") : "na"
                  }
                  className="text-muted-foreground"
                >
                  {!resolved.associationSourceDeclared ? (
                    <>
                      {" · 覆盖状态不适用（没有关联记录，不逐条判断）"}
                      <span className="sr-only"> · 覆盖状态 N/A（无关联真源，不逐条断言 uncovered）</span>
                    </>
                  ) : row.uncovered ? (
                    <>
                      {" · 未覆盖（没有技能或钩子关联）"}
                      <span className="sr-only"> uncovered</span>
                    </>
                  ) : (
                    <>
                      {" · 已覆盖"}
                      <span className="sr-only">{` covered（skill：${row.associatedSkillIds.join(" ") || "无"} · hook：${row.associatedHookIds.join(" ") || "无"}）`}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-foreground">{`钩子（${resolved.hooks.length}）`}</p>
        {resolved.hooks.length === 0 ? (
          <p className="text-[10px] text-muted-foreground" data-testid="skill-prompt-hooks-empty">
            当前钩子注册表没有声明任何钩子（默认注册表为空，不造行假装统计过）。
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {resolved.hooks.map((hook) => (
              <li
                key={hook.id}
                data-testid={`skill-prompt-hook-${hook.id}`}
                className="rounded border border-border px-2 py-1"
              >
                <p className="text-xs text-foreground">
                  {hook.title}
                  <span className="sr-only">{hook.id}</span>
                  {hook.enabled ? "" : " · 未启用"}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {`声明阶段 ${hook.stages.length} 个`}
                  <span className="sr-only">{`stage ${hook.stages.join(" ")}`}</span>
                </p>
                <ul className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
                  <li
                    data-testid={
                      hook.promptKeyCount === null
                        ? `skill-prompt-na-hook-prompt-keys-${hook.id}`
                        : `skill-prompt-hook-prompt-keys-${hook.id}`
                    }
                  >
                    {hook.promptKeyCount === null
                      ? (
                        <>
                          不适用：没有关联的提示词键，不猜测。
                          <span className="sr-only">N/A：关联的提示词键数量（NovelSkillHook 无 prompt 键字段，无关联真源，不猜测）</span>
                        </>
                      )
                      : `关联提示词键 ${hook.promptKeyCount} 个`}
                  </li>
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-0.5">
        <p className="text-[10px] font-medium text-muted-foreground">以下真源不存在，故显式 N/A：</p>
        <ul className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
          {resolved.missingSources.map((reason, index) => (
            <li key={reason} data-testid={`skill-prompt-na-source-${index}`}>
              不适用
              <span className="sr-only">{`N/A：${reason}`}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
