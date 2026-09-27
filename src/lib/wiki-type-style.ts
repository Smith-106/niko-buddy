import type { LucideIcon } from "lucide-react"
import {
  User,
  Lightbulb,
  HelpCircle,
  FileText,
  Target,
  TrendingUp,
  BookOpen,
  Calendar,
  Hash,
} from "lucide-react"

export interface WikiTypeStyle {
  /** Display label for chips and tooltips. Capitalized. */
  label: string
  /** Lucide icon component for the type. */
  icon: LucideIcon
  /**
   * Tailwind classes for a colored chip (background + text). Includes
   * dark-mode variants so the chip stays readable on either theme.
   */
  chipClass: string
  /**
   * Tailwind class for the type's accent dot or border (without the
   * 15% opacity used by chips). Useful for connector lines.
   */
  dotClass: string
}

export const WIKI_TYPE_STYLES: Record<string, WikiTypeStyle> = {
  entity: {
    label: "Entity",
    icon: User,
    chipClass: "bg-info/15 text-info dark:text-info",
    dotClass: "bg-info",
  },
  concept: {
    label: "Concept",
    icon: Lightbulb,
    chipClass: "bg-success/15 text-success dark:text-success",
    dotClass: "bg-success",
  },
  query: {
    label: "Query",
    icon: HelpCircle,
    chipClass: "bg-warning/15 text-warning dark:text-warning",
    dotClass: "bg-warning",
  },
  source: {
    label: "Source",
    icon: FileText,
    chipClass: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
    dotClass: "bg-slate-500",
  },
  thesis: {
    label: "Thesis",
    icon: Target,
    chipClass: "bg-destructive/15 text-destructive dark:text-destructive",
    dotClass: "bg-destructive",
  },
  finding: {
    label: "Finding",
    icon: TrendingUp,
    chipClass: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
    dotClass: "bg-purple-500",
  },
  event: {
    label: "Event",
    icon: Calendar,
    chipClass: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
    dotClass: "bg-cyan-500",
  },
  overview: {
    label: "Overview",
    icon: BookOpen,
    chipClass: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
    dotClass: "bg-indigo-500",
  },
  chapter: {
    label: "Chapter",
    icon: BookOpen,
    chipClass: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
    dotClass: "bg-indigo-500",
  },
  outline: {
    label: "Outline",
    icon: FileText,
    chipClass: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
    dotClass: "bg-cyan-500",
  },
}

export const FALLBACK_TYPE_STYLE: WikiTypeStyle = {
  label: "Page",
  icon: Hash,
  chipClass: "bg-muted text-muted-foreground",
  dotClass: "bg-muted-foreground/60",
}

export function getWikiTypeStyle(type: string | null | undefined): WikiTypeStyle {
  if (!type) return FALLBACK_TYPE_STYLE
  const key = type.trim().toLowerCase()
  return WIKI_TYPE_STYLES[key] ?? FALLBACK_TYPE_STYLE
}
