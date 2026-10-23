/**
 * Standards-oriented CSS color parsing → sRGB HEX for vBiz Me theme fields.
 * Deterministic — never ask the model to convert colors.
 */

export type ParsedCssColor = {
  hex: string
  alpha: number
  format: string
  original: string
}

const NAMED: Record<string, string> = {
  aliceblue: '#f0f8ff',
  antiquewhite: '#faebd7',
  aqua: '#00ffff',
  aquamarine: '#7fffd4',
  azure: '#f0ffff',
  beige: '#f5f5dc',
  bisque: '#ffe4c4',
  black: '#000000',
  blanchedalmond: '#ffebcd',
  blue: '#0000ff',
  blueviolet: '#8a2be2',
  brown: '#a52a2a',
  burlywood: '#deb887',
  cadetblue: '#5f9ea0',
  chartreuse: '#7fff00',
  chocolate: '#d2691e',
  coral: '#ff7f50',
  cornflowerblue: '#6495ed',
  cornsilk: '#fff8dc',
  crimson: '#dc143c',
  cyan: '#00ffff',
  darkblue: '#00008b',
  darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9',
  darkgreen: '#006400',
  darkgrey: '#a9a9a9',
  darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f',
  darkorange: '#ff8c00',
  darkorchid: '#9932cc',
  darkred: '#8b0000',
  darksalmon: '#e9967a',
  darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1',
  darkviolet: '#9400d3',
  deeppink: '#ff1493',
  deepskyblue: '#00bfff',
  dimgray: '#696969',
  dimgrey: '#696969',
  dodgerblue: '#1e90ff',
  firebrick: '#b22222',
  floralwhite: '#fffaf0',
  forestgreen: '#228b22',
  fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff',
  gold: '#ffd700',
  goldenrod: '#daa520',
  gray: '#808080',
  green: '#008000',
  greenyellow: '#adff2f',
  grey: '#808080',
  honeydew: '#f0fff0',
  hotpink: '#ff69b4',
  indianred: '#cd5c5c',
  indigo: '#4b0082',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd',
  lightblue: '#add8e6',
  lightcoral: '#f08080',
  lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3',
  lightgreen: '#90ee90',
  lightgrey: '#d3d3d3',
  lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa',
  lightslategray: '#778899',
  lightslategrey: '#778899',
  lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0',
  lime: '#00ff00',
  limegreen: '#32cd32',
  linen: '#faf0e6',
  magenta: '#ff00ff',
  maroon: '#800000',
  mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd',
  mediumorchid: '#ba55d3',
  mediumpurple: '#9370db',
  mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee',
  mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585',
  midnightblue: '#191970',
  mintcream: '#f5fffa',
  mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5',
  navajowhite: '#ffdead',
  navy: '#000080',
  oldlace: '#fdf5e6',
  olive: '#808000',
  olivedrab: '#6b8e23',
  orange: '#ffa500',
  orangered: '#ff4500',
  orchid: '#da70d6',
  palegoldenrod: '#eee8aa',
  palegreen: '#98fb98',
  paleturquoise: '#afeeee',
  palevioletred: '#db7093',
  papayawhip: '#ffefd5',
  peachpuff: '#ffdab9',
  peru: '#cd853f',
  pink: '#ffc0cb',
  plum: '#dda0dd',
  powderblue: '#b0e0e6',
  purple: '#800080',
  rebeccapurple: '#663399',
  red: '#ff0000',
  rosybrown: '#bc8f8f',
  royalblue: '#4169e1',
  saddlebrown: '#8b4513',
  salmon: '#fa8072',
  sandybrown: '#f4a460',
  seagreen: '#2e8b57',
  seashell: '#fff5ee',
  sienna: '#a0522d',
  silver: '#c0c0c0',
  skyblue: '#87ceeb',
  slateblue: '#6a5acd',
  slategray: '#708090',
  slategrey: '#708090',
  snow: '#fffafa',
  springgreen: '#00ff7f',
  steelblue: '#4682b4',
  tan: '#d2b48c',
  teal: '#008080',
  thistle: '#d8bfd8',
  tomato: '#ff6347',
  turquoise: '#40e0d0',
  violet: '#ee82ee',
  wheat: '#f5deb3',
  white: '#ffffff',
  whitesmoke: '#f5f5f5',
  yellow: '#ffff00',
  yellowgreen: '#9acd32',
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function clamp255(n: number): number {
  return Math.min(255, Math.max(0, Math.round(n)))
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => clamp255(c).toString(16).padStart(2, '0')).join('')}`
}

export function expandHex(hex: string): string | null {
  const raw = hex.trim()
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase()
  }
  if (/^#[0-9a-fA-F]{4}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase()
  }
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase()
  if (/^#[0-9a-fA-F]{8}$/.test(raw)) return `#${raw.slice(1, 7)}`.toLowerCase()
  return null
}

function parseAlpha(token: string | undefined, fallback = 1): number {
  if (token == null || token === '') return fallback
  const t = token.trim()
  if (t.endsWith('%')) return clamp01(Number.parseFloat(t) / 100)
  const n = Number.parseFloat(t)
  return Number.isFinite(n) ? clamp01(n) : fallback
}

function parseChannel(token: string, max = 255): number | null {
  const t = token.trim()
  if (!t) return null
  if (t.endsWith('%')) {
    const pct = Number.parseFloat(t)
    if (!Number.isFinite(pct)) return null
    return (pct / 100) * max
  }
  const n = Number.parseFloat(t)
  return Number.isFinite(n) ? n : null
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360
  const ss = clamp01(s)
  const ll = clamp01(l)
  const c = (1 - Math.abs(2 * ll - 1)) * ss
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = ll - c / 2
  const [rp, gp, bp] =
    hh < 60
      ? [c, x, 0]
      : hh < 120
        ? [x, c, 0]
        : hh < 180
          ? [0, c, x]
          : hh < 240
            ? [0, x, c]
            : hh < 300
              ? [x, 0, c]
              : [c, 0, x]
  return [(rp + m) * 255, (gp + m) * 255, (bp + m) * 255]
}

/** Approximate OKLCH → sRGB (enough for brand token capture). */
function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const hr = ((h % 360) + 360) % 360
  const a = c * Math.cos((hr * Math.PI) / 180)
  const b = c * Math.sin((hr * Math.PI) / 180)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b
  const l3 = l_ ** 3
  const m3 = m_ ** 3
  const s3 = s_ ** 3
  const r = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
  const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3
  const toSrgb = (v: number) => {
    const abs = Math.abs(v)
    const encoded = abs > 0.0031308 ? Math.sign(v) * (1.055 * abs ** (1 / 2.4) - 0.055) : 12.92 * v
    return clamp255(encoded * 255)
  }
  return [toSrgb(r), toSrgb(g), toSrgb(bl)]
}

function parseFunctionArgs(inner: string): string[] {
  // Split on commas or whitespace, keep slash-alpha as last token.
  const slash = inner.split(/\s*\/\s*/)
  const head = slash[0] || ''
  const alpha = slash[1]
  const parts = head.includes(',')
    ? head
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : head
        .split(/\s+/)
        .map((p) => p.trim())
        .filter(Boolean)
  if (alpha != null && alpha !== '') parts.push(alpha.trim())
  return parts
}

/**
 * Parse a single CSS color value to HEX (+ alpha). Returns null for transparent/currentColor/unresolved var.
 */
export function parseCssColor(value: string, vars?: Record<string, string>, depth = 0): ParsedCssColor | null {
  if (!value || depth > 6) return null
  const raw = value.trim().replace(/^['"]|['"]$/g, '')
  if (!raw || /^transparent$/i.test(raw) || /^currentcolor$/i.test(raw) || /^inherit$/i.test(raw)) {
    return null
  }

  // var(--token) or var(--token, fallback)
  const varMatch = raw.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\s*\)$/i)
  if (varMatch) {
    const name = varMatch[1].toLowerCase()
    const resolved = vars?.[name]
    if (resolved) return parseCssColor(resolved, vars, depth + 1)
    if (varMatch[2]) return parseCssColor(varMatch[2].trim(), vars, depth + 1)
    return null
  }

  const hexCandidate = raw.startsWith('#') ? raw : /^[0-9a-fA-F]{3,8}$/.test(raw) ? `#${raw}` : ''
  const hex = hexCandidate ? expandHex(hexCandidate) : null
  if (hex) {
    let alpha = 1
    if (/^#[0-9a-fA-F]{8}$/.test(hexCandidate) || /^#[0-9a-fA-F]{4}$/.test(hexCandidate)) {
      const digits = hexCandidate.slice(1)
      const aPart = digits.length === 8 ? digits.slice(6, 8) : `${digits[3]}${digits[3]}`
      alpha = Number.parseInt(aPart, 16) / 255
    }
    return { hex, alpha, format: 'hex', original: value.trim() }
  }

  const named = NAMED[raw.toLowerCase()]
  if (named) return { hex: named, alpha: 1, format: 'named', original: value.trim() }

  const fn = raw.match(/^([a-z-]+)\(\s*([\s\S]+)\s*\)$/i)
  if (!fn) return null
  const name = fn[1].toLowerCase()
  const args = parseFunctionArgs(fn[2])

  if (name === 'rgb' || name === 'rgba') {
    if (args.length < 3) return null
    const r = parseChannel(args[0])
    const g = parseChannel(args[1])
    const b = parseChannel(args[2])
    if (r == null || g == null || b == null) return null
    const alpha = parseAlpha(args[3], 1)
    return { hex: rgbToHex(r, g, b), alpha, format: name, original: value.trim() }
  }

  if (name === 'hsl' || name === 'hsla') {
    if (args.length < 3) return null
    const h = Number.parseFloat(args[0])
    const s = parseChannel(args[1], 1)
    const l = parseChannel(args[2], 1)
    if (!Number.isFinite(h) || s == null || l == null) return null
    const [r, g, b] = hslToRgb(h, s, l)
    const alpha = parseAlpha(args[3], 1)
    return { hex: rgbToHex(r, g, b), alpha, format: name, original: value.trim() }
  }

  if (name === 'hwb') {
    if (args.length < 3) return null
    const h = Number.parseFloat(args[0])
    const w = parseChannel(args[1], 1)
    const bl = parseChannel(args[2], 1)
    if (!Number.isFinite(h) || w == null || bl == null) return null
    const [r0, g0, b0] = hslToRgb(h, 1, 0.5)
    const ww = clamp01(w)
    const bb = clamp01(bl)
    const sum = ww + bb
    const scale = sum > 1 ? 1 / sum : 1
    const r = r0 * (1 - ww * scale - bb * scale) + 255 * ww * scale
    const g = g0 * (1 - ww * scale - bb * scale) + 255 * ww * scale
    const b = b0 * (1 - ww * scale - bb * scale) + 255 * ww * scale
    return {
      hex: rgbToHex(r, g, b),
      alpha: parseAlpha(args[3], 1),
      format: 'hwb',
      original: value.trim(),
    }
  }

  if (name === 'oklch') {
    if (args.length < 3) return null
    const l = parseChannel(args[0], 1)
    const c = Number.parseFloat(args[1])
    const h = Number.parseFloat(args[2])
    if (l == null || !Number.isFinite(c) || !Number.isFinite(h)) return null
    const [r, g, b] = oklchToRgb(l, c, h)
    return {
      hex: rgbToHex(r, g, b),
      alpha: parseAlpha(args[3], 1),
      format: 'oklch',
      original: value.trim(),
    }
  }

  // color-mix(in srgb, #abc 40%, #def) — resolve when both sides parse.
  if (name === 'color-mix') {
    const mix = fn[2].match(/in\s+[\w-]+\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+)$/i)
    if (!mix) return null
    const a = parseCssColor(mix[1].trim(), vars, depth + 1)
    const b = parseCssColor(mix[3].trim(), vars, depth + 1)
    if (!a || !b) return null
    const p = clamp01(Number.parseFloat(mix[2]) / 100)
    const ar = Number.parseInt(a.hex.slice(1, 3), 16)
    const ag = Number.parseInt(a.hex.slice(3, 5), 16)
    const ab = Number.parseInt(a.hex.slice(5, 7), 16)
    const br = Number.parseInt(b.hex.slice(1, 3), 16)
    const bg = Number.parseInt(b.hex.slice(3, 5), 16)
    const bb = Number.parseInt(b.hex.slice(5, 7), 16)
    return {
      hex: rgbToHex(ar * p + br * (1 - p), ag * p + bg * (1 - p), ab * p + bb * (1 - p)),
      alpha: a.alpha * p + b.alpha * (1 - p),
      format: 'color-mix',
      original: value.trim(),
    }
  }

  return null
}

export function relativeLuminance(hex: string): number {
  const raw = expandHex(hex)
  if (!raw) return 0
  const n = (i: number) => Number.parseInt(raw.slice(i, i + 2), 16) / 255
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(n(1)) + 0.7152 * lin(n(3)) + 0.0722 * lin(n(5))
}

export function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a)
  const l2 = relativeLuminance(b)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const full = expandHex(hex)
  if (!full) return null
  const r = Number.parseInt(full.slice(1, 3), 16) / 255
  const g = Number.parseInt(full.slice(3, 5), 16) / 255
  const b = Number.parseInt(full.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6
  return { h: h * 360, s, l }
}

export function hslToHex(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l)
  return rgbToHex(r, g, b)
}

export function isNearNeutral(hex: string, chromaThreshold = 0.08): boolean {
  const hsl = hexToHsl(hex)
  if (!hsl) return true
  if (hsl.l < 0.08 || hsl.l > 0.94) return true
  return hsl.s < chromaThreshold
}

export function adjustLightness(hex: string, targetL: number): string {
  const hsl = hexToHsl(hex)
  if (!hsl) return hex
  return hslToHex(hsl.h, hsl.s, clamp01(targetL))
}

/** Shift lightness until contrast vs background meets ratio (bounded). */
export function ensureContrast(fg: string, bg: string, minRatio: number, preferDarker = true): string {
  if (contrastRatio(fg, bg) >= minRatio) return fg
  const hsl = hexToHsl(fg)
  if (!hsl) return fg
  let best = fg
  let bestRatio = contrastRatio(fg, bg)
  for (let step = 0; step <= 40; step += 1) {
    const delta = step * 0.02
    const candidates = [hslToHex(hsl.h, hsl.s, clamp01(hsl.l - delta)), hslToHex(hsl.h, hsl.s, clamp01(hsl.l + delta))]
    for (const c of candidates) {
      const ratio = contrastRatio(c, bg)
      if (ratio > bestRatio) {
        bestRatio = ratio
        best = c
      }
      if (ratio >= minRatio) {
        const darkerOk = preferDarker && relativeLuminance(c) <= relativeLuminance(fg) + 0.02
        const lighterOk = !preferDarker && relativeLuminance(c) >= relativeLuminance(fg) - 0.02
        if (darkerOk || lighterOk || step > 8) return c
      }
    }
  }
  return best
}
