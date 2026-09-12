/**
 * 远程 MCP 传输客户端（F-005）。
 *
 * 三层职责，边界明确：
 * 1. **门禁**：默认 stdio；http/sse 必须 `allow_http = true` 才允许设置（本地先挡，
 *    Rust 侧 `mcp_transport_set_mode` 再挡一次）；
 * 2. **命令**：4 条 IPC 包装；
 * 3. **先审后入库**：远程取回的载荷先跑两个既有审计器（注入行审计 +
 *    来源信任审计，见下方 import），两者都放行才把内容交给调用方去走入库命令。
 *    任一不放行则原地拦截，
 *    并保留 `mcp.remote.audit.blocked` 提示所需的结论。
 */

import { invoke } from "@tauri-apps/api/core";

import { auditRetrievedChunk, type InjectionAuditVerdict } from "@/lib/novel/prompt-injection-auditor";
import { auditRagSource, isRagTrustAllowed, type RagTrustInput, type RagTrustVerdict } from "@/lib/novel/rag-trust-audit";

export const TRANSPORT_MODES = ["stdio", "http", "sse"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];
/** 默认传输：本地 stdio。 */
export const DEFAULT_TRANSPORT_MODE: TransportMode = "stdio";
/** opt-in 字段名（前端/Rust 用同一个词）。 */
export const ALLOW_HTTP_FLAG = "allow_http";
/** 后端 `MCP_AUDIT_BLOCKED` 前缀。 */
export const AUDIT_BLOCKED_PREFIX = "MCP_AUDIT_BLOCKED";

export interface TransportConfig {
  transport: TransportMode;
  allow_http: boolean;
}

export interface RemoteSession {
  server_id: string;
  transport: TransportMode;
  endpoint: string;
  credential_present: boolean;
  opt_in: boolean;
}

export interface RemotePayload {
  server_id: string;
  transport: TransportMode;
  body: string;
  /** 恒为 true：未经审计不得入库。 */
  audit_pending: boolean;
  origin: string;
}

/** 默认配置：stdio + 未 opt-in。 */
export function defaultTransportConfig(): TransportConfig {
  return { transport: DEFAULT_TRANSPORT_MODE, allow_http: false };
}

export function isRemoteMode(mode: string): boolean {
  return mode === "http" || mode === "sse";
}

export function normalizeTransport(value: string): TransportMode | null {
  const lowered = value.trim().toLowerCase();
  return (TRANSPORT_MODES as readonly string[]).includes(lowered)
    ? (lowered as TransportMode)
    : null;
}

/**
 * opt-in 门（纯函数，UI 的勾选框状态与后端门禁共用同一判据）：
 * 只有 stdio 免 opt-in；未知模式一律视为需要。
 */
export function mayEnableTransport(mode: string, allowHttp: boolean): boolean {
  const normalized = normalizeTransport(mode);
  if (normalized === null) return false;
  return normalized === "stdio" || allowHttp;
}

export function requireOptIn(mode: string, allowHttp: boolean): TransportConfig | null {
  return mayEnableTransport(mode, allowHttp)
    ? { transport: normalizeTransport(mode) as TransportMode, allow_http: allowHttp }
    : null;
}

// ── 命令包装 ────────────────────────────────────────────────────────────────

/** 设置传输模式；远程模式未 opt-in 时本地直接拒绝（不打扰后端）。 */
export async function setTransportMode(
  projectPath: string,
  transport: string,
  allowHttp: boolean,
): Promise<TransportConfig> {
  const config = requireOptIn(transport, allowHttp);
  if (config === null) {
    throw new Error(
      `${ALLOW_HTTP_FLAG} must be true before enabling remote transport '${transport}'`,
    );
  }
  return invoke<TransportConfig>("mcp_transport_set_mode", {
    projectPath,
    transport: config.transport,
    allowHttp,
  });
}

export async function connectRemote(projectPath: string, serverId: string): Promise<RemoteSession> {
  return invoke<RemoteSession>("mcp_remote_connect", { projectPath, serverId });
}

export async function requestRemote(
  projectPath: string,
  serverId: string,
  payload: string,
): Promise<RemotePayload> {
  return invoke<RemotePayload>("mcp_remote_request", { projectPath, serverId, payload });
}

export async function closeRemote(serverId: string): Promise<boolean> {
  return invoke<boolean>("mcp_remote_close", { serverId });
}

// ── 先审后入库 ──────────────────────────────────────────────────────────────

export interface AuditGateResult {
  /** 两个审计器都放行才为 true。 */
  allowed: boolean;
  injection: InjectionAuditVerdict;
  trust: RagTrustVerdict;
  /** 拦截原因（放行时为空）。 */
  reason: string;
}

/**
 * 远程载荷审计门：注入审计必须 `pass`，来源信任必须 `allow`（判词见 import 的两个审计器）。
 * `sanitize` 不算放行——被改写过行号的内容不得静默入库。
 */
export function auditRemotePayload(payload: string, trustInput: RagTrustInput): AuditGateResult {
  const injection = auditRetrievedChunk(payload);
  const trust = auditRagSource(trustInput);

  const injectionOk = injection.action === "pass";
  const trustOk = isRagTrustAllowed(trust);
  const reasons: string[] = [];
  if (!injectionOk) {
    reasons.push(`injection: ${injection.action}`);
  }
  if (!trustOk) {
    reasons.push(`trust: ${trust.grade}`);
  }

  return {
    allowed: injectionOk && trustOk,
    injection,
    trust,
    reason: reasons.join("; "),
  };
}

/** 后端拦截错误的判定（供 UI 决定是否展示审计拦截提示）。 */
export function isAuditBlocked(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes(AUDIT_BLOCKED_PREFIX);
}

export interface AuditedRemoteResult {
  allowed: boolean;
  payload: RemotePayload;
  audit: AuditGateResult;
}

/**
 * 取回远程载荷并审计。**不写盘**：放行后由调用方走既有入库命令；
 * 拦截时 `allowed = false` 且调用方不得持有可用于入库的内容。
 */
export async function requestAndAuditRemote(
  projectPath: string,
  serverId: string,
  requestPayload: string,
  trustInput: RagTrustInput,
): Promise<AuditedRemoteResult> {
  const payload = await requestRemote(projectPath, serverId, requestPayload);
  const audit = auditRemotePayload(payload.body, trustInput);
  return { allowed: audit.allowed, payload, audit };
}
