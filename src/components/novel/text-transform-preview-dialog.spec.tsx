// @vitest-environment jsdom

import { fireEvent } from "@/test-helpers/component-test-utils"
import { act } from "react"
import type { ComponentProps, ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"

const dialogState = vi.hoisted(() => ({
  onOpenChange: undefined as ((next: boolean) => void) | undefined,
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, onOpenChange }: { children: unknown; onOpenChange?: (next: boolean) => void }) => {
    dialogState.onOpenChange = onOpenChange
    return children
  },
  DialogContent: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => <button {...props}>{children}</button>,
}))

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}))

import { TextTransformPreviewDialog } from "./text-transform-preview-dialog"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function renderDialog(props: Partial<ComponentProps<typeof TextTransformPreviewDialog>> = {}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const onApply = vi.fn()
  const onClose = vi.fn()
  act(() => {
    root.render(
      <TextTransformPreviewDialog
        open
        title="AI修改预览"
        description="请确认修改"
        sourceLabel="补写位置"
        candidateLabel="AI补写内容"
        sourceContent="原文"
        candidateContent="AI生成内容"
        applyLabel="确认替换"
        onApply={onApply}
        onClose={onClose}
        {...props}
      />,
    )
  })
  return { container, root, onApply, onClose, cleanup: () => { act(() => root.unmount()); container.remove() } }
}

describe("TextTransformPreviewDialog", () => {
  it("renders generated content as editable when a change handler is provided", () => {
    const onCandidateContentChange = vi.fn()
    const { container, cleanup } = renderDialog({ onCandidateContentChange })
    const textarea = container.querySelector("textarea")
    expect(textarea).not.toBeNull()
    expect(textarea?.value).toBe("AI生成内容")

    act(() => {
      textarea?.dispatchEvent(new Event("input", { bubbles: true }))
      textarea?.dispatchEvent(new Event("change", { bubbles: true }))
    })
    cleanup()
  })

  it("renders description, static candidate, secondary action and disabled states", () => {
    const onSecondaryAction = vi.fn()
    const { container, onApply, cleanup } = renderDialog({
      description: undefined,
      onCandidateContentChange: undefined,
      secondaryActionLabel: "另存草稿",
      secondaryActionDisabled: true,
      onSecondaryAction,
      applyDisabled: true,
    })

    expect(container.textContent).toContain("AI修改预览")
    expect(container.textContent).toContain("AI生成内容")
    expect(container.querySelector("textarea")).toBeNull()
    const buttons = Array.from(container.querySelectorAll("button"))
    const secondary = buttons.find((button) => button.textContent === "另存草稿")
    const apply = buttons.find((button) => button.textContent === "确认替换")
    expect(secondary).toBeDisabled()
    expect(apply).toBeDisabled()
    secondary?.click()
    expect(onSecondaryAction).not.toHaveBeenCalled()
    expect(onApply).not.toHaveBeenCalled()
    cleanup()
  })

  it("calls the candidate change handler and action callbacks", () => {
    const onCandidateContentChange = vi.fn()
    const onSecondaryAction = vi.fn()
    const { container, onApply, onClose, cleanup } = renderDialog({
      onCandidateContentChange,
      secondaryActionLabel: "另存草稿",
      onSecondaryAction,
    })
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: "改后内容" } })
    expect(onCandidateContentChange).toHaveBeenCalledWith("改后内容")

    const buttons = Array.from(container.querySelectorAll("button"))
    buttons.find((button) => button.textContent === "取消")?.click()
    buttons.find((button) => button.textContent === "另存草稿")?.click()
    buttons.find((button) => button.textContent === "确认替换")?.click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSecondaryAction).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledTimes(1)

    dialogState.onOpenChange?.(true)
    expect(onClose).toHaveBeenCalledTimes(1)
    dialogState.onOpenChange?.(false)
    expect(onClose).toHaveBeenCalledTimes(2)
    cleanup()
  })
})
