import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, Copy, Image } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import defaultTemplatesJson from "../../../config/cover-platform-templates.json"

/**
 * CoverPromptWorkbench — 封面 Prompt 工作台（F-012，净新独立视图）。
 *
 * 边界：不进写作主链热路径；纯客户端一次性产出 —— 不调用 streamChat、
 * 不走 Draft-first 草稿态、无任何写入。平台模板外部化于
 * config/cover-platform-templates.json（番茄/起点/晋江），人工维护。
 */

export interface CoverPlatformTemplate {
  platform: string
  style: string
  dimensions: { width: number; height: number }
  promptTemplate: string
}

const FALLBACK_DIMENSIONS = { width: 600, height: 800 }

/** 防御性规范化：丢弃缺 platform/promptTemplate 的条目，尺寸非法回退默认值（空模板优雅降级）。 */
export function normalizeCoverPlatforms(raw: unknown): CoverPlatformTemplate[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
  const platforms = (raw as { platforms?: unknown }).platforms
  if (!Array.isArray(platforms)) return []

  const out: CoverPlatformTemplate[] = []
  for (const entry of platforms) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    const platform = typeof e.platform === "string" ? e.platform.trim() : ""
    const promptTemplate = typeof e.promptTemplate === "string" ? e.promptTemplate : ""
    if (!platform || !promptTemplate) continue

    const dims = (e.dimensions ?? {}) as Record<string, unknown>
    const positive = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : fallback
    out.push({
      platform,
      style: typeof e.style === "string" ? e.style : "",
      dimensions: {
        width: positive(dims.width, FALLBACK_DIMENSIONS.width),
        height: positive(dims.height, FALLBACK_DIMENSIONS.height),
      },
      promptTemplate,
    })
  }
  return out
}

const DEFAULT_TEMPLATES = normalizeCoverPlatforms(defaultTemplatesJson)

export interface CoverPromptInput {
  title: string
  genre: string
  keywords: string
}

/** 纯客户端占位符替换：{{platform}}/{{style}}/{{width}}/{{height}}/{{title}}/{{genre}}/{{keywords}}。 */
export function buildCoverPrompt(template: CoverPlatformTemplate, input: CoverPromptInput): string {
  // ES2020 lib 无 replaceAll，用 split/join 实现全量替换
  const substitutions: Array<[string, string]> = [
    ["platform", template.platform],
    ["style", template.style],
    ["width", String(template.dimensions.width)],
    ["height", String(template.dimensions.height)],
    ["title", input.title.trim()],
    ["genre", input.genre.trim()],
    ["keywords", input.keywords.trim()],
  ]
  return substitutions.reduce(
    (text, [token, value]) => text.split(`{{${token}}}`).join(value),
    template.promptTemplate,
  )
}

export function CoverPromptWorkbench({ templates }: { templates?: CoverPlatformTemplate[] }) {
  const { t } = useTranslation()
  const platforms = templates ?? DEFAULT_TEMPLATES
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(platforms[0]?.platform ?? null)
  const [title, setTitle] = useState("")
  const [genre, setGenre] = useState("")
  const [keywords, setKeywords] = useState("")
  const [copied, setCopied] = useState(false)

  const active = platforms.find((p) => p.platform === selectedPlatform) ?? null
  const prompt = useMemo(
    () => (active ? buildCoverPrompt(active, { title, genre, keywords }) : ""),
    [active, title, genre, keywords],
  )

  // 空模板优雅降级：config 缺失/为空时给出可读提示，不崩溃。
  if (platforms.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
        <Image className="h-8 w-8 text-muted-foreground/40" />
        <p>{t("novel.coverWorkbench.emptyTemplates")}</p>
        <p className="text-xs italic">config/cover-platform-templates.json</p>
      </div>
    )
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(prompt)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 剪贴板不可用时静默（预览文本仍可手动复制） */
    }
  }

  return (
    <div className="flex flex-col gap-4" data-cover-workbench="true">
      {/* 步骤 1：平台选择 */}
      <div>
        <div className="mb-1.5 text-xs font-semibold text-muted-foreground">{t("novel.coverWorkbench.platform")}</div>
        <div className="flex flex-wrap gap-1.5">
          {platforms.map((p) => (
            <button
              key={p.platform}
              type="button"
              data-cover-platform={p.platform}
              onClick={() => setSelectedPlatform(p.platform)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                selectedPlatform === p.platform
                  ? "border-primary bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent/50"
              }`}
            >
              {p.platform}
            </button>
          ))}
        </div>
      </div>

      {/* 步骤 2：风格 + 尺寸确认（来自模板，只读展示） */}
      {active && (
        <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
          <div>
            <span className="font-semibold">{t("novel.coverWorkbench.styleLabel")}：</span>
            {active.style || t("novel.coverWorkbench.noStyle")}
          </div>
          <div className="mt-1">
            <span className="font-semibold">{t("novel.coverWorkbench.dimensions")}：</span>
            <span data-cover-dimensions="true">{active.dimensions.width}×{active.dimensions.height}</span> px
          </div>
        </div>
      )}

      {/* 步骤 3：作品信息输入 */}
      <div className="grid gap-2.5">
        <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
          {t("novel.coverWorkbench.bookTitle")}
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("novel.coverWorkbench.bookTitlePlaceholder")} data-cover-input="title" />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
          {t("novel.coverWorkbench.genre")}
          <Input value={genre} onChange={(e) => setGenre(e.target.value)} placeholder={t("novel.coverWorkbench.genrePlaceholder")} data-cover-input="genre" />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
          {t("novel.coverWorkbench.keywords")}
          <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder={t("novel.coverWorkbench.keywordsPlaceholder")} data-cover-input="keywords" />
        </label>
      </div>

      {/* 步骤 4：Prompt 预览 + 一键复制 */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground">{t("novel.coverWorkbench.promptPreview")}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void handleCopy()} disabled={!prompt} data-cover-copy="true">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? t("novel.coverWorkbench.copied") : t("novel.coverWorkbench.copy")}
          </Button>
        </div>
        <textarea
          readOnly
          value={prompt}
          data-cover-prompt-preview="true"
          rows={6}
          className="w-full resize-none rounded-md border bg-muted/20 p-2.5 text-xs leading-relaxed text-foreground outline-none"
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground">{t("novel.coverWorkbench.hint")}</p>
      </div>
    </div>
  )
}
