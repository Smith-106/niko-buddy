import { useTranslation } from "react-i18next"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, Pencil, Trash2 } from "lucide-react"
import type { SkillCategory } from "@/lib/novel"

export function OptionCheckbox({
  label,
  checked,
  testId,
  onToggle,
}: {
  label: string
  checked: boolean
  testId: string
  onToggle: () => void
}) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground">
      <input
        data-testid={testId}
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-3.5 w-3.5 accent-primary"
      />
      {label}
    </label>
  )
}

export interface SortableCategoryItemProps {
  category: SkillCategory
  count: number
  isSelected: boolean
  isEditing: boolean
  isHovered: boolean
  editingCategoryName: string
  onSelect: () => void
  onStartEdit: () => void
  onRename: () => void
  onCancelEdit: () => void
  onEditingNameChange: (name: string) => void
  onDelete: () => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}

export function SortableCategoryItem({
  category,
  count,
  isSelected,
  isEditing,
  isHovered,
  editingCategoryName,
  onSelect,
  onStartEdit,
  onRename,
  onCancelEdit,
  onEditingNameChange,
  onDelete,
  onMouseEnter,
  onMouseLeave,
}: SortableCategoryItemProps) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: category.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`group relative ${isDragging ? "z-10 opacity-80 shadow-md" : ""}`}
    >
      {isEditing ? (
        <div className="flex items-center gap-1 rounded-md px-2 py-1">
          <input
            autoFocus
            type="text"
            value={editingCategoryName}
            onChange={(e) => onEditingNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                onRename()
              } else if (e.key === "Escape") {
                onCancelEdit()
              }
            }}
            onBlur={onRename}
            className="flex-1 rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      ) : (
        <div
          className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent ${
            isSelected ? "bg-accent/60" : ""
          }`}
        >
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="shrink-0 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
            onClick={(e) => e.stopPropagation()}
            title={t("common.dragSort")}
            aria-label={t("common.dragSort")}
          >
            <GripVertical className="h-4 w-4 shrink-0" />
          </button>
          <button type="button"
            onClick={onSelect}
            className="min-w-0 flex-1 cursor-pointer text-left"
          >
            <span className="block truncate">{category.name}</span>
          </button>
          <span className="shrink-0 text-xs text-muted-foreground">{count}</span>
          {(isHovered || isSelected) && (
            <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={onStartEdit}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                title={t("common.rename")}
                aria-label={t("common.rename")}
              >
                <Pencil className="h-3.5 w-3.5 shrink-0" />
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                title={t("common.delete")}
                aria-label={t("common.delete")}
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
