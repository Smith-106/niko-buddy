// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ToastProvider, setToastApi, toast, useToast } from "./toast"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(ui: React.ReactNode) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(ui)
  })
}

function cleanup() {
  if (root) {
    act(() => {
      root.unmount()
    })
    root = null as unknown as Root
  }
  if (container) {
    container.remove()
    container = null as unknown as HTMLDivElement
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  setToastApi(null)
})

describe("useToast outside provider", () => {
  it("falls back to console output", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    let api: ReturnType<typeof useToast> | null = null
    function Probe() {
      api = useToast()
      return null
    }
    render(<Probe />)
    api!.success("s")
    api!.error("e")
    api!.info("i")
    expect(info).toHaveBeenCalledWith("[toast:success] s")
    expect(warn).toHaveBeenCalledWith("[toast:error] e")
    expect(info).toHaveBeenCalledWith("[toast:info] i")
  })
})

describe("global toast without provider", () => {
  it("falls back to console output", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    toast.success("s")
    toast.error("e")
    toast.info("i")
    expect(info).toHaveBeenCalledWith("[toast:success] s")
    expect(warn).toHaveBeenCalledWith("[toast:error] e")
    expect(info).toHaveBeenCalledWith("[toast:info] i")
  })
})

describe("ToastProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it("renders toast messages into a portal", () => {
    render(
      <ToastProvider>
        <button onClick={() => toast.success("已保存")}>go</button>
      </ToastProvider>,
    )
    act(() => {
      document.querySelector("button")!.click()
    })
    expect(document.body.textContent).toContain("已保存")
  })

  it("renders each kind with its message", () => {
    render(
      <ToastProvider>
        <button onClick={() => {
          toast.success("ok")
          toast.error("bad")
          toast.info("note")
        }}>go</button>
      </ToastProvider>,
    )
    act(() => {
      document.querySelector("button")!.click()
    })
    const text = document.body.textContent ?? ""
    expect(text).toContain("ok")
    expect(text).toContain("bad")
    expect(text).toContain("note")
    // three toast cards + trigger button
    expect(document.querySelectorAll('[role="status"]').length).toBe(3)
  })

  it("auto-dismisses toasts without an action after the duration", () => {
    render(
      <ToastProvider>
        <button onClick={() => toast.success("自动消失")}>go</button>
      </ToastProvider>,
    )
    act(() => {
      document.querySelector("button")!.click()
    })
    expect(document.body.textContent).toContain("自动消失")
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(document.body.textContent).not.toContain("自动消失")
  })

  it("does not auto-dismiss toasts that carry an action", () => {
    render(
      <ToastProvider>
        <button onClick={() => toast.info("待处理", { label: "现在处理", onClick: () => {} })}>go</button>
      </ToastProvider>,
    )
    act(() => {
      document.querySelector("button")!.click()
    })
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(document.body.textContent).toContain("待处理")
  })

  it("invokes the action handler and dismisses on action click", () => {
    const onClick = vi.fn()
    render(
      <ToastProvider>
        <button onClick={() => toast.success("处理", { label: "执行", onClick })}>go</button>
      </ToastProvider>,
    )
    act(() => {
      document.querySelector("button")!.click()
    })
    const actionButton = [...document.querySelectorAll("button")].find((b) => b.textContent === "执行")
    expect(actionButton).toBeTruthy()
    act(() => {
      actionButton!.click()
    })
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain("处理")
  })

  it("dismisses a toast manually via the close button", () => {
    render(
      <ToastProvider>
        <button onClick={() => toast.error("手动关闭")}>go</button>
      </ToastProvider>,
    )
    act(() => {
      document.querySelector("button")!.click()
    })
    const closeButton = document.querySelector('button[aria-label="关闭提示"]') as HTMLButtonElement
    act(() => {
      closeButton.click()
    })
    expect(document.body.textContent).not.toContain("手动关闭")
  })

  it("clears pending timers when the provider unmounts", () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
    render(
      <ToastProvider>
        <button onClick={() => toast.info("清理")}>go</button>
      </ToastProvider>,
    )
    act(() => {
      document.querySelector("button")!.click()
    })
    cleanup()
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })

  it("releases the external API on unmount so the global toast falls back to console", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    render(
      <ToastProvider>
        <button onClick={() => toast.error("在提供者内")}>go</button>
      </ToastProvider>,
    )
    cleanup()
    toast.success("之后")
    expect(info).toHaveBeenCalledWith("[toast:success] 之后")
  })

  it("provides the api to children through context", () => {
    let captured: ReturnType<typeof useToast> | null = null
    function Probe() {
      captured = useToast()
      return <button onClick={() => captured!.error("上下文消息")}>probe</button>
    }
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    )
    act(() => {
      document.querySelector("button")!.click()
    })
    expect(document.body.textContent).toContain("上下文消息")
  })

  it("supports setToastApi injection used by non-React callers", () => {
    const fakeApi = {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    }
    setToastApi(fakeApi)
    toast.success("a")
    toast.error("b")
    toast.info("c")
    expect(fakeApi.success).toHaveBeenCalledWith("a", undefined)
    expect(fakeApi.error).toHaveBeenCalledWith("b", undefined)
    expect(fakeApi.info).toHaveBeenCalledWith("c", undefined)
  })
})
