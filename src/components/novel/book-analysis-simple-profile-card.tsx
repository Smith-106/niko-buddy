import { useTranslation } from "react-i18next"
import type { PersonalityProfile } from "@/lib/novel"

/**
 * 简单提取 profile 卡片（feature/character-recognition-and-simple-mode）
 * 4 字段 + 代表性台词渲染
 *
 * M13-2：自 `book-analysis-result-viewer.tsx` 尾部剥出的内聚纯展示组件，
 * 与拆文库 library 域切片（style-card / character-panel / active-context /
 * book-list）无 props/shape 复用关系，故独立成文件而非强行复用双生切片。
 */
export function SimpleProfileCard({ profile }: { profile: PersonalityProfile }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border p-4 space-y-2">
      <div>
        <h4 className="text-sm font-semibold">{t("bookAnalysis.personality")}</h4>
        <p className="text-sm text-muted-foreground">{profile.personality}</p>
      </div>
      <div>
        <h4 className="text-sm font-semibold">{t("bookAnalysis.motivation")}</h4>
        <p className="text-sm text-muted-foreground">{profile.motivation}</p>
      </div>
      <div>
        <h4 className="text-sm font-semibold">{t("bookAnalysis.speakingStyle")}</h4>
        <p className="text-sm text-muted-foreground">{profile.speechStyle}</p>
      </div>
      <div>
        <h4 className="text-sm font-semibold">{t("bookAnalysis.behaviorPattern")}</h4>
        <p className="text-sm text-muted-foreground">{profile.behaviorPatterns}</p>
      </div>
      {profile.quotes.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold">{t("bookAnalysis.representativeLine")}</h4>
          <ul className="text-sm text-muted-foreground list-disc list-inside">
            {profile.quotes.map((q, i) => (
              <li key={`quote-${q.slice(0, 32)}-${i}`}>「{q}」</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
