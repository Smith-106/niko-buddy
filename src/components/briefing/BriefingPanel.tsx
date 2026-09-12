import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  buildMemoryPatch,
  renderBriefing,
  type BriefingDigest,
  type CanonClaim,
  type MemoryPatchDraft,
  type MemoryPatchDraft as PatchDraft,
  type RenderedLine,
} from "@/lib/novel";

export interface BriefingPanelProps {
  digest: BriefingDigest;
  /** canon 侧权威取值；命中且不同即以 canon 为准并渲染 divergence 块。 */
  canonClaims?: CanonClaim[];
  /**
   * opt-in 写入回调。**不传即完全只读**——面板不会自己去写任何文件；
   * 传入时也只在用户显式勾选后才调用（默认禁用）。
   */
  onWritePatch?: (patch: PatchDraft) => Promise<void>;
}

/**
 * 续写简报面板（F-003）：五类确定性来源的只读呈现 + 逐条溯源 + opt-in 记忆补丁。
 *
 * 默认无写入路径：写入按钮在勾选前 `disabled`，且没有 `onWritePatch` 时永远不启用。
 */
export function BriefingPanel({ digest, canonClaims = [], onWritePatch }: BriefingPanelProps) {
  const { t } = useTranslation();
  const [sourceOpen, setSourceOpen] = useState<string | null>(null);
  const [patchOptIn, setPatchOptIn] = useState(false);
  const [patchState, setPatchState] = useState<"idle" | "busy" | "done" | "failed">("idle");

  const rendered = useMemo(() => renderBriefing(digest, canonClaims), [digest, canonClaims]);
  const patch = useMemo(
    () => buildMemoryPatch(digest, new Date().toISOString()),
    [digest],
  );

  const sourceLine = (line: RenderedLine) =>
    `${line.source.kind}:${line.source.path}#${line.source.jsonPointer}`;

  return (
    <section data-testid="briefing-panel" className="flex h-full flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("briefing.title")}</h2>
        <span className="text-xs opacity-70" data-testid="briefing-source-count">
          {digest.assertions.length} sourced assertions
        </span>
      </header>

      {rendered.warnings.length > 0 ? (
        <ul className="text-xs text-amber-600" data-testid="briefing-warnings">
          {rendered.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      {rendered.blocks.map((block) => (
        <section key={block.kind} data-testid={`briefing-block-${block.kind}`}>
          <h3 className="text-sm font-medium">{block.title}</h3>
          <ul className="mt-1 space-y-0.5 text-xs">
            {block.lines.map((line) => (
              <li key={line.id} className="flex items-start gap-2">
                <span>{line.text}</span>
                <button
                  type="button"
                  data-testid={`briefing-source-${line.id}`}
                  className="rounded border px-1 text-[10px] opacity-70"
                  onClick={() =>
                    setSourceOpen((prev) => (prev === line.id ? null : line.id))
                  }
                >
                  {t("briefing.source.badge")}
                </button>
                {sourceOpen === line.id ? (
                  <code className="text-[10px] opacity-80" data-testid="briefing-source-detail">
                    {sourceLine(line)}
                  </code>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {rendered.divergence.length > 0 ? (
        <section data-testid="briefing-divergence">
          <h3 className="text-sm font-medium">divergence</h3>
          <p className="text-xs text-amber-600">{t("briefing.divergence.warning")}</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {rendered.divergence.map((d) => (
              <li key={d.claimKey} data-testid={`briefing-divergence-${d.claimKey}`}>
                <code>
                  {d.claimKey}: projection={d.projectionSide} / canon={d.canonSide}
                  {d.canonSource ? ` (${d.canonSource})` : ""}
                </code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="mt-auto flex items-center gap-2 border-t pt-2">
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            data-testid="briefing-patch-optin"
            checked={patchOptIn}
            onChange={(e) => setPatchOptIn(e.target.checked)}
          />
          {t("briefing.patch.optin")}
        </label>
        <button
          type="button"
          data-testid="briefing-patch-write"
          disabled={!patchOptIn || !onWritePatch || patchState === "busy"}
          onClick={() => {
            if (!onWritePatch) return;
            setPatchState("busy");
            void onWritePatch(patch as MemoryPatchDraft)
              .then(() => setPatchState("done"))
              .catch(() => setPatchState("failed"));
          }}
        >
          write
        </button>
        {patchState !== "idle" ? (
          <span className="text-xs" data-testid="briefing-patch-state">
            {patchState}
          </span>
        ) : null}
      </footer>
    </section>
  );
}

export default BriefingPanel;
