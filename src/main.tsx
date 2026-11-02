import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "@/components/error-boundary";
import { ToastProvider } from "@/lib/toast";
import "./index.css";
import "@/i18n";
import { warmClaudeCliTimeouts } from "@/lib/claude-cli-transport";
import { installStateBridge } from "@/lib/mcp/state-bridge";

// C-101 (GRL-008): pull configurable CLI transport timeouts from app-state at
// startup. Non-blocking — defaults remain in effect until this resolves.
void warmClaudeCliTimeouts();

// MCP 状态桥（方案 d23eb1df）：Rust 侧 MCP 服务端读 WebView 设置时经此往返。
// 同样非阻塞——桥装不上只意味着 settings.* 工具会报超时，不应拖住应用启动。
void installStateBridge().catch((error) => {
  console.error("[mcp-state-bridge] 安装失败", error);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
