import { templates, type WikiTemplate } from "@/lib/templates"
import { cn } from "@/lib/utils"
import { useTranslation } from "react-i18next"

interface TemplatePickerProps {
  selected: string
  onSelect: (id: string) => void
}

/**
 * 安全读取模板列表：防部分 mock / 降级加载环境（vitest 替身访问缺失导出即抛）
 * 导致新建项目弹窗崩溃；真实运行时始终返回完整模板列表。
 */
function loadTemplates(): WikiTemplate[] {
  try {
    return templates ?? []
  } catch {
    return []
  }
}

export function TemplatePicker({ selected, onSelect }: TemplatePickerProps) {
  const { t } = useTranslation()
  const available = loadTemplates()

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {available.map((template) => {
        const name = t(`templates.${template.id}.name`, { defaultValue: template.name })
        const description = t(`templates.${template.id}.description`, {
          defaultValue: template.description,
        })

        return (
          <button
            key={template.id}
            type="button"
            onClick={() => onSelect(template.id)}
            className={cn(
              "flex flex-col gap-1 rounded-md border p-3 text-left transition-colors hover:bg-accent",
              selected === template.id
                ? "border-primary bg-accent ring-1 ring-primary"
                : "border-border bg-background",
            )}
          >
            <span className="text-xl leading-none">{template.icon}</span>
            <span className="text-sm font-medium leading-tight">{name}</span>
            <span className="text-xs text-muted-foreground leading-tight">{description}</span>
          </button>
        )
      })}
    </div>
  )
}
