import { deflateSync } from 'zlib'

function crc32(buf: Buffer): number {
  let crc = ~0
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i]
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return ~crc >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crcInput = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

function encodeRgbaPng(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number]
): Buffer {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * stride
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y)
      const i = row + 1 + x * 4
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
      raw[i + 3] = 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

export function createSolidPng(width: number, height = width, rgb: [number, number, number] = [11, 31, 58]): Buffer {
  return encodeRgbaPng(width, height, () => rgb)
}

/** Navy metal-card strip used when live wallet-art cannot be fetched. */
export function createUsaCardStripPng(width = 750, height = 246): Buffer {
  const gold: [number, number, number] = [201, 162, 74]
  const cream: [number, number, number] = [244, 228, 193]
  const navy: [number, number, number] = [11, 31, 58]
  const deep: [number, number, number] = [5, 11, 22]
  const chipX0 = Math.round(width * 0.08)
  const chipY0 = Math.round(height * 0.38)
  const chipX1 = chipX0 + Math.round(width * 0.09)
  const chipY1 = chipY0 + Math.round(height * 0.28)
  const bar = Math.max(6, Math.round(height * 0.045))

  return encodeRgbaPng(width, height, (x, y) => {
    if (y < bar) return y % 2 === 0 ? gold : cream
    if (x >= chipX0 && x <= chipX1 && y >= chipY0 && y <= chipY1) {
      const edge = x === chipX0 || x === chipX1 || y === chipY0 || y === chipY1
      return edge ? cream : gold
    }
    const t = x / Math.max(width - 1, 1)
    return [
      Math.round(deep[0] + (navy[0] - deep[0]) * t),
      Math.round(deep[1] + (navy[1] - deep[1]) * t),
      Math.round(deep[2] + (navy[2] - deep[2]) * t),
    ]
  })
}
