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
  type RemoteSession,
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
 * 连接状态机。
 *
 * 远程会话是进程内的，本面板是它的唯一生命周期持有人，因此状态只能由
 * `connectRemote` / `closeRemote` 的真实返回值驱动——不伪造“环境探测”。
 */
type ConnectionPhase = "idle" | "connecting" | "connected" | "closed" | "failed";

const CONNECTION_LABEL_KEY: Record<ConnectionPhase, string> = {
  idle: "mcp.transport.connection.idle",
  connecting: "mcp.transport.connection.connecting",
  connected: "mcp.transport.connection.connected",
  closed: "mcp.transport.connection.closed",
  failed: "mcp.transport.connection.failed",
};

const CONNECTION_DOT: Record<ConnectionPhase, string> = {
  idle: "bg-muted-foreground/50",
  connecting: "bg-amber-500 animate-pulse",
  connected: "bg-emerald-500",
  closed: "bg-muted-foreground/50",
  failed: "bg-red-500",
};

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
  const [phase, setPhase] = useState<ConnectionPhase>("idle");
  const [session, setSession] = useState<RemoteSession | null>(null);

  const optInRequired = !mayEnableTransport(mode, allowHttp);
  const canSave = !optInRequired;

  const save = async () => {
    try {
      const saved = await setTransportMode(projectPath, mode, allowHttp);
      setStatus({
        kind: "ok",
        text: t("mcp.transport.status.saved", {
          transport: saved.transport,
          optin: t(
            saved.allow_http ? "mcp.transport.status.optin.on" : "mcp.transport.status.optin.off",
          ),
        }),
      });
    } catch (error) {
      setStatus({ kind: "error", text: String(error) });
    }
  };

  const connect = async () => {
    setPhase("connecting");
    setSession(null);
    try {
      const next = await connectRemote(projectPath, serverId);
      setSession(next);
      setPhase("connected");
      setStatus({
        kind: "ok",
        text: t("mcp.transport.status.connected", {
          transport: next.transport,
          endpoint: next.endpoint,
        }),
      });
    } catch (error) {
      setPhase("failed");
      setStatus({ kind: "error", text: String(error) });
    }
  };

  const disconnect = async () => {
    try {
      const closed = await closeRemote(serverId);
      setSession(null);
      setPhase(closed ? "closed" : "failed");
      setStatus({
        kind: closed ? "ok" : "error",
        text: closed ? t("mcp.transport.status.closed") : t("mcp.transport.status.closeFailed"),
      });
    } catch (error) {
      setPhase("failed");
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
      setStatus({ kind: "ok", text: t("mcp.transport.status.audited", { bytes: payload.body.length }) });
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

      {/* 连接状态一等公民：远程会话是进程内的，面板是唯一持有人，
          所以这里显示的就是 connect/close 的真实返回值（不是探测出的推测）。 */}
      <div
        role="status"
        aria-live="polite"
        data-testid="mcp-transport-connection"
        data-state={phase}
        className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
      >
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${CONNECTION_DOT[phase]}`}
          aria-hidden="true"
        />
        <span className="text-muted-foreground">{t("mcp.transport.connection.label")}</span>
        <span data-testid="mcp-transport-connection-label" className="font-medium">
          {t(CONNECTION_LABEL_KEY[phase])}
        </span>
        {session ? (
          <span
            data-testid="mcp-transport-connection-detail"
            className="text-xs text-muted-foreground"
          >
            {session.transport} · {session.endpoint} ·{" "}
            {t(
              session.credential_present
                ? "mcp.transport.credential.present"
                : "mcp.transport.credential.absent",
            )}
          </span>
        ) : null}
      </div>

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
          {t("mcp.transport.optin.required")}
        </p>
      ) : null}

      <div className="flex gap-2">
        <button type="button" data-testid="mcp-transport-save" disabled={!canSave} onClick={() => void save()}>
          {t("mcp.transport.save")}
        </button>
        <button
          type="button"
          data-testid="mcp-transport-connect"
          disabled={phase === "connecting"}
          onClick={() => void connect()}
        >
          {t("mcp.transport.connect")}
        </button>
        <button type="button" data-testid="mcp-transport-request" onClick={() => void requestAndAudit()}>
          {t("mcp.transport.request")}
        </button>
        <button type="button" data-testid="mcp-transport-close" onClick={() => void disconnect()}>
          {t("mcp.transport.close")}
        </button>
      </div>

      <input
        className="rounded border px-2 py-1 text-sm"
        data-testid="mcp-server-id"
        placeholder={t("mcp.transport.serverId")}
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
