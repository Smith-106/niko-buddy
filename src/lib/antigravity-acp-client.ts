/**
 * Official Google Antigravity Agent Client Protocol (ACP v1) frontend client.
 *
 * Talks strictly to Rust `commands/antigravity_acp.rs`, which spawns unmodified
 * `agy acp` over stdio JSON-RPC with honest clientInfo (`niko-buddy`), manual
 * user permission approval, and zero OAuth extraction.
 *
 * @license MIT © Niko Buddy
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

export const ANTIGRAVITY_ACP_EVENT_TOPIC = "antigravity-acp:event"

export const MCP_TOOL_PROFILES = [
  "writer-sub",
  "reviewer",
  "architect",
  "full-legacy",
] as const
export type McpToolProfile = (typeof MCP_TOOL_PROFILES)[number]

export type WriterPluginProjectState = "synced" | "needs_update" | "not_synced"

export interface WriterPluginStatus {
  pluginName: string
  pluginVersion: string
  declarativeOnly: boolean
  skillCount: number
  agentCount: number
  isolatedPluginPath: string
  isolatedPluginUpToDate: boolean
  projectPath: string | null
  projectState: WriterPluginProjectState
  projectVersion: string | null
  projectHasClaudeMd: boolean
  globalInstalled: boolean
  globalEnabled: boolean
  globalUpToDate: boolean
  globalPath: string | null
  parentCodeRepoWarning: string | null
}

export interface WriterPluginSyncResult {
  ok: boolean
  pluginName: string
  pluginVersion: string
  projectPath: string
  includeClaudeMd: boolean
  writtenFiles: string[]
  unchangedFiles: string[]
  agentsMdPreservedUserContent: boolean
  parentCodeRepoWarning: string | null
  status: WriterPluginStatus
}

export interface WriterPluginGlobalResult {
  ok: boolean
  pluginName: string
  pluginVersion: string
  installPath: string
  enabled: boolean
  disabled: boolean
  writtenFiles: string[]
  unchangedFiles: string[]
  enableCommand: string
  disableCommand: string
}

export interface AcpAuthMethod {
  id: string
  name: string
  description?: string | null
}

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind?: string | null
}

export interface AcpPendingPermission {
  requestId: string
  sessionId: string
  title: string
  options: AcpPermissionOption[]
  rawParams?: unknown
  toolKind?: string | null
  locations?: string[]
  rawInputSummary?: string | null
}

export type LocalMcpStaleReason =
  | "mcp_server_stopped"
  | "token_rotated"
  | "port_changed"
  | "scope_changed"
  | "server_restarted"

export interface AcpStatusSnapshot {
  connected: boolean
  binaryPath: string | null
  agentName: string | null
  agentVersion: string | null
  protocolVersion: number | null
  authMethods: AcpAuthMethod[]
  activeSessionId: string | null
  cwd: string | null
  configOptions: unknown[]
  pendingPermissions: AcpPendingPermission[]
  httpMcpEnabled: boolean
  attachedLocalMcp?: boolean
  localMcpScope?: string | null
  localMcpProfile?: McpToolProfile | null
  inFlightPrompt?: boolean
  supportsHttpMcp?: boolean
  supportsLoadSession?: boolean
  localMcpStale?: boolean
  localMcpStaleReason?: LocalMcpStaleReason | null
  parentCodeRepoWarning?: string | null
}

export interface AcpSessionResult {
  sessionId: string
  cwd: string
  configOptions: unknown[]
  attachedLocalMcp: boolean
  rawResult: unknown
  localMcpScope?: string | null
  localMcpProfile?: McpToolProfile | null
  localMcpSkipReason?: "http_mcp_disabled" | "agent_unsupported" | "mcp_server_not_running" | null
  parentCodeRepoWarning?: string | null
}

export interface AcpPromptResult {
  stopReason?: string | null
  usage?: Record<string, unknown> | null
  rawResult?: unknown
}

export interface AcpConfigChoice {
  value: string
  name: string
  description?: string
}

export interface AcpConfigOption {
  id: string
  name: string
  category?: string
  currentValue: string
  options: AcpConfigChoice[]
}

export type AcpEventPayload =
  | { kind: "session_update"; params: Record<string, unknown> }
  | { kind: "permission_request"; permission: AcpPendingPermission }
  | { kind: "permission_resolved"; requestId: string; optionId: string | null }
  | { kind: "stderr"; message: string }
  | { kind: "disconnected"; reason: string }
  | {
      kind: "protocol_warning"
      code: "oversized_stdout_line" | string
      bytes: number
      limitBytes: number
      preview: string
      message: string
    }

export type ParsedSessionUpdate =
  | { type: "agent_message_chunk"; text: string }
  | { type: "agent_thought_chunk"; text: string }
  | { type: "tool_call"; toolCallId: string; title: string | null; status: string }
  | { type: "config_option_update"; configOptions: AcpConfigOption[] }
  | { type: "other"; sessionUpdate: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

/** Runtime type guard for `WriterPluginStatus` (defends UI against legacy/partial mocks). */
export function isWriterPluginStatus(raw: unknown): raw is WriterPluginStatus {
  const rec = asRecord(raw)
  if (!rec) return false
  return (
    typeof rec.pluginName === "string" &&
    typeof rec.pluginVersion === "string" &&
    typeof rec.declarativeOnly === "boolean" &&
    typeof rec.skillCount === "number" &&
    Number.isFinite(rec.skillCount) &&
    typeof rec.agentCount === "number" &&
    Number.isFinite(rec.agentCount) &&
    typeof rec.isolatedPluginPath === "string" &&
    typeof rec.isolatedPluginUpToDate === "boolean" &&
    isNullableString(rec.projectPath) &&
    (rec.projectState === "synced" ||
      rec.projectState === "needs_update" ||
      rec.projectState === "not_synced") &&
    isNullableString(rec.projectVersion) &&
    typeof rec.projectHasClaudeMd === "boolean" &&
    typeof rec.globalInstalled === "boolean" &&
    typeof rec.globalEnabled === "boolean" &&
    typeof rec.globalUpToDate === "boolean" &&
    isNullableString(rec.globalPath) &&
    isNullableString(rec.parentCodeRepoWarning)
  )
}

function flattenConfigChoices(rawOptions: unknown): AcpConfigChoice[] {
  if (!Array.isArray(rawOptions)) return []
  const out: AcpConfigChoice[] = []
  for (const item of rawOptions) {
    const rec = asRecord(item)
    if (!rec) continue
    if (Array.isArray(rec.options)) {
      out.push(...flattenConfigChoices(rec.options))
      continue
    }
    const value = typeof rec.value === "string" ? rec.value : typeof rec.id === "string" ? rec.id : ""
    if (!value) continue
    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name : value
    const description = typeof rec.description === "string" ? rec.description : undefined
    out.push({ value, name, description })
  }
  return out
}

/** Normalize ACP `configOptions` (model / thinking level selectors advertised by `agy acp`). */
export function parseAcpConfigOptions(raw: unknown[]): AcpConfigOption[] {
  const result: AcpConfigOption[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    if (!rec) continue
    const id = typeof rec.id === "string" ? rec.id.trim() : ""
    if (!id) continue
    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name : id
    const category = typeof rec.category === "string" ? rec.category : undefined
    const currentValue = typeof rec.currentValue === "string" ? rec.currentValue : ""
    const options = flattenConfigChoices(rec.options)
    if (options.length === 0) continue
    result.push({ id, name, category, currentValue, options })
  }
  return result
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content
  const rec = asRecord(content)
  if (rec) {
    if (typeof rec.text === "string") return rec.text
    if (typeof rec.content === "string") return rec.content
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = asRecord(part)
        return typeof p?.text === "string" ? p.text : ""
      })
      .join("")
  }
  return ""
}

/** Parse one ACP `session/update` notification payload into a normalized UI event. */
export function parseAcpSessionUpdate(params: Record<string, unknown>): ParsedSessionUpdate | null {
  const update = asRecord(params.update)
  if (!update) return null
  const kind =
    typeof update.sessionUpdate === "string"
      ? update.sessionUpdate
      : typeof update.type === "string"
        ? update.type
        : ""
  if (!kind) return null

  if (kind === "agent_message_chunk") {
    const text = extractTextFromContent(update.content ?? update.text)
    return text ? { type: "agent_message_chunk", text } : null
  }
  if (kind === "agent_thought_chunk") {
    const text = extractTextFromContent(update.content ?? update.text)
    return text ? { type: "agent_thought_chunk", text } : null
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const toolCallId =
      typeof update.toolCallId === "string" && update.toolCallId
        ? update.toolCallId
        : typeof update.id === "string"
          ? update.id
          : "tool"
    const title =
      typeof update.title === "string" && update.title.trim()
        ? update.title
        : typeof update.name === "string" && update.name.trim()
          ? update.name
          : null
    const status = typeof update.status === "string" ? update.status : "in_progress"
    return { type: "tool_call", toolCallId, title, status }
  }
  if (kind === "config_option_update" && Array.isArray(update.configOptions)) {
    return {
      type: "config_option_update",
      configOptions: parseAcpConfigOptions(update.configOptions),
    }
  }
  return { type: "other", sessionUpdate: kind }
}

const EXPLICIT_AUTH_REQUIRED_RE =
  /\b(?:authentication\s+required|auth\s+required|unauthenticated|not\s+authenticated|login\s+required|sign\s+in\s+required|please\s+authenticate)\b/i

const NON_AUTH_ACP_ERROR_CODE_RE = /(?:^|[^\d-])(?:-3209[6-9]|-3260[12]|-320001)(?!\d)/

const ACP_32000_ERROR_CODE_RE = /(?:^|[^\d-])-32000(?!\d)/

const EXPLICIT_NON_AUTH_CAUSE_RE =
  /\b(?:rate\s*limit(?:ed)?|too\s+many\s+requests|quota\s+exceeded|invalid\s+workspace|workspace\s+(?:not\s+found|invalid)|timed?\s*out|timeout|cancell?ed|busy|in[- ]?flight|already\s+running|invalid\s+params?|method\s+not\s+found|session\s+not\s+found|permission\s+(?:denied|rejected)|disconnected|connection\s+refused|network\s+error|context\s+length|model\s+(?:not\s+found|unavailable))\b/i

/**
 * Detect standard ACP `-32000 Authentication required` errors while rejecting
 * non-auth error codes (`-32096`..`-32099`, `-32601`, `-32602`, `-320001`) and
 * `-32000` errors with explicit non-auth causes (e.g. rate limit, timeout, busy).
 */
export function isAcpAuthRequiredError(message: string): boolean {
  const trimmed = message.trim()
  if (!trimmed) return false
  if (NON_AUTH_ACP_ERROR_CODE_RE.test(trimmed)) return false
  if (EXPLICIT_AUTH_REQUIRED_RE.test(trimmed)) return true
  if (ACP_32000_ERROR_CODE_RE.test(trimmed)) {
    return !EXPLICIT_NON_AUTH_CAUSE_RE.test(trimmed)
  }
  return false
}

export async function getAntigravityAcpStatus(): Promise<AcpStatusSnapshot> {
  return invoke<AcpStatusSnapshot>("antigravity_acp_status")
}

export async function connectAntigravityAcp(options?: {
  cwd?: string | null
  enableHttpMcp?: boolean
}): Promise<AcpStatusSnapshot> {
  return invoke<AcpStatusSnapshot>("antigravity_acp_connect", {
    cwd: options?.cwd ?? null,
    enableHttpMcp: options?.enableHttpMcp ?? false,
  })
}

export async function disconnectAntigravityAcp(): Promise<void> {
  await invoke("antigravity_acp_disconnect")
}

export async function authenticateAntigravityAcp(methodId: string): Promise<unknown> {
  return invoke("antigravity_acp_authenticate", { methodId })
}

export async function createAntigravityAcpSession(
  cwd: string,
  attachLocalMcp = false,
  mcpProfile?: McpToolProfile | null,
): Promise<AcpSessionResult> {
  if (mcpProfile !== undefined) {
    return invoke<AcpSessionResult>("antigravity_acp_new_session", {
      cwd,
      attachLocalMcp,
      mcpProfile,
    })
  }
  return invoke<AcpSessionResult>("antigravity_acp_new_session", {
    cwd,
    attachLocalMcp,
  })
}

export async function getWriterPluginStatus(
  projectPath?: string | null,
): Promise<WriterPluginStatus> {
  return invoke<WriterPluginStatus>("writer_plugin_status", {
    projectPath: projectPath ?? null,
  })
}

export async function syncProjectWriterPlugin(
  projectPath: string,
  includeClaudeMd?: boolean,
): Promise<WriterPluginSyncResult> {
  return invoke<WriterPluginSyncResult>("writer_plugin_sync_project", {
    projectPath,
    includeClaudeMd: includeClaudeMd ?? null,
  })
}

export async function installGlobalWriterPlugin(
  enable?: boolean,
): Promise<WriterPluginGlobalResult> {
  return invoke<WriterPluginGlobalResult>("writer_plugin_install_global", {
    enable: enable ?? null,
  })
}

export async function sendAntigravityAcpPrompt(params: {
  sessionId: string
  text: string
  contextTitle?: string | null
  contextText?: string | null
}): Promise<AcpPromptResult> {
  return invoke<AcpPromptResult>("antigravity_acp_prompt", {
    sessionId: params.sessionId,
    text: params.text,
    contextTitle: params.contextTitle ?? null,
    contextText: params.contextText ?? null,
  })
}

export async function cancelAntigravityAcpTurn(sessionId: string): Promise<void> {
  await invoke("antigravity_acp_cancel", { sessionId })
}

export async function setAntigravityAcpConfigOption(
  sessionId: string,
  configId: string,
  value: string,
): Promise<unknown> {
  return invoke("antigravity_acp_set_config_option", {
    sessionId,
    configId,
    value,
  })
}

export async function respondAntigravityAcpPermission(
  requestId: string,
  optionId: string | null,
): Promise<void> {
  await invoke("antigravity_acp_respond_permission", {
    requestId,
    optionId,
  })
}

export async function listenAntigravityAcpEvents(
  handler: (payload: AcpEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<AcpEventPayload>("antigravity-acp:event", (event) => {
    if (event.payload) handler(event.payload)
  })
}
