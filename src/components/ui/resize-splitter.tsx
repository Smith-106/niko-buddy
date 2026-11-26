// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

export interface ResizeSplitterProps {
  /** vertical: 左右分栏（垂直分割线）；horizontal: 上下分栏（水平分割线）。 */
  orientation: "vertical" | "horizontal"
  /** 当前尺寸（px）。 */
  value: number
  /** 最小尺寸（px）。 */
  min: number
  /** 最大尺寸（px）。 */
  max: number
  /** 方向键默认步长（px，默认 16；按住 Shift 时放大为 3 倍，即默认 48）。 */
  step?: number
  /** WAI-ARIA 可访问标签。 */
  ariaLabel: string
  /** 右侧/底部面板拖拽方向与坐标轴相反时置 true。 */
  invertDrag?: boolean
  /**
   * 可选：由容器坐标直接计算新尺寸（用于依赖容器边界 rect 的精确拖拽）。
   * 返回 null 时忽略该帧（例如容器已卸载）。
   */
  resolveDragValue?: (point: { clientX: number; clientY: number }) => number | null
  /** 尺寸变化回调（已自动 clamp 到 [min, max]）。 */
  onChange: (next: number) => void
  /** 拖拽结束或键盘调整完成后的提交回调。 */
  onCommit?: (next: number) => void
  className?: string
  testId?: string
}

const DEFAULT_STEP = 16
const SHIFT_STEP_MULTIPLIER = 3

function clampValue(raw: number, min: number, max: number): number {
  if (!Number.isFinite(raw)) return min
  return Math.max(min, Math.min(max, Math.round(raw)))
}

/**
 * 公共 WAI-ARIA 分隔条：支持鼠标拖拽与键盘方向键/Home/End 调整，
 * 并在 pointercancel / mouseup / window.blur / visibilitychange(hidden) / unmount
 * 时强制清理全局监听器与 body 样式，杜绝拖拽泄漏。
 */
export function ResizeSplitter({
  orientation,
  value,
  min,
  max,
  step = DEFAULT_STEP,
  ariaLabel,
  invertDrag = false,
  resolveDragValue,
  onChange,
  onCommit,
  className,
  testId,
}: ResizeSplitterProps) {
  const cleanupRef = useRef<(() => void) | null>(null)
  const latestValueRef = useRef(value)
  latestValueRef.current = value
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const resolveDragValueRef = useRef(resolveDragValue)
  resolveDragValueRef.current = resolveDragValue

  useEffect(() => {
    return () => {
      cleanupRef.current?.()
    }
  }, [])

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      cleanupRef.current?.()

      const startX = event.clientX
      const startY = event.clientY
      const startValue = latestValueRef.current
      let committedValue = startValue
      let active = true

      document.body.style.cursor = orientation === "vertical" ? "col-resize" : "row-resize"
      document.body.style.userSelect = "none"
      document.body.dataset.panelResizing = "true"

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!active) return
        let rawNext: number
        if (resolveDragValueRef.current) {
          const resolved = resolveDragValueRef.current({
            clientX: moveEvent.clientX,
            clientY: moveEvent.clientY,
          })
          if (resolved === null) return
          rawNext = resolved
        } else {
          const delta = orientation === "vertical"
            ? moveEvent.clientX - startX
            : moveEvent.clientY - startY
          rawNext = startValue + (invertDrag ? -delta : delta)
        }
        const next = clampValue(rawNext, min, max)
        committedValue = next
        onChangeRef.current(next)
      }

      const cleanup = (shouldCommit: boolean) => {
        if (!active) return
        active = false
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
        delete document.body.dataset.panelResizing
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
        window.removeEventListener("pointerup", handleMouseUp)
        document.removeEventListener("pointercancel", handleCancel)
        window.removeEventListener("blur", handleCancel)
        document.removeEventListener("visibilitychange", handleVisibilityChange)
        if (cleanupRef.current === cleanupSilent) {
          cleanupRef.current = null
        }
        if (shouldCommit) {
          onCommitRef.current?.(committedValue)
        }
      }

      const handleMouseUp = () => cleanup(true)
      const handleCancel = () => cleanup(false)
      const handleVisibilityChange = () => {
        if (document.hidden) cleanup(false)
      }
      const cleanupSilent = () => cleanup(false)

      cleanupRef.current = cleanupSilent
      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
      window.addEventListener("pointerup", handleMouseUp)
      document.addEventListener("pointercancel", handleCancel)
      window.addEventListener("blur", handleCancel)
      document.addEventListener("visibilitychange", handleVisibilityChange)
    },
    [invertDrag, max, min, orientation],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const delta = event.shiftKey ? step * SHIFT_STEP_MULTIPLIER : step
      const sign = invertDrag ? -1 : 1
      let next: number | null = null

      if (event.key === "Home") {
        next = min
      } else if (event.key === "End") {
        next = max
      } else if (orientation === "vertical") {
        if (event.key === "ArrowRight") next = value + delta * sign
        else if (event.key === "ArrowLeft") next = value - delta * sign
      } else {
        if (event.key === "ArrowDown") next = value + delta * sign
        else if (event.key === "ArrowUp") next = value - delta * sign
      }

      if (next === null) return
      event.preventDefault()
      const clamped = clampValue(next, min, max)
      onChange(clamped)
      onCommit?.(clamped)
    },
    [invertDrag, max, min, onChange, onCommit, orientation, step, value],
  )

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        "shrink-0 bg-border/40 transition-colors hover:bg-primary/30 active:bg-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        orientation === "vertical" ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize",
        className,
      )}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
    />
  )
}
