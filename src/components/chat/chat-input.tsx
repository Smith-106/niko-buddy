import { useRef, useState, useCallback, type ReactNode } from "react"
import { Send, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { isImeComposing } from "@/lib/keyboard-utils"
import { useChatStore } from "@/stores/chat-store"
import {
  clampResizableInputHeight,
  DEFAULT_RESIZABLE_INPUT_HEIGHT,
  resolveResizableInputMaxHeight,
} from "./chat-input-resize"

interface ChatInputProps {
  onSend: (text: string) => void
  onStop: () => void
  isStreaming: boolean
  placeholder?: string
  leadingControls?: ReactNode
  footerControls?: ReactNode
  inlineSendButton?: boolean
  value?: string
  onChange?: (value: string) => void
}

function resolveResizePanelHeight(root: HTMLDivElement | null): number {
  let current = root?.parentElement ?? null
  let panelHeight = 0
  while (current) {
    const height = current.getBoundingClientRect().height
    if (Number.isFinite(height)) panelHeight = Math.max(panelHeight, height)
    current = current.parentElement
  }
  return panelHeight
}

export function ChatInput({ onSend, onStop, isStreaming, placeholder, leadingControls, footerControls, inlineSendButton = true, value: controlledValue, onChange }: ChatInputProps) {
  const activeConversationId = useChatStore((state) => state.activeConversationId)
  const setConversationInputDraft = useChatStore((state) => state.setConversationInputDraft)
  const conversation = useChatStore((state) =>
    activeConversationId
      ? state.conversations.find((c) => c.id === activeConversationId)
      : undefined
  )
  const isControlled = controlledValue !== undefined
  const [fallbackDraft, setFallbackDraft] = useState("")
  const storeValue = conversation?.inputDraft ?? ""
  const value = isControlled ? controlledValue : activeConversationId ? storeValue : fallbackDraft

  const [inputHeight, setInputHeight] = useState(DEFAULT_RESIZABLE_INPUT_HEIGHT)
  const rootRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const setValue = useCallback(
    (draft: string) => {
      if (isControlled) {
        onChange?.(draft)
      } else if (activeConversationId) {
        setConversationInputDraft(activeConversationId, draft)
      } else {
        setFallbackDraft(draft)
      }
    },
    [isControlled, onChange, activeConversationId, setConversationInputDraft]
  )

  const getResizeBounds = useCallback(() => {
    const panelHeight = resolveResizePanelHeight(rootRef.current)
    return {
      minHeight: DEFAULT_RESIZABLE_INPUT_HEIGHT,
      maxHeight: resolveResizableInputMaxHeight({
        panelHeight,
        viewportHeight: window.innerHeight,
      }),
    }
  }, [])

  // A11Y-006 (odyssey-ui): keyboard-operable resize. role="separator" alone is
  // not keyboard-reachable without tabIndex; WCAG 2.1.1 (Level A) requires every
  // operable element be usable from the keyboard. Arrow keys nudge by a step,
  // PageUp/PageDown jump by a larger increment, Home/End snap to the bounds —
  // matching the WAI-ARIA separator pattern for resizable regions.
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const { minHeight, maxHeight } = getResizeBounds()
      const step = Math.max(16, Math.round((maxHeight - minHeight) / 20))
      const bigStep = step * 5
      let next = inputHeight
      switch (e.key) {
        case "ArrowUp":
          next = inputHeight + step
          break
        case "ArrowDown":
          next = inputHeight - step
          break
        case "PageUp":
          next = inputHeight + bigStep
          break
        case "PageDown":
          next = inputHeight - bigStep
          break
        case "Home":
          next = maxHeight
          break
        case "End":
          next = minHeight
          break
        default:
          return
      }
      e.preventDefault()
      setInputHeight(clampResizableInputHeight(next, getResizeBounds()))
    },
    [getResizeBounds, inputHeight],
  )

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    const ta = e.target
    if (ta.scrollHeight > inputHeight) {
      setInputHeight(clampResizableInputHeight(ta.scrollHeight, getResizeBounds()))
    }
  }, [getResizeBounds, inputHeight, setValue])

  const handleResizePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()

    const resizeHandle = event.currentTarget
    const pointerId = event.pointerId
    const startY = event.clientY
    const startHeight = inputHeight
    const previousCursor = document.body.style.cursor
    document.body.style.cursor = "ns-resize"
    try {
      resizeHandle.setPointerCapture(pointerId)
    } catch {
      // Older WebViews can miss pointer capture support; window listeners still provide a fallback.
    }

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const nextHeight = startHeight + (startY - pointerEvent.clientY)
      setInputHeight(clampResizableInputHeight(nextHeight, getResizeBounds()))
    }
    const handlePointerUp = () => {
      try {
        resizeHandle.releasePointerCapture(pointerId)
      } catch {
        // Ignore release errors when the pointer was already cancelled by the WebView.
      }
      document.body.style.cursor = previousCursor
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
      window.removeEventListener("pointercancel", handlePointerUp)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
    window.addEventListener("pointercancel", handlePointerUp)
  }, [getResizeBounds, inputHeight])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed || isStreaming) return
    onSend(trimmed)
    setValue("")
  }, [value, isStreaming, onSend, setValue])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Don't submit on the Enter that commits an IME candidate —
      // the user is mid-composition (Chinese / Japanese / Korean
      // input method picking an English word or phrase) and would
      // see the message fire before they finished typing.
      if (isImeComposing(e)) return
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  return (
    <div ref={rootRef} className="border-t">
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖动调整输入框高度"
        aria-valuenow={Math.round(inputHeight)}
        aria-valuemin={DEFAULT_RESIZABLE_INPUT_HEIGHT}
        aria-valuemax={getResizeBounds().maxHeight}
        tabIndex={0}
        title="拖动调整输入框高度（聚焦后可用方向键调节）"
        // IS-011/MI-005 (odyssey-ui): the grip bar was a static bg-border line
        // with no hover/active affordance — looked decorative, not grabbable.
        // Group hover/active + focus-visible raise the contrast so the affordance
        // reads at the exact moment the user is about to grab or keyboard-focus it.
        className="group flex h-2 cursor-ns-resize items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
      >
        <span className="h-0.5 w-10 rounded-full bg-border transition-colors group-hover:bg-foreground/30 group-active:bg-foreground/40 group-focus-visible:bg-foreground/30" />
      </div>
      {leadingControls ? (
        <div className="px-3 pb-2">
          {leadingControls}
        </div>
      ) : null}
      <div className="flex items-end gap-2 px-3 pb-3">
        <textarea
          ref={textareaRef}
          value={value}
          dir="auto"
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "输入消息，Enter 发送，Shift+Enter 换行"}
          disabled={isStreaming}
          rows={1}
          className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          style={{ height: inputHeight, maxHeight: inputHeight, overflowY: "auto" }}
        />
        {inlineSendButton && (isStreaming ? (
          <Button
            variant="destructive"
            size="icon"
            onClick={onStop}
            className="shrink-0"
            title="停止生成"
            aria-label="停止生成"
          >
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!value.trim()}
            className="shrink-0"
            title="发送消息"
            aria-label="发送消息"
          >
            <Send className="h-4 w-4" />
          </Button>
        ))}
      </div>
      {footerControls ? (
        <div className="px-3 pb-2">
          {footerControls}
        </div>
      ) : null}
    </div>
  )
}
