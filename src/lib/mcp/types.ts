// 本地类型（去 agent/types 依赖——v2 无 agent 框架；与上游 v3 定义保持一致）
export interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array" | "integer"
  description: string
  required?: boolean
  enum?: string[]
}

export type ToolCategory = "read" | "write" | "action" | "virtual"
export type ToolPermission = "auto" | "confirm"

export type McpToolOperation = "read" | "analysis" | "suggestion" | "write" | "delete" | "overwrite"

export interface McpJsonSchemaProperty {
  type: ToolParameter["type"] | "function" | string
  description?: string
  enum?: string[]
}

export interface McpJsonSchema {
  type: "object"
  properties?: Record<string, McpJsonSchemaProperty>
  required?: string[]
}

export interface McpToolDescriptor {
  serverId: string
  serverName: string
  name: string
  description: string
  operation: McpToolOperation
  inputSchema: McpJsonSchema
}

export interface McpToolPolicy {
  category: ToolCategory
  permission: ToolPermission
  blocked: boolean
}

export interface McpToolCallRequest {
  serverId: string
  serverName: string
  toolName: string
  qmaiToolName: string
}

export interface McpToolCallResult {
  status: "ok" | "error"
  content: string
  summary?: string
  message?: string
}

export type McpToolCaller = (
  request: McpToolCallRequest,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<McpToolCallResult>

/** 本地 Tool 定义（去 agent/types 依赖——v2 无 agent 框架）。 */
export interface Tool {
  name: string
  description: string
  category: ToolCategory
  permission?: ToolPermission
  /** 0 表示不使用通用工具超时。 */
  executeTimeoutMs?: number
  /** 该工具经 onFinalContent 自行交付终稿；成功交付后 runner 立即结束。 */
  finalizesRun?: boolean
  /** 工具参数（JSON Schema 转换结果）。 */
  parameters?: Record<string, ToolParameter>
  /** 工具调用执行器。 */
  execute?: (params: Record<string, unknown>) => Promise<unknown>
}

export type CapabilityKind = "mcp_tool" | "builtin" | "skill"
export type CapabilityPermission = "auto" | "confirm"
export type AiWorkflowMode = "standard" | "strict" | "fast"
export type CapabilityIntent = "character_query" | "setting_query" | "search_plot" | "general" | string
export type CapabilitySource = "built-in" | "project" | "uploaded" | "mcp" | "linked"

export interface AiCapability {
  id: string
  name: string
  kind: CapabilityKind
  permission: CapabilityPermission
  modes: AiWorkflowMode[]
  intents: CapabilityIntent[]
  toolName?: string
  skillId?: string
  source?: CapabilitySource
}
