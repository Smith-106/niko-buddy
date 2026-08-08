/**
 * Determines the appropriate action for wiki pages when a source document is deleted.
 * Pure function designed to be unit-testable in isolation.
 * MIT licensed implementation.
 */

/**
 * Decision outcome for handling a wiki page after source deletion.
 */
export type DeleteDecision =
  /** Keep the page but update its sources list */
  | { action: "keep"; updatedSources: string[] }
  /** Remove the page because the deleting source was its only reference */
  | { action: "delete" }
  /** Bypass the page - it wasn't actually referencing this source (false positive) */
  | { action: "skip"; reason: string }

/**
 * Evaluates whether a wiki page should be kept, deleted, or skipped when removing a source file.
 * Performs case-insensitive comparison to handle filename variations.
 * 
 * Decision logic:
 * 1. If `deletingSource` not found in sources → skip (protects innocent pages)
 * 2. If found with other sources remaining → keep with filtered list
 * 3. If found and no other sources → delete
 * 
 * @param frontmatterSources - Current source files referenced by the wiki page
 * @param deletingSource - The source file being removed by the user
 * @returns Action to take and updated sources if keeping the page
 */
export function decidePageFate(
  frontmatterSources: readonly string[],
  deletingSource: string,
): DeleteDecision {
  const targetLower = deletingSource.toLowerCase()

  const isInList = frontmatterSources.some(
    (s) => s.toLowerCase() === targetLower,
  )
  if (!isInList) {
    return {
      action: "skip" as const,
      reason: `page sources do not include "${deletingSource}"`,
    }
  }

  const survivors = frontmatterSources.filter(
    (s) => s.toLowerCase() !== targetLower,
  )

  if (survivors.length > 0) {
    return { action: "keep" as const, updatedSources: survivors }
  }

  return { action: "delete" as const }
}
