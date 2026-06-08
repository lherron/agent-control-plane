import { randomBytes } from 'node:crypto'

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ENCODING_SIZE = ENCODING.length
const ENCODING_SIZE_BIG = BigInt(ENCODING_SIZE)
const ENCODING_MASK_BIG = ENCODING_SIZE_BIG - 1n
const BITS_PER_ENCODED_CHAR_BIG = 5n
const TIME_CHARS = 10
const RANDOM_CHARS = 16
const RANDOM_BYTES = 10

function encodeTime(timestamp: number): string {
  let current = timestamp
  let output = ''

  for (let index = 0; index < TIME_CHARS; index += 1) {
    output = ENCODING[current % ENCODING_SIZE] + output
    current = Math.floor(current / ENCODING_SIZE)
  }

  return output
}

function encodeRandom(bytes: Uint8Array): string {
  let value = 0n

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte)
  }

  let output = ''
  for (let index = 0; index < RANDOM_CHARS; index += 1) {
    output = ENCODING[Number(value & ENCODING_MASK_BIG)] + output
    value >>= BITS_PER_ENCODED_CHAR_BIG
  }

  return output
}

export function newUlid(timestamp = Date.now()): string {
  return `${encodeTime(timestamp)}${encodeRandom(randomBytes(RANDOM_BYTES))}`
}
