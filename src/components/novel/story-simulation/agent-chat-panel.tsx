import { useTranslation } from "react-i18next";
import { Send, X, Download, Save, Loader2 } from "lucide-react";
import type { AgentChatMessage } from "@/lib/novel";
import { Button } from "@/components/ui/button";
import { isImeComposing } from "@/lib/keyboard-utils";

export interface AgentChatPanelProps {
  agentName: string;
  messages: AgentChatMessage[];
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onClose: () => void;
  onExport: () => void;
  onSave: () => void;
  sending: boolean;
  exporting: boolean;
  saving: boolean;
  chatLogRef: React.RefObject<HTMLDivElement | null>;
}

/** 角色对话面板（F4-5 自 story-simulation-view.tsx 剥离，无行为变更）。 */
export function AgentChatPanel({
  agentName,
  messages,
  input,
  onInputChange,
  onSend,
  onClose,
  onExport,
  onSave,
  sending,
  exporting,
  saving,
  chatLogRef,
}: AgentChatPanelProps) {
  const { t } = useTranslation()
  return (
    <div className="flex w-80 shrink-0 flex-col border-l">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="text-sm font-semibold">{t("storySimulation.chatWith", { name: agentName })}</div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onSave}
            title={t("storySimulation.saveInterviewTip")}
            disabled={saving || messages.length === 0}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onExport}
            title={t("storySimulation.exportChatMd")}
            disabled={exporting || messages.length === 0}
          >
            <Download className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onClose}
            title={t("storySimulation.closeChat")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div
        ref={chatLogRef}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm"
      >
        {messages.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            {t("storySimulation.chatHint", { name: agentName })}
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted"
                }`}
              >
                {msg.content || (sending && msg.role === "agent" ? "..." : "")}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="shrink-0 border-t p-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
              if (e.key === "Escape") {
                onInputChange("");
              }
            }}
            placeholder={t("storySimulation.chatPlaceholder")}
            className="flex-1 rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            disabled={sending}
          />
          <Button
            type="button"
            size="icon"
            className="h-8 w-8"
            onClick={onSend}
            disabled={sending || !input.trim()}
            title={t("chat.send", { defaultValue: "发送" })}
            aria-label={t("chat.send", { defaultValue: "发送" })}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
