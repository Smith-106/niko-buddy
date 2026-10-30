// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

/**
 * 设置页共享控件。各 section 的开关、数字框统一从这里取，
 * 保证 role/aria、点击区（≥24px）与提交时机一致。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Input } from "@/components/ui/input"
import { exceedsMax, parseClampedNumber } from "./settings-number-helpers"

export { parseClampedInt } from "./settings-number-helpers"

interface SettingsSwitchProps {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  /** 固定名称（描述「这是什么」），状态由 aria-checked 表达，不随开/关改写。 */
  label?: string
  /** 已有可见标题时优先用 aria-labelledby 指向它。 */
  labelledBy?: string
  describedBy?: string
  id?: string
  disabled?: boolean
  title?: string
  "data-testid"?: string
}

/** 统一开关：role=switch + aria-checked，视觉 44×24，满足 24px 最小点击区。 */
export function SettingsSwitch({
  checked,
  onCheckedChange,
  label,
  labelledBy,
  describedBy,
  id,
  disabled,
  title,
  "data-testid": testId,
}: SettingsSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      title={title}
      data-testid={testId}
      onClick={() => onCheckedChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-primary" : "bg-input"
      }`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background elevation-3 ring-0 transition-transform motion-reduce:transition-none ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  )
}

interface CommitNumberInputProps {
  /** undefined 表示未设置（输入框显示空，用 placeholder 提示默认值）。 */
  value: number | undefined
  min: number
  max: number
  onCommit: (next: number) => void
  /** 提供时，清空后提交会调用它（可选字段回到默认）；不提供时清空还原为原值。 */
  onClear?: () => void
  /** 允许小数（权重类字段）；默认只收整数。 */
  decimal?: boolean
  id?: string
  className?: string
  describedBy?: string
  step?: number
  placeholder?: string
  "aria-label"?: string
  "data-testid"?: string
}

/**
 * 失焦或回车才提交的数字框。输入过程中不夹值、不落盘，
 * 避免「清空即变 1、想输 5 得到 15」；越界值在提交时夹到范围内。
 * 聚焦编辑期间外部 value 变化不覆盖正在输入的文本。
 * 标红只在超过上限时出现（见 exceedsMax），低于下限按"还没输完"处理。
 */
export function CommitNumberInput({
  value,
  min,
  max,
  onCommit,
  onClear,
  decimal = false,
  id,
  className,
  describedBy,
  step,
  placeholder,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: CommitNumberInputProps) {
  const shown = value === undefined ? "" : String(value)
  const [text, setText] = useState(shown)
  const focusedRef = useRef(false)
  useEffect(() => {
    if (!focusedRef.current) setText(shown)
  }, [shown])
  const parse = (raw: string) => parseClampedNumber(raw, min, max, !decimal)
  const invalid = exceedsMax(text, max)
  const commit = () => {
    if (text.trim() === "" && onClear) {
      if (value !== undefined) onClear()
      return
    }
    const next = parse(text)
    if (next === null) {
      setText(shown)
      return
    }
    setText(String(next))
    if (next !== value) onCommit(next)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commit()
    if (e.key === "Escape") setText(shown)
  }
  return (
    <Input
      id={id}
      type="number"
      inputMode={decimal ? "decimal" : "numeric"}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      value={text}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      data-testid={testId}
      className={className}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => {
        focusedRef.current = true
      }}
      onBlur={() => {
        focusedRef.current = false
        commit()
      }}
      onKeyDown={onKeyDown}
    />
  )
}
