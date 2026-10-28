import { useCallback, useEffect, useRef, useState } from "react";
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
import { toErrorMessage } from "@/lib/utils"
import { MeterBar, StatusChip } from "@/components/ui/status-visuals"

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

const GATE_CRITERION_ORDER = Object.keys(CRITERION_LABEL);

function orderedHitCriteria(hits: readonly string[]): string[] {
  const rank = (key: string) => {
    const index = GATE_CRITERION_ORDER.indexOf(key);
    return index === -1 ? GATE_CRITERION_ORDER.length : index;
  };
  return [...hits].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * 写入确认门对话框：展示 op / target / 三分类 / 四判据命中 / diff 摘要，
 * 提供 [确认] [拒绝]；窗口到期自动关闭并按拒绝处理（与 Rust 侧同义）。
 */
export function ConfirmGateDialog({ pending, onResolved, nowMs }: ConfirmGateDialogProps) {
  const { t } = useTranslation();
  const clock = nowMs ?? (() => Date.now());
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(0);
  // C3：裁决 IPC 失败必须给可修复反馈（错误态 + 重试），不允许静默无响应。
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState<boolean | null>(null);
  // 自动超时裁决去重：按 request_id 记录，同一请求只自动发起一次；
  // 失败后交给用户重试，不因果主轮询导致 pending 对象身份变化被反复重发（重试风暴）。
  const autoSettledRequestIdRef = useRef<string | null>(null);
  // 宿主每次轮询都会传入新的 pending 对象；错误态/去重标记只在
  // request_id 变化（真正的新请求）时重置，不能被轮询身份变化清掉。
  const activeRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    const requestId = pending?.request_id ?? null;
    if (requestId === activeRequestIdRef.current) return;
    activeRequestIdRef.current = requestId;
    autoSettledRequestIdRef.current = null;
    setErrorMessage(null);
    setLastAttempt(null);
  }, [pending]);

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
      setLastAttempt(accept);
      setErrorMessage(null);
      try {
        const outcome = accept
          ? await confirmGate(pending.request_id)
          : await rejectGate(pending.request_id, "rejected in dialog");
        onResolved?.(outcome);
      } catch (error) {
        // 裁决失败 → 错误态；用户可通过重试按钮重发最后一次尝试。
        setErrorMessage(toErrorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [pending, busy, onResolved],
  );

  // 120s 无响应 = 拒绝；与 Rust 侧的超时裁决保持一致。
  // 每个 request_id 只自动裁决一次；失败进入错误态后由用户决定是否重试。
  useEffect(() => {
    if (!pending) return;
    if (autoSettledRequestIdRef.current === pending.request_id) return;
    if (remaining > 0) return;
    const deadline = pending.deadline_ms;
    if (clock() < deadline) return;
    autoSettledRequestIdRef.current = pending.request_id;
    void settle(false);
  }, [pending, remaining, clock, settle]);

  useEffect(() => {
    if (!pending) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        void settle(false);
      }
      // UX-G3-D6: 手写 dialog 无焦点陷阱时 Tab 会逃逸到底层页面。
      // 在容器内首尾元素间循环，保持纯键盘用户不迷失。
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pending, busy, settle]);

  // UX-G3-D6: 打开时记录此前焦点并聚焦确认区，关闭时归还（WCAG 2.4.3）。
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const acceptRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!pending) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    // 同步聚焦：本 effect 在 ref 已挂载后执行，无需 setTimeout(0) 再等一拍。
    // 旧实现的定时器在 jsdom 高负载（全量套件并行）下会被饿死，导致
    // 首屏焦点停留在 body —— 既是测试 flake，也是真实的可访问性时序风险。
    if (acceptRef.current && !acceptRef.current.disabled) acceptRef.current.focus();
    else dialogRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus?.();
      previouslyFocusedRef.current = null;
    };
  }, [pending?.request_id]);

  if (!pending) return null;

  const expired = isExpired(pending, clock());
  const seconds = Math.ceil(remaining / 1000);

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-gate-title"
      data-testid="confirm-gate-dialog"
      data-gate-timeout-ms={GATE_TIMEOUT_MS}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 outline-none"
    >
      <div className="w-full max-w-lg rounded-lg bg-background p-5 elevation-3">
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
            <dd className="flex min-w-0 flex-col gap-1" data-testid="confirm-gate-criteria">
              <MeterBar
                label={t("gate.confirm.criteriaLabel")}
                value={pending.hit_criteria.length}
                max={Math.max(GATE_CRITERION_ORDER.length, pending.hit_criteria.length)}
              />
              <div className="flex flex-wrap gap-1">
                {orderedHitCriteria(pending.hit_criteria).map((c) => (
                  <StatusChip
                    key={c}
                    tone="warning"
                    label={CRITERION_LABEL[c] ? t(CRITERION_LABEL[c]) : c}
                  />
                ))}
              </div>
            </dd>
          </div>
        </dl>

        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">diff</summary>
          <pre
            className="mt-1 max-h-32 overflow-auto rounded bg-muted p-2 text-xs"
            data-testid="confirm-gate-diff"
          >
            {pending.diff_summary}
          </pre>
        </details>

        <p className="mt-2 text-xs opacity-70" data-testid="confirm-gate-timeout">
          {expired ? t("gate.confirm.timeout") : t("gate.confirm.windowNotice", { seconds })}
        </p>

        {errorMessage ? (
          <div
            role="alert"
            data-testid="confirm-gate-error"
            className="mt-3 flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          >
            <span className="break-all">{t("gate.confirm.error", { message: errorMessage })}</span>
            <button
              type="button"
              disabled={busy}
              data-testid="confirm-gate-retry"
              onClick={() => void settle(lastAttempt ?? false)}
              className="shrink-0 rounded border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs hover:bg-destructive/20 disabled:opacity-50"
            >
              {t("gate.confirm.retry")}
            </button>
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            data-testid="confirm-gate-reject"
            onClick={() => void settle(false)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {t("gate.confirm.reject")}
          </button>
          <button
            ref={acceptRef}
            type="button"
            disabled={busy || expired}
            data-testid="confirm-gate-accept"
            onClick={() => void settle(true)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
      className="flex items-center justify-between gap-3 bg-destructive/15 px-4 py-2 text-sm"
    >
      <span>{t("gate.halt.banner")}</span>
      {onResume ? (
        <button
          type="button"
          onClick={onResume}
          data-testid="gate-halt-resume"
          className="rounded border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/20"
        >
          {t("gate.halt.resume")}
        </button>
      ) : null}
    </div>
  );
}

export default ConfirmGateDialog;
