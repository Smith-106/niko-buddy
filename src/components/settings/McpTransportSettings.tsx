import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_TRANSPORT_MODE,
  TRANSPORT_MODES,
  auditRemotePayload,
  closeRemote,
  connectRemote,
  isAuditBlocked,
  mayEnableTransport,
  normalizeTransport,
  requestRemote,
  setTransportMode,
  type TransportMode,
} from "@/lib/mcp/remote-transport";

export interface McpTransportSettingsProps {
  /** 当前项目根路径（IPC 参数）。 */
  projectPath: string;
}

interface StatusState {
  kind: "idle" | "ok" | "blocked" | "error";
  text: string;
}

/**
 * MCP 传输设置（F-005 UI 面）。
 *
 * 默认值恒为 stdio；HTTP/SSE 必须显式勾选 opt-in 才能保存（勾选框默认未勾选）。
 * 远程取回的内容在本组件里先过审计门，被拦时展示 `mcp.remote.audit.blocked` 提示，
 * 且不把内容交给任何入库路径。
 */
export function McpTransportSettings({ projectPath }: McpTransportSettingsProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TransportMode>(DEFAULT_TRANSPORT_MODE);
  const [allowHttp, setAllowHttp] = useState(false);
  const [serverId, setServerId] = useState("");
  const [status, setStatus] = useState<StatusState>({ kind: "idle", text: "" });

  const optInRequired = !mayEnableTransport(mode, allowHttp);
  const canSave = !optInRequired;

  const save = async () => {
    try {
      const saved = await setTransportMode(projectPath, mode, allowHttp);
      setStatus({ kind: "ok", text: `${saved.transport} (${saved.allow_http ? "http allowed" : "no opt-in"})` });
    } catch (error) {
      setStatus({ kind: "error", text: String(error) });
    }
  };

  const connect = async () => {
    try {
      const session = await connectRemote(projectPath, serverId);
      setStatus({
        kind: "ok",
        text: `${session.transport} · ${session.credential_present ? "bearer" : "no credential"}`,
      });
    } catch (error) {
      setStatus({ kind: "error", text: String(error) });
    }
  };

  const requestAndAudit = async () => {
    try {
      const payload = await requestRemote(projectPath, serverId, JSON.stringify({ id: 1 }));
      const audit = auditRemotePayload(payload.body, { license: "MIT", adrScore: 1 });
      if (!audit.allowed) {
        setStatus({ kind: "blocked", text: `${t("mcp.remote.audit.blocked")} — ${audit.reason}` });
        return;
      }
      setStatus({ kind: "ok", text: `audited ${payload.body.length} bytes` });
    } catch (error) {
      setStatus({
        kind: isAuditBlocked(error) ? "blocked" : "error",
        text: isAuditBlocked(error) ? t("mcp.remote.audit.blocked") : String(error),
      });
    }
  };

  return (
    <section data-testid="mcp-transport-settings" className="flex flex-col gap-3 p-4">
      <h2 className="text-lg font-semibold">{t("mcp.transport.mode")}</h2>

      <label className="flex flex-col gap-1 text-sm">
        <span>{t("mcp.transport.mode")}</span>
        <select
          data-testid="mcp-transport-mode"
          value={mode}
          onChange={(e) => setMode((normalizeTransport(e.target.value) ?? DEFAULT_TRANSPORT_MODE))}
        >
          {TRANSPORT_MODES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="mcp-transport-optin"
          checked={allowHttp}
          onChange={(e) => setAllowHttp(e.target.checked)}
        />
        <span>{t("mcp.transport.optin.http")}</span>
      </label>

      {optInRequired ? (
        <p role="alert" data-testid="mcp-transport-optin-required" className="text-xs text-amber-600">
          {t("mcp.transport.optin.http")}
        </p>
      ) : null}

      <div className="flex gap-2">
        <button type="button" data-testid="mcp-transport-save" disabled={!canSave} onClick={() => void save()}>
          {t("mcp.transport.mode")}
        </button>
        <button type="button" data-testid="mcp-transport-connect" onClick={() => void connect()}>
          {t("mcp.transport.mode")}
        </button>
        <button type="button" data-testid="mcp-transport-request" onClick={() => void requestAndAudit()}>
          {t("mcp.transport.mode")}
        </button>
        <button type="button" data-testid="mcp-transport-close" onClick={() => void closeRemote(serverId)}>
          {t("mcp.transport.mode")}
        </button>
      </div>

      <input
        className="rounded border px-2 py-1 text-sm"
        data-testid="mcp-server-id"
        placeholder="server id"
        value={serverId}
        onChange={(e) => setServerId(e.target.value)}
      />

      <p data-testid="mcp-transport-status" data-status={status.kind} className="text-xs">
        {status.text}
      </p>
    </section>
  );
}

export default McpTransportSettings;
