import { useMemo } from "react"
import { ListChecks } from "lucide-react"

import {
  groupWorkflowTemplates,
  listWorkflowTemplateRegistry,
  type WorkflowTemplateEntry,
  type WorkflowTemplateGroup,
} from "@/lib/novel"

/**
 * 工作流/大纲模板注册表面板（**只读**）。真源 = `outline-templates.ts` + `novel-skill-hooks.ts`，
 * 本面板只展示登记项：必填字段名、枚举取值、`源文件:符号名`、一次哨兵渲染的首行。
 *
 * 明确不做的事（避免「看起来有」的假功能，缺真源就写 N/A）：
 * 1. **使用点统计**：真源里没有「谁在何处渲染该模板」，不做估算。
 * 2. **模板版本/变更历史**：真源没有版本号字段，不伪造版本。
 * 3. **stage 执行顺序/启用状态**：真源只有 stage 名，顺序与启用由调用方决定。
 */
export interface WorkflowTemplatePanelProps {
  /** 注入分组（测试/回放可替换）；默认 `groupWorkflowTemplates(listWorkflowTemplateRegistry())`。 */
  readonly groups?: readonly WorkflowTemplateGroup[]
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  volume: "卷纲",
  chapter: "章纲",
  enum: "枚举清单",
  "skill-stage": "技能挂点",
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

/** 只读 Badge Flow：一组短文本横向换行徽章展示，替代 join("、"/"；")文本墙。 */
function BadgeFlow({ items }: { readonly items: readonly string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {items.map((item, index) => (
        <span
          key={`${item}-${index}`}
          className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs"
        >
          {item}
        </span>
      ))}
    </span>
  )
}

function EntryRow({ entry }: { readonly entry: WorkflowTemplateEntry }) {
  const hasRequired = entry.requiredFields.length > 0
  const hasEnums = entry.enums.length > 0
  const enumPlainItems = entry.enums.map(
    (ref) => `${ref.linkedField ?? "未链接字段"} · ${ref.valueCount} 值`,
  )
  const enumLocked =
    entry.enums.length > 0
      ? entry.enums
          .map((ref) => `${ref.name}（${ref.linkedField ?? "未链接模板字段"} · ${ref.valueCount} 值）`)
          .join("；")
      : null
  return (
    <li
      data-testid={`workflow-template-${entry.id}`}
      className="flex flex-col gap-0.5 rounded bg-muted/40 px-2 py-1 text-xs"
    >
      <p className="font-medium text-foreground">
        {entry.title}
        <span className="ml-1 text-muted-foreground">{kindLabel(entry.kind)}</span>
        <span className="sr-only">{`[${entry.kind}]`}</span>
      </p>
      {hasRequired ? (
        <p data-testid={`workflow-template-${entry.id}-required-fields`}>
          {`必填字段 ${entry.requiredFieldCount} 项：`}
          <BadgeFlow items={entry.requiredFields} />
        </p>
      ) : (
        <p data-testid={`workflow-template-na-${entry.id}-required-fields`}>
          必填字段：不适用（这一项没有声明必填字段）
          <span className="sr-only">N/A</span>
        </p>
      )}
      {hasEnums ? (
        <p data-testid={`workflow-template-${entry.id}-enums`}>
          {`可选枚举 ${entry.enumListCount} 类 / ${entry.enumValueCount} 值：`}
          <BadgeFlow items={enumPlainItems} />
          <span className="sr-only">{enumLocked}</span>
        </p>
      ) : (
        <p data-testid={`workflow-template-na-${entry.id}-enums`}>
          可选枚举：不适用（这一项没有声明枚举）
          <span className="sr-only">N/A</span>
        </p>
      )}
      {entry.kind === "enum"
        ? entry.enums.map((ref) => (
            <p
              key={ref.name}
              data-testid={`workflow-template-${entry.id}-values-${ref.name}`}
              className="text-muted-foreground"
            >
              <BadgeFlow items={ref.values} />
              <span className="sr-only">{ref.name}</span>
            </p>
          ))
        : null}
      {entry.missingRequiredFieldNames !== null && entry.missingRequiredFieldNames.length > 0 ? (
        <p data-testid={`workflow-template-${entry.id}-missing`} className="text-warning-foreground">
          {"渲染正文里未出现这些必填字段名："}
          <BadgeFlow items={entry.missingRequiredFieldNames} />
          {"（如实列出，不补内容）"}
        </p>
      ) : null}
      {entry.templateStatus === "failed" ? (
        <p data-testid={`workflow-template-${entry.id}-template`}>
          模板渲染失败：
          <span data-testid={`workflow-template-${entry.id}-error`}>
            {entry.error ?? "未知原因（真源未给出错误信息）"}
          </span>
        </p>
      ) : entry.templateHead === null ? (
        <p data-testid={`workflow-template-na-${entry.id}-template`}>
          模板：不适用（这一项没有渲染函数）
          <span className="sr-only">N/A</span>
        </p>
      ) : (
        <p data-testid={`workflow-template-${entry.id}-template`}>
          {`模板首行：${entry.templateHead} · 全文 ${entry.templateLength} 字（哨兵渲染，非真实卷/章）`}
        </p>
      )}
      <p data-testid={`workflow-template-${entry.id}-source`} className="text-muted-foreground">
        来源
        <span className="sr-only">{`源：${entry.source}`}</span>
      </p>
    </li>
  )
}

export function WorkflowTemplatePanel({ groups }: WorkflowTemplatePanelProps) {
  // 注入的分组按**注入顺序**原样渲染（不在面板里再排序，注入即所见）。
  const resolved = useMemo(
    () => groups ?? groupWorkflowTemplates(listWorkflowTemplateRegistry()),
    [groups],
  )
  const entryCount = resolved.reduce((sum, group) => sum + group.entries.length, 0)

  return (
    <section data-testid="workflow-template-panel" className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
        <ListChecks className="h-4 w-4" />
        {`工作流/大纲模板注册表（${entryCount} 条 · ${resolved.length} 组）`}
      </h3>
      <p className="text-xs text-muted-foreground" data-testid="workflow-template-scope">
        只读登记：必填字段名、枚举取值、源文件:符号名，加一次哨兵渲染的首行与字数。模板正文不复制进注册表；渲染失败或真源缺失一律显式标注，不写空串、不猜内容。
      </p>
      <ul className="flex flex-col gap-2">
        {resolved.map((group) => (
          <li key={group.kind} data-testid={`workflow-template-group-${group.kind}`}>
            <p className="text-xs font-medium text-foreground">
              {`${kindLabel(group.kind)} · ${group.entries.length} 条`}
              <span className="sr-only">{group.kind}</span>
            </p>
            <ul className="flex flex-col gap-1">
              {group.entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        <li data-testid="workflow-template-na-usage">
          不适用：没有模板使用记录，不估算谁在哪里用过。
          <span className="sr-only">N/A：模板使用点统计</span>
        </li>
        <li data-testid="workflow-template-na-version">
          不适用：没有版本号，不编造变更历史。
          <span className="sr-only">N/A：模板版本/变更历史</span>
        </li>
        <li data-testid="workflow-template-na-stage-order">
          不适用：只有挂点名称，没有执行顺序和启用状态。
          <span className="sr-only">N/A：技能 stage 的执行顺序与启用状态</span>
        </li>
      </ul>
    </section>
  )
}
