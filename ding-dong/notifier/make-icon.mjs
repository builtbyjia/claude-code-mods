// Draws a pixel-art orange critter on a rounded cream tile and writes a 1024px PNG.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const SIZE = 1024
const CELL = 56
const RADIUS = 230

// X = body, e = eye, . = empty
const SPRITE = [
  '..XXXXXXXXXX..',
  '..XXXXXXXXXX..',
  'XXXXeXXXXeXXXX',
  'XXXXeXXXXeXXXX',
  '..XXXXXXXXXX..',
  '..XXXXXXXXXX..',
  '..X.X....X.X..',
  '..X.X....X.X..',
]

const BODY = [217, 119, 87, 255]
const EYE = [43, 33, 24, 255]
const TILE = [250, 245, 236, 255]
const CLEAR = [0, 0, 0, 0]

const spriteW = SPRITE[0].length * CELL
const spriteH = SPRITE.length * CELL
const left = Math.round((SIZE - spriteW) / 2)
const top = Math.round((SIZE - spriteH) / 2)

function insideTile(x, y) {
  const cx = Math.min(Math.max(x, RADIUS), SIZE - 1 - RADIUS)
  const cy = Math.min(Math.max(y, RADIUS), SIZE - 1 - RADIUS)
  return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2
}

function pixel(x, y) {
  if (!insideTile(x, y)) return CLEAR
  const col = Math.floor((x - left) / CELL)
  const row = Math.floor((y - top) / CELL)
  const cell = SPRITE[row]?.[col]
  if (x < left || y < top || cell === undefined || cell === '.') return TILE
  return cell === 'e' ? EYE : BODY
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1)
  raw[rowStart] = 0
  for (let x = 0; x < SIZE; x++) raw.set(pixel(x, y), rowStart + 1 + x * 4)
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const header = Buffer.alloc(13)
header.writeUInt32BE(SIZE, 0)
header.writeUInt32BE(SIZE, 4)
header.set([8, 6, 0, 0, 0], 8)

writeFileSync(
  process.argv[2],
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]),
)
