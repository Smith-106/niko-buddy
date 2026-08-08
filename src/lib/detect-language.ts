/**
 * @license MIT © QMAI
 *
 * Language detection based on Unicode script ranges and Latin-script
 * diacritic / keyword heuristics.  Covers 20+ major writing systems.
 */

/**
 * Map a single Unicode code-point to its script family.
 * Returns `null` when the code-point does not fall inside any tracked range.
 */
function classifyScript(cp: number): string | null {
  // CJK Unified Ideographs — shared by Chinese and Japanese Kanji
  if (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  ) return "Chinese"

  // Japanese Hiragana / Katakana
  if (
    (cp >= 0x3040 && cp <= 0x309f) ||
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0xff65 && cp <= 0xff9f)
  ) return "Japanese"

  // Korean Hangul
  if (
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3130 && cp <= 0x318f)
  ) return "Korean"

  // Arabic script
  if (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x08a0 && cp <= 0x08ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  ) return "Arabic"

  // Hebrew
  if ((cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f)) return "Hebrew"

  // Thai
  if (cp >= 0x0e00 && cp <= 0x0e7f) return "Thai"

  // Devanagari — Hindi, Sanskrit, Marathi, Nepali
  if (cp >= 0x0900 && cp <= 0x097f) return "Hindi"

  // Bengali
  if (cp >= 0x0980 && cp <= 0x09ff) return "Bengali"

  // Tamil
  if (cp >= 0x0b80 && cp <= 0x0bff) return "Tamil"

  // Telugu
  if (cp >= 0x0c00 && cp <= 0x0c7f) return "Telugu"

  // Kannada
  if (cp >= 0x0c80 && cp <= 0x0cff) return "Kannada"

  // Malayalam
  if (cp >= 0x0d00 && cp <= 0x0d7f) return "Malayalam"

  // Gujarati
  if (cp >= 0x0a80 && cp <= 0x0aff) return "Gujarati"

  // Gurmukhi — Punjabi
  if (cp >= 0x0a00 && cp <= 0x0a7f) return "Punjabi"

  // Myanmar — Burmese
  if (cp >= 0x1000 && cp <= 0x109f) return "Burmese"

  // Khmer — Cambodian
  if (cp >= 0x1780 && cp <= 0x17ff) return "Khmer"

  // Lao
  if (cp >= 0x0e80 && cp <= 0x0eff) return "Lao"

  // Georgian
  if ((cp >= 0x10a0 && cp <= 0x10ff) || (cp >= 0x2d00 && cp <= 0x2d2f)) return "Georgian"

  // Armenian
  if (cp >= 0x0530 && cp <= 0x058f) return "Armenian"

  // Ethiopic — Amharic
  if (cp >= 0x1200 && cp <= 0x137f) return "Amharic"

  // Tibetan
  if (cp >= 0x0f00 && cp <= 0x0fff) return "Tibetan"

  // Sinhala
  if (cp >= 0x0d80 && cp <= 0x0dff) return "Sinhala"

  // Cyrillic — default to Russian
  if ((cp >= 0x0400 && cp <= 0x04ff) || (cp >= 0x0500 && cp <= 0x052f)) return "Russian"

  // Greek
  if ((cp >= 0x0370 && cp <= 0x03ff) || (cp >= 0x1f00 && cp <= 0x1fff)) return "Greek"

  return null
}

/**
 * Disambiguate Arabic-script text between Arabic and Persian by scoring
 * language-specific characters and high-frequency words.
 */
function resolveArabicScript(text: string): "Arabic" | "Persian" {
  let persian = 0
  let arabic = 0

  for (const ch of text) {
    switch (ch) {
      case "پ": case "چ": case "ژ": case "گ":
        persian += 3; break
      case "ک": case "ی":
        persian += 1; break
      case "ك": case "ي": case "ة": case "ى":
      case "إ": case "أ": case "ؤ": case "ئ":
        arabic += 1; break
    }
  }

  const normalised = ` ${text.replace(/[^\p{L}\p{N}]+/gu, " ")} `
  const persianVocab = ["این", "است", "که", "برای", "های", "را", "در", "به", "از", "می", "یک"]
  const arabicVocab = ["ال", "في", "من", "على", "هذا", "هذه", "إلى", "التي", "الذي", "كان"]

  for (const w of persianVocab) if (normalised.includes(` ${w} `)) persian += 2
  for (const w of arabicVocab) if (normalised.includes(` ${w} `)) arabic += 2

  return persian >= 3 && persian > arabic ? "Persian" : "Arabic"
}

/**
 * Identify Latin-script languages via diacritics and high-frequency
 * word patterns.  Returns `null` when no signal is strong enough.
 */
function resolveLatinScript(text: string): string | null {
  const lc = text.toLowerCase()

  // Vietnamese — exclusive tone / horn marks
  if (/[ảạắằẳẵặấầẩẫậđẻẽẹếềểễệỉĩịỏọốồổỗộơớờởỡợủũụưứừửữựỷỹỵ]/.test(lc)) return "Vietnamese"

  // Turkish — ğ, ı, ş combined with Turkish vocabulary
  if (/[ğış]/.test(lc) && /\b(bir|ve|için|ile|bu|da|de|değil|ama)\b/.test(lc)) return "Turkish"

  // Polish
  if (/[ąćęłńóśźż]/.test(lc)) return "Polish"

  // Czech / Slovak
  if (/[ěšžřďťňů]/.test(lc)) return "Czech"

  // Romanian
  if (/[ăâîșț]/.test(lc) && /\b(și|este|sau|care|pentru)\b/.test(lc)) return "Romanian"

  // Hungarian — double-acute vowels
  if (/[őű]/.test(lc)) return "Hungarian"

  // German
  if (/[äöüß]/.test(lc) && /\b(und|der|die|das|ist)\b/.test(lc)) return "German"

  // French
  if (/[àâçéèêëïîôùûüÿœæ]/.test(lc) && /\b(le|la|les|est|une|des)\b/.test(lc)) return "French"

  // Portuguese — must precede Spanish (stricter char set)
  if (/[ãõç]/.test(lc) && /\b(o|a|os|as|de|do|da|é|em|um|uma|não|que)\b/.test(lc)) return "Portuguese"

  // Spanish — narrow word set to avoid Portuguese overlap
  if (/[áéíóúñ¿¡]/.test(lc) || (/\b(el|la|los|las|de|del|es|en|por|que|un|una)\b/.test(lc) && (/\b(el|los|las|del|por)\b/.test(lc) || /[ñ¿¡]/.test(lc)))) return "Spanish"

  // Italian
  if (/\b(il|della|gli|che|è)\b/.test(lc)) return "Italian"

  // Dutch
  if (/\b(het|een|van|dat)\b/.test(lc)) return "Dutch"

  // Swedish
  if (/[åäö]/.test(lc) && /\b(och|att|det|en|ett|är|för|med)\b/.test(lc)) return "Swedish"

  // Norwegian
  if (/[åæø]/.test(lc) && /\b(og|er|det|en|et|for|med|på)\b/.test(lc)) return "Norwegian"

  // Danish
  if (/[åæø]/.test(lc) && /\b(og|er|det|en|et|til|med|af)\b/.test(lc)) return "Danish"

  // Finnish
  if (/[äö]/.test(lc) && /\b(ja|on|ei|se|että|tai|kun|niin)\b/.test(lc)) return "Finnish"

  // Indonesian / Malay
  if (/\b(yang|dari|untuk|dengan|adalah)\b/.test(lc)) return "Indonesian"

  // Swahili
  if (/\b(na|ya|wa|ni|kwa|katika|hii|hiyo)\b/.test(lc)) return "Swahili"

  return null
}

/**
 * Detect the dominant language of a text string.
 *
 * The algorithm works in three stages:
 * 1. Count characters per Unicode script range.
 * 2. If a non-Latin script dominates, return it (with Japanese/Chinese
 *    disambiguation and Arabic/Persian sub-resolution).
 * 3. For Latin-script text, apply diacritic and keyword heuristics.
 *
 * Falls back to `"English"` when no stronger signal is found.
 */
export function detectLanguage(text: string): string {
  const tallies: Record<string, number> = {}

  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (!cp || cp < 0x80) continue
    const script = classifyScript(cp)
    if (script) tallies[script] = (tallies[script] ?? 0) + 1
  }

  // Japanese uses Hiragana/Katakana alongside Kanji — pure CJK without
  // kana is classified as Chinese.
  if ((tallies.Japanese ?? 0) > 0 && (tallies.Chinese ?? 0) > 0) return "Japanese"

  let topScript = ""
  let topCount = 0
  for (const [script, count] of Object.entries(tallies)) {
    if (count > topCount) { topScript = script; topCount = count }
  }

  if (topScript === "Arabic" && topCount >= 2) return resolveArabicScript(text)
  if (topScript && topCount >= 2) return topScript

  const latin = resolveLatinScript(text)
  if (latin) return latin

  return "English"
}
