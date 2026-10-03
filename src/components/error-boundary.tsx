import { Component, type ReactNode } from "react"
import i18n from "@/i18n"

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  copied: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, copied: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, copied: false }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack)
  }

  private copyDetails() {
    const err = this.state.error
    const detail = err ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : "unknown error"
    const done = () => this.setState({ copied: true })
    // F15：clipboard API 不可用时不得假报“已复制”——明确失败态
    if (!navigator.clipboard?.writeText) {
      this.setState({ copied: false })
      return
    }
    try {
      const maybePromise = navigator.clipboard.writeText(detail) as unknown
      if (maybePromise && typeof (maybePromise as Promise<void>).then === "function") {
        void (maybePromise as Promise<void>).then(done, () => this.setState({ copied: false }))
      } else {
        done()
      }
    } catch {
      this.setState({ copied: false })
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p className="text-destructive font-medium">{i18n.t("errorBoundary.title", { defaultValue: "出错了" })}</p>
          <p className="text-xs max-w-md text-center">{this.state.error?.message}</p>
          <div className="flex items-center gap-2">
            <button
              className="rounded border px-3 py-1 text-xs hover:bg-muted"
              onClick={() => this.setState({ hasError: false, error: null, copied: false })}
            >
              {i18n.t("errorBoundary.retry", { defaultValue: "重试" })}
            </button>
            <button
              className="rounded border px-3 py-1 text-xs hover:bg-muted"
              onClick={() => this.copyDetails()}
            >
              {this.state.copied
                ? i18n.t("errorBoundary.detailsCopied", { defaultValue: "已复制" })
                : i18n.t("errorBoundary.copyDetails", { defaultValue: "复制错误详情" })}
            </button>
            <button
              className="rounded border px-3 py-1 text-xs hover:bg-muted"
              onClick={() => window.location.reload()}
            >
              {i18n.t("errorBoundary.reloadPage", { defaultValue: "刷新页面" })}
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
