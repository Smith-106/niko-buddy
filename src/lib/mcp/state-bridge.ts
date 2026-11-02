/**
 * Rust ⇄ WebView 状态桥（方案 d23eb1df P0，只读方向）。
 *
 * ## 为什么需要桥
 *
 * 20 个设置键只存在于 WebView 的 `localStorage`，Rust 进程读不到。MCP 服务端
 * 在 Rust 侧，所以必须有一次跨进程的请求/响应往返。
 *
 * ## 协议
 *
 * ```
 * Rust  --emit("mcp:state-request", {id, op, key})-->  WebView
 * Rust  <--invoke("mcp_state_respond", {id, ok, value, error})--  WebView
 * ```
 *
 * 用 `invoke` 回传而不是再 emit 一个事件：命令是有返回值的类型化调用，
 * 前端能感知 Rust 是否还在等，且不依赖事件监听器的注册顺序。
 *
 * ## 三条硬约束
 *
 * 1. **键白名单**。只放行 `settings-catalog.ts` 登记过的键。不做前缀匹配——
 *    前缀匹配会让桥变成「任意 localStorage 读写通道」。
 * 2. **异常必须回 error**。前端任何一步抛错都要回 `ok:false` + 错误信息，
 *    绝不静默丢弃——静默会让 Rust 侧只能靠 5s 超时兜底，把真实原因丢掉。
 * 3. **P0 只读**。本模块不提供任何写操作（`set`/`remove`）。写入是后续阶段的事。
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

import { SETTINGS_BY_KEY, SETTINGS_CATALOG, isBridgeAllowedKey } from "./settings-catalog"

/** Rust → WebView 的请求事件名（与 Rust 侧 `state_bridge::REQUEST_EVENT` 必须一致）。 */
export const STATE_REQUEST_EVENT = "mcp:state-request"
/** WebView → Rust 的回传命令名（与 Rust 侧 `mcp_state_respond` 必须一致）。 */
export const STATE_RESPOND_COMMAND = "mcp_state_respond"

/** 桥支持的只读操作。 */
export type StateOp = "get" | "list" | "schema"

export interface StateRequestPayload {
  id: string
  op: StateOp
  key?: string
}

export interface StateResponse {
  ok: boolean
  value?: unknown
  error?: string
}

/** 读取单个 localStorage 键的原始值（不存在返回 null）。 */
function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    // 隐私模式 / 存储被禁用时会抛。如实报错，不伪装成 null（"未设置"与"读不到"不同）。
    throw new Error(`localStorage 不可读（键 ${key}）`)
  }
}

/**
 * 处理一条桥请求。纯函数，便于直接单测。
 *
 * @throws 不会抛出——所有异常都转成 `{ok:false, error}`。
 */
export function handleStateRequest(payload: StateRequestPayload): StateResponse {
  try {
    if (!payload || typeof payload.id !== "string" || payload.id.length === 0) {
      return { ok: false, error: "请求缺少 id" }
    }

    switch (payload.op) {
      case "schema":
        return { ok: true, value: SETTINGS_CATALOG }

      case "list": {
        const entries = SETTINGS_CATALOG.map((entry) => ({
          key: entry.key,
          storage: entry.storage,
          scope: entry.scope,
          value: entry.storage === "localStorage" ? readLocalStorage(entry.key) : null,
        }))
        return { ok: true, value: entries }
      }

      case "get": {
        const key = payload.key
        if (!key) {
          return { ok: false, error: "op=get 需要 key" }
        }
        if (!isBridgeAllowedKey(key)) {
          return { ok: false, error: `键未登记，拒绝访问: ${key}` }
        }
        const entry = SETTINGS_BY_KEY.get(key)
        if (!entry) {
          // 理论上不可达（isBridgeAllowedKey 已查过），保留以便白名单实现变更时不静默。
          return { ok: false, error: `键未登记，拒绝访问: ${key}` }
        }
        return {
          ok: true,
          value: {
            key: entry.key,
            storage: entry.storage,
            scope: entry.scope,
            value: entry.storage === "localStorage" ? readLocalStorage(entry.key) : null,
          },
        }
      }

      default:
        return { ok: false, error: `不支持的 op: ${String(payload.op)}` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}

/**
 * 安装状态桥监听器。应用启动时调用一次，返回卸载函数。
 *
 * 返回的 `UnlistenFn` 必须被调用（组件/模块卸载时），否则监听器泄漏：
 * 热重载会累积多个监听器，同一条请求被处理多次、回多个响应。
 */
export async function installStateBridge(): Promise<UnlistenFn> {
  return listen<StateRequestPayload>(STATE_REQUEST_EVENT, async (event) => {
    const payload = event.payload
    const response = handleStateRequest(payload)
    try {
      await invoke(STATE_RESPOND_COMMAND, {
        id: payload?.id ?? "",
        ok: response.ok,
        value: response.value ?? null,
        error: response.error ?? null,
      })
    } catch (error) {
      // 回传失败无处可报（Rust 侧会超时）。至少在控制台留下痕迹，
      // 否则这类故障会表现为"偶发 5s 超时"而无任何线索。
      console.error("[mcp-state-bridge] 回传响应失败", error)
    }
  })
}
