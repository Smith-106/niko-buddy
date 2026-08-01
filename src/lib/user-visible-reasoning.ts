/**
 * Utilities for determining which reasoning configuration should be shown to users.
 * MIT licensed implementation.
 */

import type { ReasoningConfig } from "@/stores/wiki-store"

/**
 * Resolves the reasoning configuration to display to the user.
 * Returns the provided config, or defaults to auto mode if undefined.
 * @param reasoning - Current reasoning configuration (may be undefined)
 * @returns Resolved reasoning config with default fallback
 */
export function resolveUserVisibleReasoning(reasoning?: ReasoningConfig): ReasoningConfig {
  if (!reasoning) {
    return { mode: "auto" as const }
  }
  return reasoning
}
