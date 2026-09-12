import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  GATE_TIMEOUT_MS,
  type GateOutcome,
  type PendingGate,
  confirmGate,
  isExpired,
  rejectGate,
  remainingWindowMs,
} from "@/lib/novel";

export interface ConfirmGateDialogProps {
  /** 待裁决请求；为空时不渲染。 */
  pending: PendingGate | null;
  /** 裁决完成回调；超时自动拒绝也会走这里。 */
  onResolved?: (outcome: GateOutcome) => void;
  /** 注入时钟，便于测试倒计时与超时分支。 */
  nowMs?: () => number;
}

const CLASS_LABEL: Record<PendingGate["class"], string> = {
  rebuildable: "gate.confirm.class.rebuildable",
  derived_rebuildable: "gate.confirm.class.derived",
  irreversible: "gate.confirm.class.irreversible",
};

const CRITERION_LABEL: Record<string, string> = {
  protected_prefix: "gate.confirm.criterion.protected",
  destructive_op: "gate.confirm.criterion.destructive",
  rebuildable: "gate.confirm.criterion.rebuildable",
  external_side_effect: "gate.confirm.criterion.external",
};

/**
 * 写入确认门对话框：展示 op / target / 三分类 / 四判据命中 / diff 摘要，
 * 提供 [确认] [拒绝]；窗口到期自动关闭并按拒绝处理（与 Rust 侧同义）。
 */
export function ConfirmGateDialog({ pending, onResolved, nowMs }: ConfirmGateDialogProps) {
  const { t } = useTranslation();
  const clock = nowMs ?? (() => Date.now());
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!pending) return;
    setRemaining(remainingWindowMs(pending, clock()));
    const timer = setInterval(() => {
      setRemaining(remainingWindowMs(pending, clock()));
    }, 1000);
    return () => clearInterval(timer);
  }, [pending, clock]);

  const settle = useCallback(
    async (accept: boolean) => {
      if (!pending || busy) return;
      setBusy(true);
      try {
        const outcome = accept
          ? await confirmGate(pending.request_id)
          : await rejectGate(pending.request_id, "rejected in dialog");
        onResolved?.(outcome);
      } finally {
        setBusy(false);
      }
    },
    [pending, busy, onResolved],
  );

  // 120s 无响应 = 拒绝；与 Rust 侧的超时裁决保持一致。
  useEffect(() => {
    if (!pending) return;
    if (remaining > 0) return;
    const deadline = pending.deadline_ms;
    if (clock() < deadline) return;
    void settle(false);
  }, [pending, remaining, clock, settle]);

  if (!pending) return null;

  const expired = isExpired(pending, clock());
  const seconds = Math.ceil(remaining / 1000);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-gate-title"
      data-testid="confirm-gate-dialog"
      data-gate-timeout-ms={GATE_TIMEOUT_MS}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-lg rounded-lg bg-background p-5 shadow-xl">
        <h2 id="confirm-gate-title" className="text-lg font-semibold">
          {t("gate.confirm.title")}
        </h2>

        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 opacity-60">op</dt>
            <dd className="font-mono">{pending.op}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 opacity-60">target</dt>
            <dd className="break-all font-mono" data-testid="confirm-gate-target">
              {pending.target}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 opacity-60">{t("gate.confirm.classLabel")}</dt>
            <dd data-testid="confirm-gate-class">{t(CLASS_LABEL[pending.class])}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 opacity-60">{t("gate.confirm.criteriaLabel")}</dt>
            <dd className="flex flex-wrap gap-1" data-testid="confirm-gate-criteria">
              {pending.hit_criteria.map((c) => (
                <span key={c} className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs">
                  {CRITERION_LABEL[c] ? t(CRITERION_LABEL[c]) : c}
                </span>
              ))}
            </dd>
          </div>
        </dl>

        <pre
          className="mt-3 max-h-32 overflow-auto rounded bg-muted p-2 text-xs"
          data-testid="confirm-gate-diff"
        >
          {pending.diff_summary}
        </pre>

        <p className="mt-2 text-xs opacity-70" data-testid="confirm-gate-timeout">
          {expired ? t("gate.confirm.timeout") : t("gate.confirm.windowNotice", { seconds })}
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            data-testid="confirm-gate-reject"
            onClick={() => void settle(false)}
          >
            {t("gate.confirm.reject")}
          </button>
          <button
            type="button"
            disabled={busy || expired}
            data-testid="confirm-gate-accept"
            onClick={() => void settle(true)}
          >
            {t("gate.confirm.accept")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 熔断横幅：停机等待人工，不因重启自动恢复。 */
export function GateHaltBanner({
  halted,
  onResume,
}: {
  halted: boolean;
  onResume?: () => void;
}) {
  const { t } = useTranslation();
  if (!halted) return null;
  return (
    <div
      role="alert"
      data-testid="gate-halt-banner"
      className="flex items-center justify-between gap-3 bg-red-600/15 px-4 py-2 text-sm"
    >
      <span>{t("gate.halt.banner")}</span>
      {onResume ? (
        <button type="button" onClick={onResume} data-testid="gate-halt-resume">
          {t("gate.halt.resume")}
        </button>
      ) : null}
    </div>
  );
}

export default ConfirmGateDialog;
