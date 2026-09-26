import type { PrePlugin, PrePluginInput, PrePluginOutput } from "../pipeline"
import type { ContextPack } from "@/lib/novel"

interface SoulDialogPluginDeps {
  shouldRequestSoulDialog?: (contextPack: ContextPack | null | undefined) => boolean
  onError?: (error: Error) => void
}

export function createSoulDialogPlugin(deps: SoulDialogPluginDeps = {}): PrePlugin {
  const { shouldRequestSoulDialog: shouldFn, onError } = deps

  return {
    name: "soul_dialog",
    priority: 40,
    run: async (input: PrePluginInput): Promise<PrePluginOutput> => {
      if (!input.novelMode || !input.contextPack) return {}

      try {
        const shouldRequest = shouldFn
          ? shouldFn(input.contextPack)
          : defaultShouldRequestSoulDialog(input.contextPack)

        if (shouldRequest) {
          return {
            shouldStop: true,
            stopReason: "soul_dialog_confirmation_required",
          }
        }
        return {}
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)))
        return {}
      }
    },
  }
}

function defaultShouldRequestSoulDialog(contextPack: ContextPack | null | undefined): boolean {
  return Boolean(contextPack?.characterAuras?.trim())
}
