import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  fetchLoopState,
  listPendingGates,
  resumeAfterHalt,
  type LoopState,
  type PendingGate,
} from "@/lib/novel";
import { isTauri } from "@/lib/platform";

import { ConfirmGateDialog, GateHaltBanner } from "./ConfirmGateDialog";

export interface GateHostProps {
  /** 轮询间隔（毫秒）。 */
  pollMs?: number;
  /** 宿主开关；浏览器预览（无 Tauri IPC）默认关闭。 */
  enabled?: boolean;
}

/** 连续查询失败达到该次数 → 挂「门服务不可用」角标（恢复即消）。 */
export const GATE_HOST_FAILURE_THRESHOLD = 3;

/**
 * 写入确认门的宿主（B-F-001 接线）。
 *
 * 门此前只有 IPC 入口、应用壳层没有宿主，真实应用里既看不到确认弹窗也看不到熔断提示。
 * 本组件只把「待裁决请求 + 熔断状态」两个查询挂到壳层，裁决仍由既有
 * `confirm_gate_resolve` 落回 Rust 侧——这里不新增任何判定逻辑。
 */
export function GateHost({ pollMs = 1000, enabled = isTauri() }: GateHostProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingGate | null>(null);
  const [loop, setLoop] = useState<LoopState | null>(null);
  // C3：连续失败计数 → 达阈值给用户可见的「门服务不可用」角标，恢复后自动消失。
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [gates, state] = await Promise.all([listPendingGates(), fetchLoopState()]);
      setPending(gates[0] ?? null);
      setLoop(state);
      setConsecutiveFailures(0);
    } catch {
      // 门不可用（命令未注册 / 浏览器预览 / 无项目）时不阻断写作；
      // 但连续失败必须可见——计入计数，达阈值后挂角标。
      setConsecutiveFailures((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [enabled, pollMs, refresh]);

  // 熔断只能由携带 halt_request_id 的 resume_after_halt 解除。
  const haltRequestId = loop?.halt_request_id ?? null;
  const handleResume = useCallback(() => {
    if (!haltRequestId) return;
    void resumeAfterHalt(haltRequestId, "resumed from host banner").finally(() => {
      void refresh();
    });
  }, [haltRequestId, refresh]);

  const handleResolved = useCallback(() => {
    void refresh();
  }, [refresh]);

  if (!enabled) return null;

  return (
    <>
      {/* 壳层内容多为 fixed inset-0：横幅需自身定位才能盖住它并接收点击。 */}
      <div className="relative">
        <GateHaltBanner
          halted={loop?.halted === true}
          onResume={haltRequestId ? handleResume : undefined}
        />
        {consecutiveFailures >= GATE_HOST_FAILURE_THRESHOLD ? (
          <div
            role="status"
            data-testid="gate-service-unavailable"
            className="bg-warning/15 px-4 py-2 text-xs text-foreground"
          >
            {t("gate.unavailable.badge")}
          </div>
        ) : null}
      </div>
      <ConfirmGateDialog pending={pending} onResolved={handleResolved} />
    </>
  );
}

export default GateHost;
