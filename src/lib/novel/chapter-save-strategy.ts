export type ChapterSaveStrategy =
  | {
    action: "direct_next_chapter"
  }
  | {
    action: "direct_explicit_target_new"
    targetChapterNumber: number
  }

export function decideChapterSaveStrategy(input: {
  selectedChapterNumber: number | null
  /**
   * CORR-012 (odyssey): this field is currently unused by the decision logic
   * below (the sole caller chat-panel.tsx hardcodes false). It was intended
   * to guard against overwriting an existing chapter that already has body
   * content, but that guard was never implemented. Kept in the signature for
   * backward compatibility; implementing the guard is a behavior change that
   * needs a product decision (block overwrite vs prompt vs skip) — tracked as
   * a documented constraint, not fixed here.
   */
  selectedChapterHasBody: boolean
  generatedTargetChapterNumber: number | null
  generatedTargetExists: boolean
}): ChapterSaveStrategy {
  if (
    input.generatedTargetChapterNumber &&
    input.generatedTargetChapterNumber > 0 &&
    input.generatedTargetChapterNumber !== input.selectedChapterNumber
  ) {
    if (!input.generatedTargetExists) {
      return {
        action: "direct_explicit_target_new",
        targetChapterNumber: input.generatedTargetChapterNumber,
      }
    }
  }

  return {
    action: "direct_next_chapter",
  }
}

export function detectGeneratedTargetChapterNumber(content: string): number | null {
  const zhMatch = content.match(/#?\s*第\s*(\d+)\s*章/u)
  if (zhMatch?.[1]) return Number.parseInt(zhMatch[1], 10)

  const enMatch = content.match(/#?\s*chapter\s+(\d+)\b/i)
  if (enMatch?.[1]) return Number.parseInt(enMatch[1], 10)

  return null
}
