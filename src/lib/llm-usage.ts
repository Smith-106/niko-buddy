export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
}

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
] as const satisfies ReadonlyArray<keyof LlmUsage>

function combineLlmUsage(
  left: LlmUsage | undefined,
  right: LlmUsage | undefined,
  combine: (leftValue: number, rightValue: number) => number,
): LlmUsage | undefined {
  if (!left) return right ? { ...right } : undefined
  if (!right) return { ...left }

  const result: LlmUsage = {}
  for (const field of USAGE_FIELDS) {
    const leftValue = left[field]
    const rightValue = right[field]
    if (leftValue === undefined && rightValue === undefined) continue
    if (leftValue === undefined) result[field] = rightValue
    else if (rightValue === undefined) result[field] = leftValue
    else result[field] = combine(leftValue, rightValue)
  }
  return result
}

export function mergeLlmUsageSnapshot(
  current: LlmUsage | undefined,
  next: LlmUsage | undefined,
): LlmUsage | undefined {
  return combineLlmUsage(current, next, Math.max)
}

export function addLlmUsage(
  current: LlmUsage | undefined,
  next: LlmUsage | undefined,
): LlmUsage | undefined {
  return combineLlmUsage(current, next, (left, right) => left + right)
}
