import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  NBSKILL_PACK_EXTENSION,
  TRUST_LEVELS,
  buildPack,
  importNbskillPack,
  mayEnterCanonTruth,
  serializePack,
  type ImportResult,
  type PackValidationCode,
  type TrustLevel,
  type UserSkill,
} from "@/lib/novel";

/**
 * 展示层文案键。
 *
 * `untrusted/reviewed/trusted` 与 `schema_invalid` 等是**机器码**，直接渲染会在中文
 * 界面里露出英文（实机回归：面板曾显示 `8 skills` / `3 imported · trustLevel: untrusted`）。
 * 结论码由 lib 产出，文案只在本层。
 */
const TRUST_LABEL_KEY: Record<TrustLevel, string> = {
  untrusted: "skillpack.trust.untrusted",
  reviewed: "skillpack.trust.reviewed",
  trusted: "skillpack.trust.trusted",
};

const ISSUE_LABEL_KEY: Record<PackValidationCode, string> = {
  schema_version_unsupported: "skillpack.issue.schema_version_unsupported",
  schema_invalid: "skillpack.issue.schema_invalid",
  name_invalid: "skillpack.issue.name_invalid",
  tool_category_not_allowed: "skillpack.issue.tool_category_not_allowed",
  tool_name_invalid: "skillpack.issue.tool_name_invalid",
  tool_name_forbidden: "skillpack.issue.tool_name_forbidden",
};

export interface SkillPackPanelProps {
  /** 既有 user-skill-store 里可导出的技能集合。 */
  skills: UserSkill[];
  /** 目标分类 id（既有分类概念）。 */
  categoryId: string;
  /** 导入成功后落盘（由宿主走既有 store；面板自己不写盘）。 */
  onImported?: (result: ImportResult) => void;
}

/**
 * 技能包面板（F-006）：导出 / 导入 / 逐条信任徽标 / 非法分类错误列表。
 *
 * 无托管市场、无账号绑定、无任何网络请求：导入靠本地文件选择，导出靠本地 Blob 下载。
 * 默认没有任何写入动作——落盘由宿主经既有 `user-skill-store` 完成。
 */
export function SkillPackPanel({ skills, categoryId, onImported }: SkillPackPanelProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const exportPreview = useMemo(
    () =>
      buildPack(skills, {
        name: "niko-skills",
        version: "1.0.0",
      }),
    [skills],
  );

  const badges: { level: TrustLevel; count: number }[] = useMemo(() => {
    const counts = new Map<TrustLevel, number>();
    for (const level of TRUST_LEVELS) counts.set(level, 0);
    if (result?.ok) {
      counts.set(result.trustLevel, (counts.get(result.trustLevel) ?? 0) + result.skills.length);
    }
    return TRUST_LEVELS.map((level) => ({ level, count: counts.get(level) ?? 0 }));
  }, [result]);

  const handleFile = async (file: File) => {
    const text = await file.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      setResult({
        ok: false,
        issues: [{ code: "schema_invalid", at: "", detail: "file is not valid JSON" }],
      });
      return;
    }
    const imported = importNbskillPack(parsed, { categoryId });
    setResult(imported);
    if (imported.ok) onImported?.(imported);
  };

  const download = () => {
    const blob = new Blob([serializePack(exportPreview)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportPreview.fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section data-testid="skill-pack-panel" className="flex h-full flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("skillpack.title")}</h2>
        <span className="text-xs opacity-70">
          {t("skillpack.skillCount", { count: skills.length })}
        </span>
      </header>

      <div className="flex gap-2">
        <button type="button" data-testid="skillpack-export" onClick={download}>
          {t("skillpack.export")}
        </button>
        <button type="button" data-testid="skillpack-import" onClick={() => inputRef.current?.click()}>
          {t("skillpack.import")}
        </button>
        <input
          ref={inputRef}
          type="file"
          hidden
          accept={NBSKILL_PACK_EXTENSION}
          data-testid="skillpack-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </div>

      {exportPreview.warnings.length > 0 ? (
        <ul className="text-xs text-amber-600" data-testid="skillpack-export-warnings">
          {exportPreview.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex gap-2" data-testid="skillpack-trust-badges">
        {badges.map((badge) => (
          <span
            key={badge.level}
            data-testid={`skillpack-badge-${badge.level}`}
            className="rounded border px-2 py-0.5 text-xs"
            title={mayEnterCanonTruth(badge.level) ? "may enter truth surfaces" : "not truth-eligible"}
          >
            {t("skillpack.trustLevel")}: {t(TRUST_LABEL_KEY[badge.level])} ({badge.count})
          </span>
        ))}
      </div>

      <ul className="flex-1 space-y-0.5 overflow-auto text-xs" data-testid="skillpack-skills">
        {skills.map((skill) => (
          <li key={skill.id} className="font-mono">
            {skill.name}
          </li>
        ))}
      </ul>

      {result && !result.ok ? (
        <ul role="alert" data-testid="skillpack-errors" className="text-xs text-red-500">
          {result.issues.map((issue) => (
            <li key={`${issue.code}:${issue.at}`} title={issue.detail}>
              {t(ISSUE_LABEL_KEY[issue.code])}
              {issue.at ? `（${issue.at}）` : ""}
            </li>
          ))}
        </ul>
      ) : null}

      {result?.ok ? (
        <p data-testid="skillpack-import-result" className="text-xs">
          {t("skillpack.imported", {
            count: result.skills.length,
            level: t(TRUST_LABEL_KEY[result.trustLevel]),
          })}
        </p>
      ) : null}
    </section>
  );
}

export default SkillPackPanel;
