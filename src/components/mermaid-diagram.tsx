import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { X, ZoomIn } from "lucide-react"
import { formatOperationError } from "@/lib/format-operation-error"

interface MermaidDiagramProps {
  code: string
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg"
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink"

const ALLOWED_SVG_TAGS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "marker",
  "clippath",
  "mask",
  "pattern",
  "lineargradient",
  "radialgradient",
  "stop",
  "title",
  "desc",
  "symbol",
  "use",
  "style",
])

const ALLOWED_SVG_ATTRS = new Set([
  "id",
  "class",
  "viewbox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "opacity",
  "style",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "dy",
  "dx",
  "marker-start",
  "marker-mid",
  "marker-end",
  "clip-path",
  "mask",
  "refx",
  "refy",
  "markerwidth",
  "markerheight",
  "markerunits",
  "orient",
  "preserveaspectratio",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "spreadmethod",
  "role",
  "aria-label",
  "aria-roledescription",
  "aria-labelledby",
  "aria-describedby",
  "aria-hidden",
  "focusable",
  "data-id",
  "data-node",
  "data-edge",
])

const FRAGMENT_HREF_RE = /^#[a-zA-Z0-9_.:-]+$/
const CSS_DANGEROUS_RE =
  /(?:<|\\|\/\*|\*\/|@import|@charset|image-set\s*\(|javascript\s*:|vbscript\s*:|expression\s*\(|behavior\s*:|-moz-binding)/i
const CSS_URL_OPEN_RE = /url\s*\(/gi
const CSS_URL_RE = /url\s*\(\s*([^)]*?)\s*\)/gi
const SAFE_URL_FRAGMENT_RE = /^['"]?#[a-zA-Z0-9_.:-]+['"]?$/

function hasSafeCssUrls(value: string): boolean {
  if (CSS_DANGEROUS_RE.test(value)) return false
  const openCount = (value.match(CSS_URL_OPEN_RE) ?? []).length
  CSS_URL_RE.lastIndex = 0
  let matchedCount = 0
  let match: RegExpExecArray | null
  while ((match = CSS_URL_RE.exec(value)) !== null) {
    matchedCount += 1
    const target = (match[1] ?? "").trim()
    if (!SAFE_URL_FRAGMENT_RE.test(target)) {
      return false
    }
  }
  return matchedCount === openCount
}

function sanitizeStyleElement(parent: Element, el: Element): void {
  const childNodes = Array.from(el.childNodes)
  const textParts: string[] = []
  for (const child of childNodes) {
    // 拒绝含任意子元素的 <style>（防 <style><img onerror> / <style><script> mXSS）
    if (child.nodeType === 1) {
      parent.removeChild(el)
      return
    }
    if (child.nodeType === 3) {
      textParts.push(child.nodeValue ?? "")
    } else {
      // 移除 CDATA / PI / Comment 等非纯文本节点
      el.removeChild(child)
    }
  }
  const css = textParts.join("")
  if (!hasSafeCssUrls(css)) {
    parent.removeChild(el)
    return
  }
  for (const attr of Array.from(el.attributes)) {
    const attrName = attr.name.toLowerCase()
    if (attrName !== "id" && attrName !== "class") {
      el.removeAttribute(attr.name)
    }
  }
  // 展平为单一纯文本节点，彻底消除多节点/CDATA 拼接歧义
  el.textContent = css
}

function sanitizeElementTree(node: Element): void {
  const children = Array.from(node.childNodes)
  for (const child of children) {
    // 仅允许元素节点（1）与纯文本节点（3）；一律移除 CDATA（4）、PI（7）、Comment（8）及其他节点
    if (child.nodeType === 3) continue
    if (child.nodeType !== 1) {
      node.removeChild(child)
      continue
    }
    const el = child as Element
    // 严格命名空间与无前缀校验：阻断 XHTML/MathML 等外来命名空间与带前缀元素（防止序列化重造 xmlns:*）
    if (el.namespaceURI !== SVG_NAMESPACE || el.prefix) {
      node.removeChild(el)
      continue
    }
    const tag = el.localName.toLowerCase()
    if (!ALLOWED_SVG_TAGS.has(tag)) {
      node.removeChild(el)
      continue
    }
    if (tag === "style") {
      sanitizeStyleElement(node, el)
      continue
    }
    sanitizeElementAttributes(el, tag, false)
    sanitizeElementTree(el)
  }
}

function sanitizeElementAttributes(el: Element, tag: string, isRoot: boolean): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    const value = attr.value.trim()
    if (name.startsWith("on")) {
      el.removeAttribute(attr.name)
      continue
    }
    if (name === "xmlns" || name.startsWith("xmlns:")) {
      // 仅根 <svg> 允许受控标准 SVG/XLink 命名空间声明；子元素一律剥离 xmlns
      const allowedRootNs =
        isRoot &&
        ((name === "xmlns" && value === SVG_NAMESPACE) ||
          (name === "xmlns:xlink" && value === XLINK_NAMESPACE))
      if (!allowedRootNs) {
        el.removeAttribute(attr.name)
      }
      continue
    }
    if (name === "href" || name === "xlink:href") {
      if (tag === "use" && FRAGMENT_HREF_RE.test(value)) {
        continue
      }
      el.removeAttribute(attr.name)
      continue
    }
    if (!ALLOWED_SVG_ATTRS.has(name)) {
      el.removeAttribute(attr.name)
      continue
    }
    if (
      name === "style" ||
      name === "fill" ||
      name === "stroke" ||
      name === "clip-path" ||
      name === "mask" ||
      name === "marker-start" ||
      name === "marker-mid" ||
      name === "marker-end"
    ) {
      if (!hasSafeCssUrls(value)) {
        el.removeAttribute(attr.name)
      }
    }
  }
}

/**
 * 原生 DOMParser 严格白名单净化 Mermaid 输出的 SVG，不依赖第三方包。
 * 阻断非 SVG 命名空间、CDATA/PI/注释 mXSS、script/foreignObject/iframe/a/image/animate*、
 * 事件处理器、非片段 href 与危险 CSS（含转义/注释绕过）。
 */
export function sanitizeMermaidSvg(rawSvg: string): string {
  if (!rawSvg || typeof rawSvg !== "string") return ""
  const parser = new DOMParser()
  const doc = parser.parseFromString(rawSvg, "image/svg+xml")
  if (doc.querySelector("parsererror")) return ""
  const root = doc.documentElement
  if (
    !root ||
    root.prefix ||
    root.localName.toLowerCase() !== "svg" ||
    root.namespaceURI !== SVG_NAMESPACE
  ) {
    return ""
  }

  sanitizeElementAttributes(root, "svg", true)
  sanitizeElementTree(root)
  return new XMLSerializer().serializeToString(root)
}

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const lastFocusedRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    // 灯箱关闭后焦点回移到展开触发点（对话框焦点管理惯例）
    if (expanded) {
      lastFocusedRef.current = document.activeElement as HTMLElement | null
    } else if (lastFocusedRef.current) {
      lastFocusedRef.current.focus()
      lastFocusedRef.current = null
    }
  }, [expanded])
  const [scale, setScale] = useState(1)

  // Only render when the diagram scrolls into view
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: "200px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [code])

  // Render mermaid SVG once visible
  useEffect(() => {
    if (!visible) return
    let cancelled = false

    async function render() {
      try {
        const mermaid = (await import("mermaid")).default
        mermaid.initialize({
          startOnLoad: false,
          theme: "default",
          securityLevel: "strict",
          htmlLabels: false,
        })

        const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`
        const { svg: rendered } = await mermaid.render(id, code)
        const sanitized = sanitizeMermaidSvg(rendered)
        if (!cancelled) {
          if (!sanitized) {
            setError(formatOperationError(t, new Error("Invalid Mermaid SVG output")))
            setSvg(null)
          } else {
            setSvg(sanitized)
            setError(null)
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(formatOperationError(t, err))
          setSvg(null)
        }
      }
    }

    render()
    return () => { cancelled = true }
  }, [visible, code, t])

  // Prevent layout shift: compute a stable min-height from code line count
  const estimatedHeight = Math.max(80, code.split("\n").length * 20)

  // Close overlay on Escape
  useEffect(() => {
    if (!expanded) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setExpanded(false)
        setScale(1)
      }
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [expanded])

  if (error) {
    return (
      <div
        role="alert"
        className="my-2 rounded border border-destructive/60 bg-destructive/50 dark:bg-destructive/20 p-2 text-xs text-destructive"
      >
        <p className="font-medium mb-1">{t("mermaid.syntaxError", "Mermaid 语法错误")}</p>
        <pre className="whitespace-pre-wrap text-xs opacity-70">{error}</pre>
      </div>
    )
  }

  return (
    <>
      <div
        ref={containerRef}
        className="group/diagram relative my-2 overflow-x-auto rounded border border-border/40 bg-muted/20 [&>svg]:mx-auto [&>svg]:max-w-full [&>svg]:h-auto"
        style={{ minHeight: svg ? undefined : estimatedHeight }}
      >
        {svg ? (
          <>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label={t("mermaid.zoomIn")}
              className="absolute top-2 right-2 z-10 rounded-md bg-background/80 px-1.5 py-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/diagram:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={t("mermaid.zoomIn")}
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <div
              className="cursor-zoom-in p-3"
              onClick={() => setExpanded(true)}
              // SEC-ODX-01：双层防御 = mermaid securityLevel:"strict" + htmlLabels:false + 应用层 DOMParser 白名单 sanitizeMermaidSvg。
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </>
        ) : visible ? (
          <div className="flex items-center justify-center h-full p-4">
            <span className="text-xs text-muted-foreground animate-pulse">
              {t("mermaid.rendering", { defaultValue: "正在渲染图表..." })}
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full p-4">
            <span className="text-xs text-muted-foreground">
              {t("mermaid.placeholder", { defaultValue: "图表" })}
            </span>
          </div>
        )}
      </div>

      {/* Fullscreen overlay */}
      {expanded && svg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => { setExpanded(false); setScale(1) }}
          onKeyDown={(e) => { if (e.key === "Escape") { setExpanded(false); setScale(1) } }}
          role="dialog"
          aria-modal="true"
          aria-label={t("mermaid.zoomIn")}
          tabIndex={-1}
          autoFocus
        >
          <div
            className="relative h-[90vh] w-[90vw] overflow-auto rounded-lg bg-background border border-border elevation-3 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setScale((s) => Math.min(s + 0.3, 5))}
                aria-label={t("mermaid.zoomInLarge")}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                +
              </button>
              <span className="text-xs text-muted-foreground tabular-nums min-w-[3rem] text-center">{Math.round(scale * 100)}%</span>
              <button
                type="button"
                onClick={() => setScale((s) => Math.max(s - 0.3, 0.3))}
                aria-label={t("mermaid.zoomOut")}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                −
              </button>
              <button
                type="button"
                onClick={() => { setExpanded(false); setScale(1) }}
                aria-label={t("mermaid.close")}
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div
              className="origin-top-left transition-transform duration-150"
              style={{ transform: `scale(${scale})` }}
              // SEC-ODX-01：同上，经 sanitizeMermaidSvg 严格白名单净化后注入。
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </div>
      )}
    </>
  )
}

export function unwrapMermaidPre(children: ReactNode): ReactNode | null {
  const childNodes = Children.toArray(children)
  if (childNodes.length !== 1) return null
  const child = childNodes[0]
  if (!isValidElement(child)) return null
  return child.type === MermaidDiagram ? child : null
}
