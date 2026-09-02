// Canon 跨 revision 对比结果纯展示组件（P2 对比模式）。
//
// 只渲染 `CanonFact` 投影字段（predicate / sourceId / targetId / validAt / invalidAt /
// modality），绝不含内部句柄 `knownBy` / `digest`——与投影层 allowlist 对齐。

import { useTranslation } from "react-i18next"
import type { CanonFact } from "@/lib/novel/canon-graph-client"
import type { CanonRevisionDiff } from "@/lib/novel/canon-revision-diff"

export interface CanonRevisionDiffViewProps {
  diff: CanonRevisionDiff
  revA: number | null
  revB: number | null
}

function formatChapter(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return String(value)
}

/** 单条事实的展示行：predicate + source → target + valid_at/invalid_at/modality。 */
function FactLine({ fact }: { fact: CanonFact }) {
  return (
    <div className="px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="font-medium">{fact.predicate}</span>
        <span className="text-muted-foreground">
          {fact.sourceId} → {fact.targetId}
        </span>
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        valid_at: {formatChapter(fact.validAt)} · invalid_at:{" "}
        {formatChapter(fact.invalidAt)}
        {fact.modality ? ` · modality: ${fact.modality}` : ""}
      </div>
    </div>
  )
}

export function CanonRevisionDiffView({ diff, revA, revB }: CanonRevisionDiffViewProps) {
  const { t } = useTranslation()

  const summary = t("canon.revisionDiff.summary", {
    added: diff.added.length,
    superseded: diff.superseded.length,
    invalidated: diff.invalidated.length,
    removed: diff.removed.length,
  })

  return (
    <div data-testid="canon-revision-diff">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span
          className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
          data-testid="diff-summary"
        >
          {summary}
        </span>
        <span className="text-xs text-muted-foreground" data-testid="diff-range">
          {revA === null
            ? t("canon.revisionDiff.baseline")
            : t("canon.revisionViewer.groupLabel", { rev: revA })}
          {" → "}
          {revB === null
            ? "—"
            : t("canon.revisionViewer.groupLabel", { rev: revB })}
        </span>
      </div>

      {diff.total === 0 && (
        <p
          className="px-1 py-3 text-sm text-muted-foreground"
          data-testid="diff-empty"
        >
          {t("canon.revisionDiff.empty")}
        </p>
      )}

      {diff.superseded.length > 0 && (
        <section className="mb-3" data-testid="diff-superseded-section">
          <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
            {t("canon.revisionDiff.superseded")} ({diff.superseded.length})
          </h3>
          <ul className="divide-y rounded-md border bg-muted/20 text-sm">
            {diff.superseded.map((pair) => (
              <li key={`${pair.before.id}:${pair.after.id}`} data-testid="diff-superseded-item">
                <FactLine fact={pair.before} />
                <div className="border-t px-3 py-1 text-xs text-muted-foreground">
                  {t("canon.revisionDiff.pairArrow", {
                    before: pair.before.id,
                    after: pair.after.id,
                  })}
                </div>
                <FactLine fact={pair.after} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {diff.added.length > 0 && (
        <section className="mb-3" data-testid="diff-added-section">
          <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
            {t("canon.revisionDiff.added")} ({diff.added.length})
          </h3>
          <ul className="divide-y rounded-md border bg-muted/20 text-sm">
            {diff.added.map((fact) => (
              <li key={fact.id} data-testid="diff-added-item">
                <FactLine fact={fact} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {diff.invalidated.length > 0 && (
        <section className="mb-3" data-testid="diff-invalidated-section">
          <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
            {t("canon.revisionDiff.invalidated")} ({diff.invalidated.length})
          </h3>
          <ul className="divide-y rounded-md border bg-muted/20 text-sm">
            {diff.invalidated.map((fact) => (
              <li key={fact.id} data-testid="diff-invalidated-item">
                <FactLine fact={fact} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {diff.removed.length > 0 && (
        <section className="mb-3" data-testid="diff-removed-section">
          <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
            {t("canon.revisionDiff.removed")} ({diff.removed.length})
          </h3>
          <ul className="divide-y rounded-md border bg-muted/20 text-sm">
            {diff.removed.map((fact) => (
              <li key={fact.id} data-testid="diff-removed-item">
                <FactLine fact={fact} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
