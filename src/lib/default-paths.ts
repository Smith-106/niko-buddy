/**
 * Default directory path constants and utilities.
 * MIT licensed implementation.
 */

const FALLBACK_INSTALL_DRIVE = "D" as const

/** Default name for novel writing project directory */
export const DEFAULT_NOVEL_DIR_NAME = "QM-BOOK"

/** Default name for application installation directory */
export const DEFAULT_INSTALL_DIR_NAME = "QMaiWrite"

/**
 * Extracts Windows drive letter from a path string.
 * @param pathLike - A path string like "C:\Users"
 * @returns Drive letter uppercase (e.g., "C") or null if not a valid Windows path
 */
function extractWindowsDriveLetter(pathLike: string): string | null {
  const match = pathLike.trim().match(/^([a-zA-Z]):[\\\/]/)
  return match ? match[1].toUpperCase() : null
}

/**
 * Builds the default novel directory path based on system install location.
 * @param pathLike - A path from which to extract the drive letter
 * @returns Full path like "D:\\QM-BOOK"
 */
export function buildDefaultNovelDir(pathLike: string): string {
  const drive = extractWindowsDriveLetter(pathLike) ?? FALLBACK_INSTALL_DRIVE
  return `${drive}:\\${DEFAULT_NOVEL_DIR_NAME}`
}
