import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "@/components/error-boundary";
import { ToastProvider } from "@/lib/toast";
import "./index.css";
import "@/i18n";
import { warmClaudeCliTimeouts } from "@/lib/claude-cli-transport";
import { installStateBridge } from "@/lib/mcp/state-bridge";
import { startModuleHeatFlushLoop, useModuleHeatStore } from "@/stores/module-heat-store";
import { useWikiStore } from "@/stores/wiki-store";

// C-101 (GRL-008): pull configurable CLI transport timeouts from app-state at
// startup. Non-blocking — defaults remain in effect until this resolves.
void warmClaudeCliTimeouts();

// MCP 状态桥（方案 d23eb1df）：Rust 侧 MCP 服务端读 WebView 设置时经此往返。
// 同样非阻塞——桥装不上只意味着 settings.* 工具会报超时，不应拖住应用启动。
void installStateBridge().catch((error) => {
  console.error("[mcp-state-bridge] 安装失败", error);
});

// TASK-006: 运行热力 sink 必须在启动时安装（幂等、零 IO）。只装在热力图视图里时，
// 未打开该页 sink 恒为 null，campaign-runner / incubator / director 等埋点全是 no-op。
useModuleHeatStore.getState().install();

// TASK-006: 落盘同样脱离视图——热力视图不挂载时也要按 shouldFlushHeat 的窗口写快照。
// 节流判定复用 store 里的纯函数，这里只提供「app 级心跳 + 现取项目路径」。
startModuleHeatFlushLoop(() => useWikiStore.getState().project?.path ?? null);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
