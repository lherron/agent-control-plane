import { randomBytes } from 'node:crypto'

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeTime(timestamp: number): string {
  let current = timestamp
  let output = ''

  for (let index = 0; index < 10; index += 1) {
    output = ENCODING[current % 32] + output
    current = Math.floor(current / 32)
  }

  return output
}

function encodeRandom(bytes: Uint8Array): string {
  let value = 0n

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte)
  }

  let output = ''
  for (let index = 0; index < 16; index += 1) {
    output = ENCODING[Number(value & 31n)] + output
    value >>= 5n
  }

  return output
}

export function newUlid(timestamp = Date.now()): string {
  return `${encodeTime(timestamp)}${encodeRandom(randomBytes(10))}`
}
