const INITIAL_HASH = [
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
]

const ROUND_CONSTANTS = [
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
]

function add32(...values: number[]): number {
  let sum = 0
  for (const value of values) {
    sum = (sum + value) >>> 0
  }
  return sum
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount))
}

function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const bitLength = bytes.length * 8
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80

  const view = new DataView(padded.buffer)
  const highBits = Math.floor(bitLength / 0x100000000)
  const lowBits = bitLength >>> 0
  view.setUint32(paddedLength - 8, highBits, false)
  view.setUint32(paddedLength - 4, lowBits, false)

  const state = [...INITIAL_HASH]
  const messageSchedule = new Uint32Array(64)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      messageSchedule[index] = view.getUint32(offset + index * 4, false)
    }

    for (let index = 16; index < 64; index += 1) {
      const sigma0 =
        rotateRight(messageSchedule[index - 15], 7) ^
        rotateRight(messageSchedule[index - 15], 18) ^
        (messageSchedule[index - 15] >>> 3)
      const sigma1 =
        rotateRight(messageSchedule[index - 2], 17) ^
        rotateRight(messageSchedule[index - 2], 19) ^
        (messageSchedule[index - 2] >>> 10)
      messageSchedule[index] = add32(
        messageSchedule[index - 16],
        sigma0,
        messageSchedule[index - 7],
        sigma1,
      )
    }

    let [a, b, c, d, e, f, g, h] = state

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = add32(h, sum1, choose, ROUND_CONSTANTS[index], messageSchedule[index])
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = add32(sum0, majority)

      h = g
      g = f
      f = e
      e = add32(d, temp1)
      d = c
      c = b
      b = a
      a = add32(temp1, temp2)
    }

    state[0] = add32(state[0], a)
    state[1] = add32(state[1], b)
    state[2] = add32(state[2], c)
    state[3] = add32(state[3], d)
    state[4] = add32(state[4], e)
    state[5] = add32(state[5], f)
    state[6] = add32(state[6], g)
    state[7] = add32(state[7], h)
  }

  return state.map((value) => value.toString(16).padStart(8, "0")).join("")
}

export function stableCharacterId(name: string, sourceBook: string): string {
  return sha256Hex(`${name}|${sourceBook}`).slice(0, 12)
}
