// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

/**
 * 小说设置页的行级子组件（开关行、数字行、帮助提示、实验性折叠区）。
 * novel-section / novel-base-settings-section 只做数据编排，行的 a11y 细节集中在这里：
 * 可见标签用 htmlFor/useId 关联控件，开关用 aria-labelledby 指向可见标签。
 */
import { useId, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ChevronRight, Info } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CommitNumberInput, SettingsSwitch } from "../settings-widgets"

export { NOVEL_GROUP_HEADING_CLASS } from "./novel-section-style"

/** Standard toggle switch for novel settings rows（基于 SettingsSwitch）。 */
export function NovelToggle({
  checked,
  onChange,
  label,
  labelledBy,
  describedBy,
  id,
}: {
  checked: boolean
  onChange: () => void
  label: string
  labelledBy?: string
  describedBy?: string
  id?: string
}) {
  return (
    <SettingsSwitch
      id={id}
      checked={checked}
      onCheckedChange={() => onChange()}
      label={label}
      labelledBy={labelledBy}
      describedBy={describedBy}
    />
  )
}

/** Per-setting help tooltip：图标 3.5，点击区 size-6（负 margin 抵消布局偏移）。 */
export function NovelSettingTooltip({ tipKey }: { tipKey: string }) {
  const { t } = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="-m-1 inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("novel.settings.help")}
          />
        }
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-sm leading-5">
        {t(`novel.settings.${tipKey}`)}
      </TooltipContent>
    </Tooltip>
  )
}

/** 开关行：可见标签 + 帮助 + 可选说明，开关的可访问名取自可见标签。 */
export function NovelSwitchRow({
  label,
  tipKey,
  hint,
  checked,
  onChange,
}: {
  label: string
  tipKey?: string
  hint?: ReactNode
  checked: boolean
  onChange: () => void
}) {
  const baseId = useId()
  const labelId = `${baseId}-label`
  const switchId = `${baseId}-switch`
  const hintId = hint ? `${baseId}-hint` : undefined
  const title = (
    <div className="flex items-center gap-1.5">
      <Label id={labelId} htmlFor={switchId}>{label}</Label>
      {tipKey ? <NovelSettingTooltip tipKey={tipKey} /> : null}
    </div>
  )
  return (
    <div className="flex items-center justify-between gap-3">
      {hint ? (
        <div>
          {title}
          <p id={hintId} className="text-xs text-muted-foreground">{hint}</p>
        </div>
      ) : (
        title
      )}
      <NovelToggle
        id={switchId}
        label={label}
        labelledBy={labelId}
        describedBy={hintId}
        checked={checked}
        onChange={onChange}
      />
    </div>
  )
}

/** 整数行：失焦/回车才提交（CommitNumberInput），保留原 min/max。 */
export function NovelNumberField({
  label,
  tipKey,
  hint,
  value,
  min,
  max,
  step,
  onCommit,
  className = "w-24",
}: {
  label: string
  tipKey?: string
  hint?: ReactNode
  value: number
  min: number
  max: number
  step?: number
  onCommit: (next: number) => void
  className?: string
}) {
  const baseId = useId()
  const inputId = `${baseId}-input`
  const hintId = hint ? `${baseId}-hint` : undefined
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={inputId}>{label}</Label>
        {tipKey ? <NovelSettingTooltip tipKey={tipKey} /> : null}
      </div>
      <CommitNumberInput
        id={inputId}
        value={value}
        min={min}
        max={max}
        step={step}
        describedBy={hintId}
        onCommit={onCommit}
        className={className}
      />
      {hint ? <p id={hintId} className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** 小数行：与 NovelNumberField 同样的提交时机（失焦/回车提交、Esc 还原、空串回退）。 */
export function NovelDecimalField({
  label,
  tipKey,
  value,
  min,
  max,
  step,
  onCommit,
  className = "w-24",
}: {
  label: string
  tipKey?: string
  value: number
  min: number
  max: number
  step: number
  onCommit: (next: number) => void
  className?: string
}) {
  const baseId = useId()
  const inputId = `${baseId}-input`
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={inputId}>{label}</Label>
        {tipKey ? <NovelSettingTooltip tipKey={tipKey} /> : null}
      </div>
      <CommitNumberInput
        id={inputId}
        decimal
        value={value}
        min={min}
        max={max}
        step={step}
        onCommit={onCommit}
        className={className}
      />
    </div>
  )
}

/** 实验性选项折叠区：默认收起，summary 可聚焦，有可见焦点环。 */
export function NovelExperimentalDetails({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <details className="group rounded-md border" data-testid="novel-experimental-details">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        {t("novel.settings.experimentalOptions", { defaultValue: "实验性选项" })}
        <span className="text-xs font-normal text-muted-foreground">
          {t("novel.settings.experimentalOptionsHint", {
            defaultValue: "默认值保持零行为变更，改动前请先阅读各项说明",
          })}
        </span>
      </summary>
      <div className="space-y-3 border-t p-3">{children}</div>
    </details>
  )
}
