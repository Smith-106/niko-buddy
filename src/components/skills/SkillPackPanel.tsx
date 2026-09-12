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
  type PackExportWarning,
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

/** 导出告警文案键（lib 只给结论码，文案只在本层）。 */
const EXPORT_WARNING_KEY: Record<PackExportWarning["code"], string> = {
  stripped_tool_fields: "skillpack.export.warn.strippedToolFields",
  stripped_prompt_lines: "skillpack.export.warn.strippedPromptLines",
  no_skills_selected: "skillpack.export.warn.noSkillsSelected",
  stripped_pack_fields: "skillpack.export.warn.strippedPackFields",
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

  const exportWarningText = (warning: PackExportWarning): string => {
    switch (warning.code) {
      case "stripped_tool_fields":
      case "stripped_pack_fields":
        return t(EXPORT_WARNING_KEY[warning.code], { fields: warning.fields.join(", ") });
      case "stripped_prompt_lines":
        return t(EXPORT_WARNING_KEY[warning.code], { n: warning.n });
      default:
        return t(EXPORT_WARNING_KEY.no_skills_selected);
    }
  };

  const handleFile = async (file: File) => {
    // 读取也可能失败（权限/磁盘）；旧实现把它留在 try 之外，调用处的 void 会吞掉 rejection。
    let text: string;
    try {
      text = await file.text();
    } catch {
      setResult({
        ok: false,
        issues: [{ code: "schema_invalid", at: "", detail: t("skillpack.issueDetail.readFailed") }],
      });
      return;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      setResult({
        ok: false,
        issues: [{ code: "schema_invalid", at: "", detail: t("skillpack.issueDetail.invalidJson") }],
      });
      return;
    }
    const imported = importNbskillPack(parsed, { categoryId });
    setResult(imported);
    if (imported.ok) {
      // 描述文案在 UI 层生成：lib 不得产出用户可见自然语言。
      const level = t(TRUST_LABEL_KEY[imported.trustLevel]);
      onImported?.({
        ...imported,
        skills: imported.skills.map((skill) => ({
          ...skill,
          description: t("skillpack.importedDescription", {
            name: imported.packName,
            version: imported.packVersion,
            level,
          }),
        })),
      });
    }
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
          {t("skillpack.skillCount", { n: skills.length })}
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
          {exportPreview.warnings.map((warning) => (
            <li
              key={`${warning.code}:${"fields" in warning ? warning.fields.join(",") : "n" in warning ? warning.n : ""}`}
            >
              {exportWarningText(warning)}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex gap-2" data-testid="skillpack-trust-badges">
        {badges.map((badge) => (
          <span
            key={badge.level}
            data-testid={`skillpack-badge-${badge.level}`}
            className="rounded border px-2 py-0.5 text-xs"
            title={t(
              mayEnterCanonTruth(badge.level)
                ? "skillpack.badge.mayEnterTruth"
                : "skillpack.badge.notTruthEligible",
            )}
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
        <>
          <p data-testid="skillpack-import-result" className="text-xs">
            {t("skillpack.imported", {
              n: result.skills.length,
              level: t(TRUST_LABEL_KEY[result.trustLevel]),
            })}
          </p>
          {result.trustReclassified ? (
            <p data-testid="skillpack-trust-reclassified" className="text-xs text-amber-600">
              {t("skillpack.trustReclassified", {
                declared: t(TRUST_LABEL_KEY[result.trustReclassified.declared]),
                effective: t(TRUST_LABEL_KEY[result.trustReclassified.effective]),
              })}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export default SkillPackPanel;
