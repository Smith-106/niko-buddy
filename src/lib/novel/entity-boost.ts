/**
 * Quality Foundation v1 / FR-M2: additive entity-link boost for context retrieval.
 * Pattern inspired by multi-signal fusion (semantic + lexical + entity), not a port.
 */

export interface EntityBoostHit {
  id: string
  score: number
  text: string
}

/**
 * Returns a new array sorted by boosted score (desc). Hits whose `text` mentions
 * any entity name (case-insensitive substring, length ≥ 2) receive `weight` added
 * once per distinct matching entity (capped so total boost ≤ weight * min(3, entities.length)).
 * Empty entities or weight ≤ 0 returns hits sorted by original score only.
 */
export function applyEntityBoost(
  hits: EntityBoostHit[],
  entities: string[],
  weight: number,
): Array<{ id: string; score: number }> {
  if (hits.length === 0) return []
  const w = Number.isFinite(weight) ? weight : 0
  const names = normalizeEntityNames(entities)
  if (names.length === 0 || w <= 0) {
    return [...hits]
      .map((h) => ({ id: h.id, score: h.score }))
      .sort((a, b) => b.score - a.score)
  }

  const maxMatches = Math.min(3, names.length)
  return hits
    .map((hit) => {
      const hay = hit.text.toLowerCase()
      let matches = 0
      for (const name of names) {
        if (hay.includes(name)) {
          matches += 1
          if (matches >= maxMatches) break
        }
      }
      return { id: hit.id, score: hit.score + matches * w }
    })
    .sort((a, b) => b.score - a.score)
}

export function normalizeEntityNames(entities: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of entities) {
    const n = raw.trim().toLowerCase()
    if (n.length < 2) continue
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/**
 * Reorder items by entity-boosted rank while preserving full objects.
 * Base score defaults to reverse index order (first item highest) when no score field.
 */
export function reorderByEntityBoost<T extends { title?: string; snippet?: string; path?: string; id?: string; score?: number }>(
  items: T[],
  entities: string[],
  weight: number,
): T[] {
  if (items.length === 0 || entities.length === 0 || weight <= 0) return items
  const n = items.length
  // Base scores are close so a single entity match (typical weight 0.3–0.5) can reorder.
  const hits: EntityBoostHit[] = items.map((item, index) => ({
    id: String(index),
    score: typeof item.score === "number" ? item.score : 1 + (n - index) * 0.01,
    text: [item.title, item.snippet, item.path, item.id].filter(Boolean).join(" "),
  }))
  const ranked = applyEntityBoost(hits, entities, weight)
  return ranked.map((r) => items[Number(r.id)]!).filter(Boolean)
}
