// @vitest-environment jsdom
import { describe, it, vi } from "vitest"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { Root as DialogRoot, Content as DialogContent, Title as DialogTitle, Overlay as DialogOverlay } from "@radix-ui/react-dialog"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function TestModal({ onClose, withOverlay, lines }: { onClose: () => void; withOverlay: boolean; lines: string[] }) {
  return (
    <DialogRoot open onOpenChange={(o) => { if (!o) { lines.push("onOpenChange(false)"); onClose() } }}>
      {withOverlay ? <DialogOverlay data-testid="overlay" style={{ position: "fixed", inset: 0 }} /> : null}
      <div data-testid="backdrop" style={{ position: "fixed", inset: 0 }}>
        <DialogContent
          asChild
          aria-describedby={undefined}
          aria-modal={true}
          onPointerDownOutside={() => lines.push("EVT pointerDownOutside")}
          onInteractOutside={() => lines.push("EVT interactOutside")}
          onFocusOutside={() => lines.push("EVT focusOutside")}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            ;(event.currentTarget as HTMLElement | null)?.focus()
          }}
        >
          <div data-testid="card" className="outline-none">
            <DialogTitle asChild>
              <h2>probe</h2>
            </DialogTitle>
          </div>
        </DialogContent>
      </div>
    </DialogRoot>
  )
}

function Toggleable({ withOverlay, lines }: { withOverlay: boolean; lines: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>open</button>
      {open ? <TestModal onClose={() => setOpen(false)} withOverlay={withOverlay} lines={lines} /> : null}
    </>
  )
}

describe("radix probe v2", () => {
  it("instrumented dismissal + scroll lock", async () => {
    const lines: string[] = []
    const origAdd = document.addEventListener.bind(document)
    const origRemove = document.removeEventListener.bind(document)
    const registered = new Map<string, Set<Function>>()
    ;(document as any).addEventListener = (type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
      if (["pointerdown", "click", "keydown"].includes(type)) {
        if (!registered.has(type)) registered.set(type, new Set())
        registered.get(type)!.add(fn)
      }
      return origAdd(type, fn, opts)
    }
    ;(document as any).removeEventListener = (type: string, fn: EventListener, opts?: EventListenerOptions | boolean) => {
      registered.get(type)?.delete(fn)
      return origRemove(type, fn, opts)
    }

    // --- case A: no overlay ---
    const onCloseA = vi.fn()
    const s1 = render(<Toggleable withOverlay={false} lines={lines} />)
    fireEvent.click(s1.getByText("open"))
    await act(async () => {})
    await new Promise((r) => setTimeout(r, 20))
    lines.push(`A keydown-listeners: ${registered.get("keydown")?.size ?? 0}`)
    lines.push(`A click-listeners: ${registered.get("click")?.size ?? 0}`)
    lines.push(`A pointerdown-listeners-after-open: ${registered.get("pointerdown")?.size ?? 0}`)
    const backdropA = s1.getByTestId("backdrop")
    // raw document-level pointerdown
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 1 }))
    await new Promise((r) => setTimeout(r, 20))
    lines.push(`A closed-after-raw-doc-pointerdown(button1): ${onCloseA.mock.calls.length}`)
    fireEvent.pointerDown(backdropA, { button: 0 })
    await new Promise((r) => setTimeout(r, 20))
    lines.push(`A closed-after-el-pointerdown(button0): ${onCloseA.mock.calls.length}`)
    fireEvent.click(backdropA)
    await new Promise((r) => setTimeout(r, 50))
    lines.push(`A closed-after-click+50ms: ${onCloseA.mock.calls.length}`)
    s1.unmount()

    // --- case B: with overlay ---
    const onCloseB = vi.fn()
    const s2 = render(<Toggleable withOverlay lines={lines} />)
    fireEvent.click(s2.getByText("open"))
    await act(async () => {})
    lines.push(`B scroll-locked: ${document.body.hasAttribute("data-scroll-locked")}`)
    lines.push(`B pointerdown-listeners: ${registered.get("pointerdown")?.size ?? 0}`)
    const overlayB = s2.getByTestId("overlay")
    fireEvent.pointerDown(overlayB, { button: 0 })
    lines.push(`B closed-after-overlay-pointerdown: ${onCloseB.mock.calls.length}`)
    fireEvent.click(overlayB)
    await new Promise((r) => setTimeout(r, 50))
    lines.push(`B closed-after-overlay-click+50ms: ${onCloseB.mock.calls.length}`)

    const { writeFileSync } = await import("node:fs")
    writeFileSync("radix-probe-out.txt", lines.join("\n"))
    ;(document as any).addEventListener = origAdd
    ;(document as any).removeEventListener = origRemove
    cleanup()
  })
})
