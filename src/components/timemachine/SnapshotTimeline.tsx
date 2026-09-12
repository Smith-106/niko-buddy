import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  TIMELINE_PAGE_SIZE,
  changedWorldStates,
  diffTotals,
  formatBytes,
  formatFieldDiff,
  hasNextPage,
  isEmptyDiff,
  listSnapshotChain,
  nextOffset,
  previewSnapshotPoint,
  restoreSnapshotAtomic,
  touchesTruthSurface,
  truncateValue,
  type RestoreOutcome,
  type SnapshotChain,
  type SnapshotDiff,
  type SnapshotMeta,
} from "@/lib/novel";

export interface SnapshotTimelineProps {
  projectPath: string;
  /** 恢复完成后通知宿主（例如刷新状态面板）。 */
  onRestored?: (outcome: RestoreOutcome) => void;
}

/**
 * 快照时间线：枚举既有 `.novel/snapshots/` 链 + 双点选择对照 + [恢复到此处]。
 *
 * 恢复是**原子回滚**（Rust 侧 `snapshot_restore_atomic`），本组件只负责收集确认令牌；
 * 触及真源面时必须二次确认，且回滚过（rolled_back）一律展示为失败。
 */
export function SnapshotTimeline({ projectPath, onRestored }: SnapshotTimelineProps) {
  const { t } = useTranslation();
  const [chain, setChain] = useState<SnapshotChain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);
  const [diff, setDiff] = useState<SnapshotDiff | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<SnapshotMeta | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * 代数计数器：项目切换后旧分页响应不得覆盖新链。
   * 旧实现直接 setChain，切换项目时旧请求回包会把上一个项目的快照链写回。
   */
  const loadRunRef = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const runId = ++loadRunRef.current;
      try {
        const page = await listSnapshotChain(projectPath, offset, TIMELINE_PAGE_SIZE);
        if (runId !== loadRunRef.current) return;
        setChain((prev) =>
          prev && offset > 0
            ? { ...page, offset: 0, points: [...prev.points, ...page.points] }
            : page,
        );
        setError(null);
      } catch (e) {
        if (runId !== loadRunRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [projectPath],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  useEffect(() => {
    if (!leftId) {
      setDiff(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const d = await previewSnapshotPoint(projectPath, leftId);
        if (alive) setDiff(d);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectPath, leftId]);

  const totals = useMemo(() => (diff ? diffTotals(diff) : null), [diff]);
  const changed = useMemo(() => (diff ? changedWorldStates(diff) : []), [diff]);

  const runRestore = useCallback(
    async (snapshot: SnapshotMeta, token: string) => {
      setBusy(true);
      try {
        const outcome = await restoreSnapshotAtomic(projectPath, snapshot.id, token);
        setRestoreResult(outcome);
        setPendingConfirm(null);
        onRestored?.(outcome);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [projectPath, onRestored],
  );

  return (
    <section data-testid="snapshot-timeline" className="flex h-full flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("timemachine.title")}</h2>
        <span className="text-xs opacity-70">
          {t("timemachine.count", { count: chain?.total ?? 0 })}
        </span>
      </header>

      {error ? (
        <p role="alert" className="text-sm text-red-500" data-testid="snapshot-error">
          {error}
        </p>
      ) : null}

      <ol className="flex-1 space-y-1 overflow-auto" data-testid="snapshot-chain">
        {(chain?.points ?? []).map((point) => {
          const isLeft = point.id === leftId;
          const isRight = point.id === rightId;
          return (
            <li
              key={point.id}
              data-testid="snapshot-point"
              className={`flex items-center justify-between rounded px-2 py-1 text-sm ${
                isLeft || isRight ? "bg-amber-500/15" : "hover:bg-muted"
              }`}
            >
              <button type="button" onClick={() => setLeftId(point.id)}>
                <span className="font-mono">{point.id}</span>
                {point.chapter_span ? (
                  <span className="ml-2 opacity-60">
                    {t("timemachine.chapterSpan", { span: point.chapter_span })}
                  </span>
                ) : null}
                <span className="ml-2 opacity-50">{formatBytes(point.size_bytes)}</span>
              </button>
              <span className="flex gap-2">
                <button type="button" onClick={() => setRightId(point.id)}>
                  {t("timemachine.compareSelect")}
                </button>
                <button
                  type="button"
                  data-testid={`snapshot-restore-${point.id}`}
                  onClick={() => setPendingConfirm(point)}
                >
                  {t("timemachine.restore.action")}
                </button>
              </span>
            </li>
          );
        })}
      </ol>

      {chain && hasNextPage(chain) ? (
        <button type="button" onClick={() => void load(nextOffset(chain))}>
          {t("timemachine.loadMore")}
        </button>
      ) : null}

      {diff ? (
        <section aria-label={t("timemachine.compareTitle")} data-testid="snapshot-diff">
          <p className="text-sm">
            {t("timemachine.compareTitle")} {leftId} {t("timemachine.diff.before")}
            {rightId ? ` / ${rightId}` : ` ${t("timemachine.diff.after")}`}
          </p>
          {isEmptyDiff(diff) ? (
            <p className="text-sm opacity-70">{t("timemachine.diff.empty")}</p>
          ) : (
            <>
              <p className="text-xs opacity-70" data-testid="snapshot-diff-totals">
                {t("timemachine.diff.totals", {
                  status: totals?.statusChanges ?? 0,
                  projection: totals?.projectionChanges ?? 0,
                  world: totals?.worldStateChanges ?? 0,
                })}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {[...diff.status_diff, ...diff.projection_status_diff]
                  .slice(0, 20)
                  .map((f) => (
                    <li key={f.path} className="font-mono">
                      {truncateValue(formatFieldDiff(f))}
                    </li>
                  ))}
                {changed.flatMap((s) =>
                  s.changed.slice(0, 10).map((c) => (
                    <li key={`${s.state}:${c.path}`} className="font-mono">
                      [{s.state}] {truncateValue(formatFieldDiff(c))}
                    </li>
                  )),
                )}
              </ul>
            </>
          )}
        </section>
      ) : null}

      {pendingConfirm ? (
        <div role="dialog" data-testid="snapshot-restore-confirm" className="rounded border p-3">
          <p>{t("timemachine.restore.confirm", { id: pendingConfirm.id })}</p>
          {diff && touchesTruthSurface(diff) ? (
            <p className="text-xs text-amber-600" data-testid="snapshot-truth-surface-warning">
              {t("timemachine.restore.truthSurface")}
            </p>
          ) : null}
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={() => setPendingConfirm(null)}>
              {t("common.close")}
            </button>
            <button
              type="button"
              disabled={busy}
              data-testid="snapshot-restore-confirm-run"
              onClick={() => void runRestore(pendingConfirm, `ui-${pendingConfirm.id}`)}
            >
              {t("timemachine.restore.action")}
            </button>
          </div>
        </div>
      ) : null}

      {restoreResult ? (
        <p data-testid="snapshot-restore-result" className="text-sm">
          {restoreResult.rolled_back
            ? t("timemachine.restore.rolledBack")
            : t("timemachine.restore.done", { count: restoreResult.restored.length })}
          {restoreResult.verify && !restoreResult.verify.verified
            ? ` — ${t("timemachine.verify.failed")}`
            : null}
        </p>
      ) : null}
    </section>
  );
}

export default SnapshotTimeline;
