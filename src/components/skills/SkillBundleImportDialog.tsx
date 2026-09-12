/**
 * SkillBundleImportDialog.tsx — F-002 技能包导入对话框（TASK-006）。
 *
 * 设计要点：
 *   - **导入前的逐项确认不是装饰**：勾选框状态直接作为 Rust `confirmed` 参数传入，
 *     用户资产域（`RequireGate`）在未确认时由写入权威矩阵机械拒绝。
 *   - **信任级别以 UI 明示**：untrusted 徽标恒定展示，不随包内自述变化。
 *   - **可写产物清单前置**：`writable_artifacts` 为空时显式提示「未声明」，避免
 *     「没列出来 = 没权限」被误读为「没列出来 = 随便写」。
 *   - 校验结论（拒绝项 / 哈希不匹配）逐条展示，存在任一条即禁用导入按钮。
 */

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  SKILL_BUNDLE_TRUST_UNTRUSTED,
  importSkillBundle,
  summarizeImportGate,
  verifySkillBundle,
  type SkillBundleImportResult,
  type SkillBundleVerifyResult,
} from "@/lib/novel"

export interface SkillBundleImportDialogProps {
  /** 是否打开。 */
  open: boolean
  /** 待校验/导入的技能包路径（null 表示未选择）。 */
  bundlePath: string | null
  /** 导入落点根（用户资产域根；由宿主传入，用户不可在弹窗内改写）。 */
  destRoot: string | null
  onClose: () => void
  onImported?: (result: SkillBundleImportResult) => void
}

export function SkillBundleImportDialog({
  open,
  bundlePath,
  destRoot,
  onClose,
  onImported,
}: SkillBundleImportDialogProps) {
  const { t } = useTranslation()
  const [verify, setVerify] = useState<SkillBundleVerifyResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [imported, setImported] = useState<SkillBundleImportResult | null>(null)

  useEffect(() => {
    if (!open || !bundlePath) return
    let cancelled = false
    setBusy(true)
    setError(null)
    setImported(null)
    setConfirmed(false)
    verifySkillBundle(bundlePath)
      .then((result) => {
        if (!cancelled) setVerify(result)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause))
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, bundlePath])

  if (!open) return null

  const gate = verify ? summarizeImportGate(verify) : null
  const manifest = verify?.manifest
  const canImport = Boolean(gate?.canImport && destRoot && confirmed && !imported)

  const handleImport = async () => {
    if (!bundlePath || !destRoot || !canImport) return
    setBusy(true)
    setError(null)
    try {
      const result = await importSkillBundle(bundlePath, destRoot, confirmed)
      setImported(result)
      onImported?.(result)
    } catch (cause: unknown) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[640px] max-h-[80vh] overflow-y-auto rounded-lg bg-background p-6 shadow-xl">
        <h2 className="mb-3 text-lg font-semibold">{t("skillbundle.import.title")}</h2>

        {/* 信任级别恒定展示：untrusted 不由包内自述决定。 */}
        <p className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span className="font-mono">{SKILL_BUNDLE_TRUST_UNTRUSTED}</span> —{" "}
          {t("skillbundle.import.trustUntrusted")}
        </p>

        {busy && <p className="text-sm opacity-70">…</p>}
        {error && <p className="mb-3 text-sm text-red-500">{error}</p>}

        {manifest && (
          <dl className="mb-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="opacity-70">id</dt>
            <dd className="font-mono">{manifest.id}</dd>
            <dt className="opacity-70">name</dt>
            <dd>{manifest.name}</dd>
            <dt className="opacity-70">version</dt>
            <dd className="font-mono">{manifest.version}</dd>
            <dt className="opacity-70">schema</dt>
            <dd className="font-mono">
              {manifest.schema} (v{manifest.schema_version})
            </dd>
            <dt className="opacity-70">min_nb_version</dt>
            <dd className="font-mono">{manifest.min_nb_version}</dd>
            <dt className="opacity-70">source</dt>
            <dd>{manifest.source}</dd>
          </dl>
        )}

        {manifest && (
          <section className="mb-3 text-sm">
            <h3 className="mb-1 font-medium">{t("skillbundle.import.readableState")}</h3>
            <ul className="ml-4 list-disc">
              {manifest.allowlist.readable_state.length === 0 ? (
                <li>{t("skillbundle.import.noWritableArtifacts")}</li>
              ) : (
                manifest.allowlist.readable_state.map((key) => <li key={key}>{key}</li>)
              )}
            </ul>
            <h3 className="mt-2 mb-1 font-medium">{t("skillbundle.import.writableArtifacts")}</h3>
            <ul className="ml-4 list-disc">
              {manifest.allowlist.writable_artifacts.length === 0 ? (
                <li>{t("skillbundle.import.noWritableArtifacts")}</li>
              ) : (
                manifest.allowlist.writable_artifacts.map((artifact) => (
                  <li key={artifact} className="font-mono">
                    {artifact}
                  </li>
                ))
              )}
            </ul>
          </section>
        )}

        {verify && verify.rejected.length > 0 && (
          <section className="mb-3 text-sm">
            <h3 className="mb-1 font-medium text-red-500">{t("skillbundle.import.rejected")}</h3>
            <ul className="ml-4 list-disc">
              {verify.rejected.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </section>
        )}

        {verify && verify.mismatched.length > 0 && (
          <section className="mb-3 text-sm">
            <h3 className="mb-1 font-medium text-red-500">{t("skillbundle.import.mismatched")}</h3>
            <ul className="ml-4 list-disc font-mono">
              {verify.mismatched.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </section>
        )}

        {gate && !gate.canImport && (
          <p className="mb-3 text-sm text-red-500">{t("skillbundle.import.gateDenied")}</p>
        )}

        <label className="mb-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={!gate?.canImport || Boolean(imported)}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>{t("skillbundle.import.confirm")}</span>
        </label>

        {imported && (
          <section className="mb-4 rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
            <p className="font-mono">{imported.installed_dir}</p>
            <ul className="ml-4 list-disc">
              {imported.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </section>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy}>
            {t("common.close")}
          </button>
          <button type="button" onClick={handleImport} disabled={!canImport || busy}>
            {t("skillbundle.import.submit")}
          </button>
        </div>
      </div>
    </div>
  )
}

export default SkillBundleImportDialog
