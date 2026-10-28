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
    chipClass: "bg-kind-slate/15 text-kind-slate dark:text-kind-slate",
    dotClass: "bg-kind-slate",
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
    chipClass: "bg-kind-purple/15 text-kind-purple dark:text-kind-purple",
    dotClass: "bg-kind-purple",
  },
  event: {
    label: "Event",
    icon: Calendar,
    chipClass: "bg-kind-cyan/15 text-kind-cyan dark:text-kind-cyan",
    dotClass: "bg-kind-cyan",
  },
  overview: {
    label: "Overview",
    icon: BookOpen,
    chipClass: "bg-kind-indigo/15 text-kind-indigo dark:text-kind-indigo",
    dotClass: "bg-kind-indigo",
  },
  chapter: {
    label: "Chapter",
    icon: BookOpen,
    chipClass: "bg-kind-indigo text-kind-indigo dark:bg-kind-indigo dark:text-kind-indigo",
    dotClass: "bg-kind-indigo",
  },
  outline: {
    label: "Outline",
    icon: FileText,
    chipClass: "bg-kind-cyan text-kind-cyan dark:bg-kind-cyan dark:text-kind-cyan",
    dotClass: "bg-kind-cyan",
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
