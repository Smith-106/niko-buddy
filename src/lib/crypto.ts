/**
 * API key encryption utilities using device-bound cryptography.
 *
 * Implements AES-256-GCM authenticated encryption with device fingerprint binding:
 * - Key derivation: SHA-256 of device identifier (machine + user + OS)
 * - Encryption: AES-256-GCM with random nonce and authentication tag
 * - Storage format: `enc::v1::<base64(nonce || ciphertext || tag)>`
 * - Fallback: Random localStorage-based fingerprint for non-Tauri environments
 *
 * @license MIT © QMAI
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/platform"

const ENCRYPTED_PREFIX = "enc::v1::"

// Cache derived key to avoid repeated expensive operations
let cachedKey: CryptoKey | null = null
let cachedFingerprint: string | null = null

/**
 * Retrieve device fingerprint bound to this hardware/user combination.
 * 
 * In Tauri environment: invokes Rust command for cryptographically secure fingerprint.
 * In browser-only environment: falls back to localStorage-stored random UUID.
 * 
 * Note: Fallback fingerprint is not cached to allow re-attempt when Tauri becomes available.
 */
export async function getDeviceFingerprint(): Promise<string> {
  // Attempt Tauri-backed fingerprint in desktop environment
  if (isTauri()) {
    if (cachedFingerprint) return cachedFingerprint
    try {
      const fp = await invoke<string>("get_device_fingerprint_cmd")
      if (fp && fp.length >= 64) {
        cachedFingerprint = fp
        return cachedFingerprint
      }
      console.warn("[crypto] Device fingerprint too short, expected ≥64 chars, got:", fp?.length)
    } catch (e) {
      console.warn("[crypto] Failed to get device fingerprint, using fallback:", e)
    }
  }

  // Fallback: generate random fingerprint stored in localStorage
  let fallback = localStorage.getItem("qmai_fallback_fingerprint")
  if (!fallback) {
    const buf = new Uint8Array(32)
    crypto.getRandomValues(buf)
    fallback = Array.from(buf, b => b.toString(16).padStart(2, "0")).join("")
    localStorage.setItem("qmai_fallback_fingerprint", fallback)
  }
  // Do not cache fallback fingerprint to allow retry when Tauri is ready
  return fallback
}

/**
 * Derive AES-256 key from device fingerprint using hex conversion.
 * Includes validation to prevent invalid fingerprint formats.
 */
async function getDeviceKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey

  const fingerprint = await getDeviceFingerprint()

  // Convert fingerprint hex string to bytes with validation
  const keyMaterial = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    const hexByte = fingerprint.slice(i * 2, i * 2 + 2)
    const parsed = parseInt(hexByte, 16)
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid device fingerprint format at position ${i * 2}`)
    }
    keyMaterial[i] = parsed
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )

  cachedKey = key
  return key
}

/**
 * Check if a value is encrypted with our prefix format.
 */
export function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX)
}

/**
 * Encrypt a plaintext string using device-bound AES-256-GCM.
 * @param plaintext The text to encrypt
 * @returns Encrypted string with prefix (or original if empty/already encrypted)
 */
export async function encryptString(plaintext: string): Promise<string> {
  if (!plaintext) return plaintext
  if (isEncrypted(plaintext)) return plaintext // Avoid double encryption

  const key = await getDeviceKey()

  // Generate 12-byte random nonce (GCM recommendation)
  const nonce = new Uint8Array(12)
  crypto.getRandomValues(nonce)

  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    encoded,
  )

  // Combine: nonce (12 bytes) + ciphertext + auth tag
  const combined = new Uint8Array(nonce.length + ciphertext.byteLength)
  combined.set(nonce, 0)
  combined.set(new Uint8Array(ciphertext), nonce.length)

  // Base64 encode using iterative approach to avoid stack overflow on large data
  let binary = ""
  for (let i = 0; i < combined.length; i++) {
    binary += String.fromCharCode(combined[i])
  }
  const b64 = btoa(binary)
  return ENCRYPTED_PREFIX + b64
}

/**
 * Decrypt an encrypted string using device-bound AES-256-GCM.
 * @param ciphertext Encrypted string with prefix
 * @returns Decrypted plaintext (or original if not encrypted)
 */
export async function decryptString(ciphertext: string): Promise<string> {
  if (!ciphertext) return ciphertext
  if (!isEncrypted(ciphertext)) {
    // Unencrypted plaintext, return as-is for backward compatibility
    return ciphertext
  }

  const data = ciphertext.slice(ENCRYPTED_PREFIX.length)
  const binary = Uint8Array.from(atob(data), c => c.charCodeAt(0))

  if (binary.length < 12) {
    throw new Error("Ciphertext too short")
  }

  const key = await getDeviceKey()
  const nonce = binary.slice(0, 12)
  const cipherData = binary.slice(12)

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    cipherData,
  )

  return new TextDecoder().decode(plaintext)
}

/**
 * Safely encrypt API key, throwing error on failure instead of returning plaintext.
 */
export async function safeEncryptApiKey(plaintext: string): Promise<string> {
  try {
    return await encryptString(plaintext)
  } catch (e) {
    console.error("[crypto] Encryption failed, refusing to return plaintext:", e)
    throw new Error(`API key encryption failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Safely decrypt API key, returning empty string on failure.
 */
export async function safeDecryptApiKey(ciphertext: string): Promise<string> {
  try {
    return await decryptString(ciphertext)
  } catch (e) {
    console.warn("[crypto] Decryption failed, keys may be mismatched:", e)
    // Decryption failed, possibly different device, return empty for re-entry
    return ""
  }
}

// ── Object-level recursive encryption tools ────────────────────────────────────

const API_KEY_FIELD_PATTERN = /api[_-]?key/i

/**
 * Recursively encrypt all API key fields in an object tree.
 * Matches field names: apiKey, api_key, api-key, API_KEY, etc.
 */
export async function encryptApiKeysInObject<T = unknown>(obj: T): Promise<T> {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === "string") return obj
  if (typeof obj !== "object") return obj

  // Handle arrays
  if (Array.isArray(obj)) {
    const results = await Promise.all(obj.map(item => encryptApiKeysInObject(item)))
    return results as unknown as T
  }

  // Handle objects
  const result: Record<string, unknown> = { ...(obj as Record<string, unknown>) }
  for (const [key, value] of Object.entries(result)) {
    if (API_KEY_FIELD_PATTERN.test(key) && typeof value === "string" && value) {
      result[key] = await safeEncryptApiKey(value)
    } else if (typeof value === "object" && value !== null) {
      result[key] = await encryptApiKeysInObject(value)
    }
  }
  return result as T
}

/**
 * Recursively decrypt all API key fields in an object tree.
 */
export async function decryptApiKeysInObject<T = unknown>(obj: T): Promise<T> {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === "string") return obj
  if (typeof obj !== "object") return obj

  // Handle arrays
  if (Array.isArray(obj)) {
    const results = await Promise.all(obj.map(item => decryptApiKeysInObject(item)))
    return results as unknown as T
  }

  // Handle objects
  const result: Record<string, unknown> = { ...(obj as Record<string, unknown>) }
  for (const [key, value] of Object.entries(result)) {
    if (API_KEY_FIELD_PATTERN.test(key) && typeof value === "string" && value) {
      result[key] = await safeDecryptApiKey(value)
    } else if (typeof value === "object" && value !== null) {
      result[key] = await decryptApiKeysInObject(value)
    }
  }
  return result as T
}

// ── Encryption status statistics and migration ────────────────────────────────

/**
 * Count encrypted vs plaintext API key fields in an object tree.
 * Returns total count plus breakdown by encryption status.
 */
export function countApiKeyStatus(obj: unknown): { total: number; encrypted: number; plaintext: number } {
  let total = 0
  let encrypted = 0
  let plaintext = 0

  function walk(value: unknown) {
    if (value === null || value === undefined) return
    if (typeof value === "string") return
    if (typeof value !== "object") return

    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }

    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (API_KEY_FIELD_PATTERN.test(key) && typeof val === "string") {
        if (val) {
          total++
          if (isEncrypted(val)) {
            encrypted++
          } else {
            plaintext++
          }
        }
      } else if (typeof val === "object" && val !== null) {
        walk(val)
      }
    }
  }

  walk(obj)
  return { total, encrypted, plaintext }
}
