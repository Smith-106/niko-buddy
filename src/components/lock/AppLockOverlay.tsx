import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  MIN_PASSPHRASE_LEN,
  isPassphraseAcceptable,
  lockState,
  shouldShowOverlay,
  verifyPassphrase,
  type LockState,
} from "@/lib/app-lock/lock-client";

export interface AppLockOverlayProps {
  /** 已通过验证后的回调（宿主据此决定是否渲染主界面）。 */
  onUnlocked?: () => void;
  /** 测试/受控场景下直接给定初始状态；省略则启动时自查询。 */
  initialState?: LockState;
}

/**
 * 启动遮挡层（F-004）。
 *
 * 约束：
 * * 覆盖全窗口（`fixed inset-0` + 最高层级），**没有关闭按钮**，Esc 不关闭；
 * * 唯一出口是「通过口令验证」；口令错误只提示，不累计放行；
 * * 未配置口令（`not_configured`）时不遮挡——否则全新项目会被自己的锁挡在门外。
 *
 * 说明（诚实边界）：devtools 快捷键无法从前端 JS 彻底禁用，产品侧需要 WebView2
 * 层的快捷键策略配合；本组件只保证 UI 层无出口。
 */
export function AppLockOverlay({ onUnlocked, initialState }: AppLockOverlayProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<LockState | null>(initialState ?? null);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initialState !== undefined) return;
    let alive = true;
    void lockState()
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {
        // 查询失败保守为 locked：宁可要求验证，也不静默放行。
        if (alive) setState("locked");
      });
    return () => {
      alive = false;
    };
  }, [initialState]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const ok = await verifyPassphrase(passphrase);
      if (!ok) {
        setError(t("lock.overlay.invalid"));
        return;
      }
      setPassphrase("");
      setState("unlocked");
      onUnlocked?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [passphrase, onUnlocked, t]);

  if (state === null || !shouldShowOverlay(state)) return null;

  return (
    <div
      data-testid="app-lock-overlay"
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/95 backdrop-blur"
      onKeyDown={(e) => {
        // 遮罩层不接受任何「关闭」语义的按键。
        if (e.key === "Escape") e.preventDefault();
      }}
    >
      <div className="w-80 space-y-3 rounded border p-4">
        <h2 className="text-base font-semibold">{t("lock.overlay.title")}</h2>
        <input
          type="password"
          autoFocus
          data-testid="app-lock-input"
          className="w-full rounded border px-2 py-1 text-sm"
          value={passphrase}
          placeholder={t("lock.overlay.placeholder", { count: MIN_PASSPHRASE_LEN })}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isPassphraseAcceptable(passphrase) && !busy) {
              void submit();
            }
          }}
        />
        {error ? (
          <p role="alert" data-testid="app-lock-error" className="text-xs text-red-500">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          data-testid="app-lock-unlock"
          className="w-full rounded border px-2 py-1 text-sm"
          disabled={busy || !isPassphraseAcceptable(passphrase)}
          onClick={() => void submit()}
        >
          {t("lock.overlay.unlock")}
        </button>
      </div>
    </div>
  );
}

export default AppLockOverlay;
