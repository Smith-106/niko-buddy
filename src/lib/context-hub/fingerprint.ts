import { bytesToHex } from "@/lib/utils"

export async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return bytesToHex(new Uint8Array(digest))
}
