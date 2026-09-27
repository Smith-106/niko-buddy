import { Plus, RefreshCw, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BookAnalysisLibraryState } from "@/lib/novel"
import { BookAnalysisActiveContext } from "./book-analysis-active-context"
import { BookAnalysisCharacterPanel } from "./book-analysis-character-panel"
import { BookAnalysisStyleCard } from "./book-analysis-style-card"
import { useTranslation } from "react-i18next"

interface BookAnalysisLibraryLayoutProps {
  state: BookAnalysisLibraryState
  selectedBookId: string | null
  selectedCharacterId: string | null
  extractingStyle: boolean
  extractingCharacters: boolean
  addingToSoul: boolean
  onSelectBook: (bookId: string) => void
  onSelectCharacter: (characterId: string) => void
  onImportNovel: () => void
  onExtractStyle: () => void
  onToggleStyle: () => void
  onAddSelectedSkillsToSoul: (skillId: string) => void
  onReextractCharacters: () => void
  onDeleteBook: (bookId: string) => void
}

export function BookAnalysisLibraryLayout({
  state,
  selectedBookId,
  selectedCharacterId,
  extractingStyle,
  extractingCharacters,
  addingToSoul,
  onSelectCharacter,
  onImportNovel,
  onExtractStyle,
  onToggleStyle,
  onAddSelectedSkillsToSoul,
  onReextractCharacters,
}: BookAnalysisLibraryLayoutProps) {
  const { t } = useTranslation()
  const selectedBook = state.books.find((book) => book.id === selectedBookId) ?? state.books[0] ?? null

  return (
    <div className="flex h-full min-h-0 bg-muted/20">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b bg-background px-5 py-3">
          <div>
            <h2 className="text-xl font-semibold">拆书库</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("bookAnalysis.libraryManageHint")}</p>
          </div>
          <div className="flex items-center gap-2">
            {selectedBook && (
              <>
                <Button variant="outline" size="sm" onClick={onReextractCharacters} disabled={extractingCharacters}>
                  <Users className="mr-1.5 h-3.5 w-3.5" />
                  {extractingCharacters ? "提取中..." : "重新提取角色"}
                </Button>
                <Button variant="outline" size="sm" onClick={onExtractStyle} disabled={extractingStyle}>
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${extractingStyle ? "animate-spin" : ""}`} />
                  {extractingStyle ? "提取中..." : "重新提取文风"}
                </Button>
              </>
            )}
            <Button onClick={onImportNovel}>
              <Plus className="mr-2 h-4 w-4" />
              导入小说
            </Button>
          </div>
        </header>
        {selectedBook ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
            <div>
              <h3 className="text-lg font-semibold">{selectedBook.metadata.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedBook.metadata.totalChapters} 章 · {selectedBook.metadata.totalWords.toLocaleString()} 字
              </p>
            </div>
            <BookAnalysisStyleCard
              book={selectedBook}
              extracting={extractingStyle}
              onExtractStyle={onExtractStyle}
              onToggleStyle={onToggleStyle}
            />
            <BookAnalysisCharacterPanel
              book={selectedBook}
              selectedCharacterId={selectedCharacterId}
              addingToSoul={addingToSoul}
              onSelectCharacter={onSelectCharacter}
              onAddSelectedSkillsToSoul={onAddSelectedSkillsToSoul}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <div>
              <h3 className="text-lg font-semibold">{t("bookAnalysis.noWorks")}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{t("bookAnalysis.noWorksHint")}</p>
              <Button className="mt-4" onClick={onImportNovel}>{t("bookAnalysis.importNovel")}</Button>
            </div>
          </div>
        )}
      </main>
      <BookAnalysisActiveContext enabledStyle={state.enabledStyle} bindings={state.bindings} />
    </div>
  )
}
