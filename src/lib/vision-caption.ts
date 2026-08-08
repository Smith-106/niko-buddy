/**
 * @license MIT © QMAI
 *
 * Vision-caption helper — sends an image plus a factual prompt to a
 * vision-capable LLM and returns the model's plain-text description.
 *
 * The caller provides raw base64 + mediaType; this module knows nothing
 * about ingest, caching, or disk paths.
 */
import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat, type ChatMessage } from "./llm-client"

/**
 * Fixed factual prompt used when no surrounding document context is
 * available.  Instructs the model to describe visible text verbatim,
 * chart axes/values, diagram structure, and key visual elements —
 * without speculation or editorial language.
 *
 * Output is constrained to 2-4 sentences of plain text (no markdown)
 * so the caption can be spliced directly into markdown alt-text.
 */
export const CAPTION_PROMPT =
  "Describe this image factually for a knowledge-base index. Include: any visible text verbatim, chart axes and values, diagram structure (boxes/arrows/labels), key visual elements. Do NOT speculate or editorialize. 2 to 4 sentences. Output plain text only — no markdown, no preamble."

/**
 * Build a context-aware prompt that includes the document text
 * surrounding the image.  The model is told the flanking text may
 * or may not be relevant and must judge for itself.
 *
 * Whitespace-only sides collapse to `(none)` to avoid empty
 * delimited blocks that some models misinterpret.
 */
export function buildCaptionPromptWithContext(
  before: string,
  after: string,
): string {
  const fmt = (s: string): string => {
    const trimmed = s.trim()
    return trimmed.length > 0 ? trimmed : "(none)"
  }
  return [
    "The image is embedded in a longer document. Here is the text that appears IMMEDIATELY BEFORE and AFTER this image in the source:",
    "",
    "--- Text before image ---",
    fmt(before),
    "--- Text after image ---",
    fmt(after),
    "--- End surrounding text ---",
    "",
    "This surrounding text MAY help describe the image — for example, a sentence like \"Figure 3: Q2 revenue chart\" tells you what the chart actually plots. It MAY ALSO be unrelated body text that just happens to flank the image. Use your judgment: if a passage clearly identifies, references, or labels the image, anchor your caption to it; if not, ignore the surrounding text and describe what you see.",
    "",
    "Now describe the image factually for a knowledge-base index. Include: any visible text verbatim, chart axes and values, diagram structure (boxes/arrows/labels), key visual elements. If the surrounding text contains a relevant figure number / caption / referent, incorporate that specifically. Do NOT invent details that aren't visible in the image or directly stated in the surrounding text. 2 to 4 sentences. Output plain text only — no markdown, no preamble.",
  ].join("\n")
}

export interface CaptionOptions {
  /** Upper bound on model output tokens. Default 4096 covers reasoning models. */
  maxTokens?: number
  /** Sampling temperature — 0 for deterministic captions. */
  temperature?: number
  /** Document text immediately before the image in the source. */
  contextBefore?: string
  /** Document text immediately after the image in the source. */
  contextAfter?: string
}

/**
 * Caption a single image via a vision-capable LLM.
 *
 * @param imageBase64  Raw base64 of the image bytes (NOT a `data:` URL).
 * @param mediaType    MIME type, e.g. `"image/png"`.
 * @param llmConfig    LLM provider configuration.
 * @param signal       Optional AbortSignal for cancellation / timeout.
 * @param options      Optional tuning (max tokens, temperature, context).
 * @returns Plain-text caption with surrounding whitespace trimmed.
 *
 * Errors from `streamChat` are rethrown so callers can apply their
 * own fault-tolerance policy (e.g. skip-on-fail in batch captioning).
 */
export async function captionImage(
  imageBase64: string,
  mediaType: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  options?: CaptionOptions,
): Promise<string> {
  const before = options?.contextBefore?.trim() ?? ""
  const after = options?.contextAfter?.trim() ?? ""
  const promptText =
    before.length > 0 || after.length > 0
      ? buildCaptionPromptWithContext(before, after)
      : CAPTION_PROMPT

  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: promptText },
        { type: "image", mediaType, dataBase64: imageBase64 },
      ],
    },
  ]

  const tokens: string[] = []
  let streamError: Error | null = null

  await streamChat(
    llmConfig,
    messages,
    {
      onToken: (t) => tokens.push(t),
      onDone: () => {},
      onError: (e) => { streamError = e },
    },
    signal,
    {
      temperature: options?.temperature ?? 0,
      max_tokens: options?.maxTokens ?? 4096,
    },
  )

  if (streamError) throw streamError as Error
  return tokens.join("").trim()
}
