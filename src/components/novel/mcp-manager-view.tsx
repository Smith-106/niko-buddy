/**
 * mcp-manager-view.tsx — MCP 服务管理视图。
 *
 * ## 职责
 *   - 项目 MCP 配置只读装载 + 用户显式启停（enabled 开关经真实存在的
 *     `saveMcpConfig` 落盘；配置形态经 `normalizeMcpConfig` 规范化）；
 *   - 不做存活探测：状态列仅反映配置 `enabled`（已启用/已停用），不断言
 *     服务进程是否存活。
 *
 * ## 数据源（MCP 域，非 novel 域：直接导入，precedent 见 settings mcp-section）
 *   - `loadMcpConfig` / `saveMcpConfig`（`@/lib/project-store`，Tauri store
 *     全局 `mcpConfig` 键；缺失 → null → 回退 `DEFAULT_MCP_CONFIG`）；
 *   - `normalizeMcpConfig` / `DEFAULT_MCP_CONFIG`（`@/lib/mcp/config`）。
 *
 * ## 缺口记录（2026-10-19）
 *   - MCP 配置为全局配置（非项目级）：`projectPath === ""` 时按统一签名显示
 *     空态，不展示全局数据；未做按项目隔离（仓库内无此真源）。
 *   - 未展示实时连接状态：仓库内连接态只存在于运行时内存（buildMcpRuntime），
 *     无持久化真源，本页诚实只展示配置态。
 *
 * 中文 UI；启停之外的字段只读（增删/改命令请走设置页 MCP 分区）。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import { Loader2, PlugZap } from "lucide-react"
import { DEFAULT_MCP_CONFIG, normalizeMcpConfig, type McpConfig } from "@/lib/mcp/config"
import { loadMcpConfig, saveMcpConfig } from "@/lib/project-store"

export interface McpManagerSnapshot {
  readonly config: McpConfig
  /** true = 来自全局 store；false = store 缺失，回退默认空配置。 */
  readonly fromStore: boolean
}

/** 装载：全局 MCP 配置；store 缺失 → 默认空配置（诚实「暂无服务」，不编造）。 */
export async function loadMcpManagerSnapshot(): Promise<McpManagerSnapshot> {
  const stored = await loadMcpConfig()
  if (stored === null) return { config: DEFAULT_MCP_CONFIG, fromStore: false }
  return { config: normalizeMcpConfig(stored), fromStore: true }
}

/** 纯函数：开关某服务 enabled（经 normalizeMcpConfig 规范化回写形状）。 */
export function toggleMcpServerEnabled(
  config: McpConfig,
  serverId: string,
  enabled: boolean,
): McpConfig {
  return normalizeMcpConfig({
    servers: config.servers.map((server) =>
      server.id === serverId ? { ...server, enabled } : server,
    ),
  })
}

export interface McpManagerViewProps {
  /** 项目根路径（统一签名；MCP 配置为全局，未指定时显示空态）。 */
  readonly projectPath: string
  /** 显式注入配置（测试/预览优先；提供后跳过全局 store 装载）。 */
  readonly config?: McpConfig | null
}

export function McpManagerView({ projectPath, config: configOverride }: McpManagerViewProps) {
  const [config, setConfig] = useState<McpConfig | null>(configOverride ?? null)
  const [fromStore, setFromStore] = useState(configOverride !== undefined)
  const [loading, setLoading] = useState(configOverride === undefined && projectPath !== "")
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (configOverride !== undefined) {
      setConfig(configOverride)
      setFromStore(true)
      setLoading(false)
      setError(null)
      return
    }
    if (projectPath === "") {
      setConfig(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void loadMcpManagerSnapshot()
      .then((snapshot) => {
        if (cancelled) return
        setConfig(snapshot.config)
        setFromStore(snapshot.fromStore)
      })
      .catch((err) => {
        if (cancelled) return
        setConfig(null)
        setError(err instanceof Error && err.message ? err.message : "MCP 配置加载失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectPath, configOverride])

  async function handleToggle(serverId: string, nextEnabled: boolean) {
    if (config === null || savingId !== null) return
    const next = toggleMcpServerEnabled(config, serverId, nextEnabled)
    setSavingId(serverId)
    setSaveError(null)
    try {
      await saveMcpConfig(next)
      setConfig(next)
    } catch (err) {
      // 落盘失败不改内存态：开关保持原值，错误可见。
      setSaveError(err instanceof Error && err.message ? err.message : "MCP 配置保存失败")
    } finally {
      setSavingId(null)
    }
  }

  return (
    <section data-testid="mcp-manager-view" className="flex flex-col gap-3 p-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <PlugZap className="h-4 w-4" />
        MCP 服务管理
      </h2>
      <p className="text-xs text-muted-foreground">
        全局 MCP 服务配置（非项目级）；启停开关立即落盘，其余字段只读。状态列仅反映配置开关，不做存活探测。
      </p>

      {loading ? (
        <p data-testid="mcp-loading" className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在读取 MCP 配置…
        </p>
      ) : error !== null ? (
        <p data-testid="mcp-error" role="alert" className="text-xs text-red-700 dark:text-red-300">
          读取失败：{error}
        </p>
      ) : config === null ? (
        <p data-testid="mcp-empty" className="text-xs text-muted-foreground">
          未指定项目路径
        </p>
      ) : config.servers.length === 0 ? (
        <p data-testid="mcp-empty" className="text-xs text-muted-foreground">
          暂无 MCP 服务
          {fromStore ? "" : "（全局配置缺失，已回退默认空配置）"}。请在设置页 MCP 分区添加服务。
        </p>
      ) : (
        <>
          {saveError !== null ? (
            <p data-testid="mcp-save-error" role="alert" className="text-xs text-red-700 dark:text-red-300">
              保存失败：{saveError}
            </p>
          ) : null}
          <ul data-testid="mcp-server-list" className="flex flex-col gap-2">
            {config.servers.map((server) => (
              <li
                key={server.id}
                data-testid={`mcp-server-${server.id}`}
                className="rounded-md border border-border bg-background px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {server.name}
                    <span
                      data-testid={`mcp-server-status-${server.id}`}
                      className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    >
                      {server.enabled ? "已启用" : "已停用"}
                    </span>
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-checked={server.enabled}
                      aria-label={`${server.enabled ? "停用" : "启用"} MCP 服务「${server.name}」`}
                      checked={server.enabled}
                      disabled={savingId !== null}
                      onChange={(event) => void handleToggle(server.id, event.target.checked)}
                    />
                    {savingId === server.id ? "保存中…" : server.enabled ? "停用" : "启用"}
                  </label>
                </div>
                <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <div className="flex gap-1">
                    <dt>传输：</dt>
                    <dd className="font-mono">{server.transport}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>工具：</dt>
                    <dd>{server.tools.length} 个</dd>
                  </div>
                  {server.command ? (
                    <div className="flex gap-1">
                      <dt>命令：</dt>
                      <dd className="font-mono">{server.command}</dd>
                    </div>
                  ) : null}
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
