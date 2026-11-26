// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

/**
 * Safe Markdown prose renderer for Antigravity ACP assistant replies.
 *
 * Security & rendering guardrails (G-XSS):
 * - Uses `react-markdown` + `remark-gfm` with ZERO `rehype-raw` and ZERO
 *   `dangerouslySetInnerHTML` (raw HTML is escaped as inert text).
 * - Explicitly blocks `javascript:`, `vbscript:`, `data:`, and any scheme
 *   outside `http:`, `https:`, `mailto:`, `#` fragments, and relative paths.
 * - Uses explicit Tailwind utility classes (no `@tailwindcss/typography` dependency).
 * - Wrapped in `React.memo` and a class `ErrorBoundary` that falls back cleanly
 *   to `whitespace-pre-wrap` plain text on render error.
 */

import { Component, memo, type ErrorInfo, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"])
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g
const CONTROL_AND_SPACE_RE = /[\u0000-\u0020\u007f]/g
const EXPLICIT_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/

/**
 * Sanitize a Markdown link or image URL.
 *
 * Allows only `http:`, `https:`, optional `mailto:` (enabled for links, disabled
 * for images), `#` fragments, and relative URLs — while blocking protocol-relative
 * URLs (`//`, `/\`, `\/`, `\\`), leading backslash paths, `javascript:`, `vbscript:`,
 * `data:`, and control-char/whitespace obfuscated schemes.
 */
export function sanitizeMarkdownUrl(
  rawUrl: string | null | undefined,
  allowMailto = true,
): string {
  if (typeof rawUrl !== "string") return ""
  const cleaned = rawUrl.replace(CONTROL_CHARS_RE, "").trim()
  if (!cleaned) return ""

  // Block protocol-relative URLs (`//`, `/\`, `\/`, `\\`), leading backslashes,
  // and their percent-encoded equivalents (`%5C` / `%2F`) which mdast/hast emits
  // for backslash destinations and WHATWG URL parsers normalize to `//host`.
  const normalizedPrefix = cleaned.replace(/%5c/gi, "\\").replace(/%2f/gi, "/")
  if (
    /^[/\\]{2}/.test(cleaned) ||
    cleaned.startsWith("\\") ||
    /^[/\\]{2}/.test(normalizedPrefix) ||
    normalizedPrefix.startsWith("\\")
  ) {
    return ""
  }

  // Fragment-only links and explicit relative paths are safe.
  if (
    cleaned.startsWith("#") ||
    cleaned.startsWith("/") ||
    cleaned.startsWith("./") ||
    cleaned.startsWith("../")
  ) {
    return cleaned
  }

  // Strip embedded spaces/control chars when inspecting the scheme so variants
  // like `java\tscript:alert(1)` or `vb script:msgbox(1)` cannot bypass checks.
  const schemeProbe = cleaned.replace(CONTROL_AND_SPACE_RE, "")
  const firstDelimiterIdx = schemeProbe.search(/[/?#]/)
  const colonIdx = schemeProbe.indexOf(":")

  // No colon before path/query/fragment delimiter => plain relative URL.
  if (colonIdx === -1 || (firstDelimiterIdx !== -1 && colonIdx > firstDelimiterIdx)) {
    return cleaned
  }

  const schemeMatch = schemeProbe.match(EXPLICIT_SCHEME_RE)
  if (!schemeMatch) return ""
  const scheme = schemeMatch[1]!.toLowerCase()
  if (scheme === "mailto:") return allowMailto ? cleaned : ""
  return ALLOWED_URL_SCHEMES.has(scheme) ? cleaned : ""
}

function transformMarkdownUrl(url: string, key: string): string {
  return sanitizeMarkdownUrl(url, key !== "src")
}

const REMARK_PLUGINS = [remarkGfm]

const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mt-3 mb-1.5 text-lg font-bold tracking-tight first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-3 mb-1.5 text-base font-semibold tracking-tight first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-2.5 mb-1 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-2 mb-1 text-sm font-medium first:mt-0">{children}</h4>
  ),
  p: ({ children }) => (
    <p className="my-1.5 whitespace-pre-wrap leading-relaxed first:mt-0 last:mb-0">{children}</p>
  ),
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-primary/50 bg-muted/30 py-1 pr-2 pl-3 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => (
    <code
      className={cn(
        "rounded bg-muted/70 px-1 py-0.5 font-mono text-[0.85em]",
        className,
      )}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md border border-border/60 bg-muted/60 p-2.5 font-mono text-xs leading-relaxed [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse border border-border/60 text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border/60 bg-muted/50 px-2 py-1 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border/60 px-2 py-1 align-top">{children}</td>
  ),
  hr: () => <hr className="my-3 border-border/60" />,
  a: ({ href, children }) => {
    const safeHref = sanitizeMarkdownUrl(href)
    if (!safeHref) {
      return (
        <span
          className="text-muted-foreground underline decoration-dotted"
          data-unsafe-href="blocked"
        >
          {children}
        </span>
      )
    }
    const isExternal = /^https?:/i.test(safeHref)
    return (
      <a
        href={safeHref}
        target={isExternal ? "_blank" : undefined}
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2 hover:text-primary/80"
      >
        {children}
      </a>
    )
  },
  img: ({ src, alt }) => {
    const safeSrc = sanitizeMarkdownUrl(src, false)
    if (!safeSrc) {
      return (
        <span
          className="text-xs text-muted-foreground"
          data-unsafe-src="blocked"
        >
          {alt ?? ""}
        </span>
      )
    }
    return (
      <img
        src={safeSrc}
        alt={alt ?? ""}
        loading="lazy"
        className="my-2 max-w-full rounded border border-border/60"
      />
    )
  },
}

interface MarkdownErrorBoundaryProps {
  content: string
  className?: string
  children: ReactNode
}

interface MarkdownErrorBoundaryState {
  hasError: boolean
  prevContent: string
}

export class MarkdownErrorBoundary extends Component<
  MarkdownErrorBoundaryProps,
  MarkdownErrorBoundaryState
> {
  constructor(props: MarkdownErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, prevContent: props.content }
  }

  static getDerivedStateFromProps(
    nextProps: MarkdownErrorBoundaryProps,
    prevState: MarkdownErrorBoundaryState,
  ): Partial<MarkdownErrorBoundaryState> | null {
    if (nextProps.content !== prevState.prevContent) {
      return { hasError: false, prevContent: nextProps.content }
    }
    return null
  }

  static getDerivedStateFromError(): Partial<MarkdownErrorBoundaryState> {
    return { hasError: true }
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Fallback UI renders raw plain text safely without crashing the transcript.
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          data-testid="safe-markdown-fallback"
          className={cn("whitespace-pre-wrap break-words", this.props.className)}
        >
          {this.props.content}
        </div>
      )
    }
    return this.props.children
  }
}

export interface SafeMarkdownProseProps {
  content: string
  className?: string
}

export const SafeMarkdownProse = memo(function SafeMarkdownProse({
  content,
  className,
}: SafeMarkdownProseProps) {
  return (
    <MarkdownErrorBoundary content={content} className={className}>
      <div
        data-testid="safe-markdown-prose"
        className={cn("space-y-1.5 text-sm leading-relaxed break-words", className)}
      >
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          urlTransform={transformMarkdownUrl}
          components={MARKDOWN_COMPONENTS}
        >
          {content}
        </ReactMarkdown>
      </div>
    </MarkdownErrorBoundary>
  )
})
