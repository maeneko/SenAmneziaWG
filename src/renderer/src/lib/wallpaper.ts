/** The wallpaper's own arithmetic, out of the component: storage, the picture's seed hues
 *  (Monet-mini), the accents' dark/light mapping, the surfaces' translucency and the
 *  readability auto-dim. Ported line for line from the lab prototype (fsn-wall.js). */

export interface WallpaperState {
  /** The picture, a data URL (imported downscaled to 1600px, plain JPEG). */
  img: string | null
  blur: number
  dim: number
  /** The surfaces' alpha over the picture — the user's surface-opacity setting. */
  fade: number
}

export const WALLPAPER_KEY = 'awg:wallpaper'
const LEGACY_KEY = 'awgLab:wallpaper'

export const WALLPAPER_DEFAULTS: WallpaperState = { img: null, blur: 24, dim: 0.5, fade: 0.78 }

export function readWallpaper(): WallpaperState {
  try {
    let raw = localStorage.getItem(WALLPAPER_KEY)
    if (raw === null) {
      // The lab prototype's own store migrates: one move, and the old key is gone.
      raw = localStorage.getItem(LEGACY_KEY)
      if (raw !== null) {
        localStorage.setItem(WALLPAPER_KEY, raw)
        localStorage.removeItem(LEGACY_KEY)
      }
    }
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return { ...WALLPAPER_DEFAULTS }
    const o = parsed as Record<string, unknown>
    return {
      img: typeof o.img === 'string' ? o.img : null,
      blur: typeof o.blur === 'number' ? Math.min(60, Math.max(0, o.blur)) : 24,
      dim: typeof o.dim === 'number' ? Math.min(1, Math.max(0, o.dim)) : 0.5,
      fade: typeof o.fade === 'number' ? Math.min(1, Math.max(0.2, o.fade)) : 0.78
    }
  } catch {
    return { ...WALLPAPER_DEFAULTS }
  }
}

export function writeWallpaper(s: WallpaperState): void {
  try {
    localStorage.setItem(WALLPAPER_KEY, JSON.stringify(s))
  } catch {
    /* per-viewer convenience only */
  }
}

/* ── The shared store: the layer's component and the settings screen read the same state —
   a plain pub-sub over the module's own copy, no prop drilling through the app shell. ── */
let wall: WallpaperState = readWallpaper()
let wallListeners: Array<() => void> = []

export function getWallpaper(): WallpaperState {
  return wall
}

/** Merges the patch, persists it and wakes every reader (the layer and the settings screen). */
export function setWallpaper(patch: Partial<WallpaperState>): void {
  wall = {
    img: patch.img !== undefined ? patch.img : wall.img,
    blur: patch.blur !== undefined ? Math.min(60, Math.max(0, patch.blur)) : wall.blur,
    dim: patch.dim !== undefined ? Math.min(1, Math.max(0, patch.dim)) : wall.dim,
    fade: patch.fade !== undefined ? Math.min(1, Math.max(0.2, patch.fade)) : wall.fade
  }
  writeWallpaper(wall)
  for (const cb of wallListeners) cb()
}

export function subscribeWallpaper(cb: () => void): () => void {
  wallListeners.push(cb)
  return () => {
    wallListeners = wallListeners.filter((l) => l !== cb)
  }
}

/** A file from the settings' picker or the window's drop/paste: load, downscale, hand out the URL.
 *  The read goes through a data URL — the app's CSP allows `img-src 'self' data:` only, a blob
 *  URL would never decode. */
export async function importWallpaperFile(file: File): Promise<string> {
  const src = await new Promise<string>((ok, no) => {
    const fr = new FileReader()
    fr.onload = () => ok(String(fr.result))
    fr.onerror = () => no(fr.error ?? new Error('read failed'))
    fr.readAsDataURL(file)
  })
  return importImage(await loadSrc(src))
}

/** The surfaces that gain alpha over the picture, and the accents that follow the seeds. */
export const SURFACES = ['--surface', '--surface-container', '--surface-container-high', '--surface-bright',
  '--primary-container', '--secondary-container', '--tertiary-container']
export const ACCENTS = ['--primary', '--on-primary', '--primary-container', '--on-primary-container',
  '--secondary-container', '--on-secondary-container', '--tertiary-container', '--on-tertiary-container',
  '--accent-icon']

export interface Seed {
  h: number
  s: number
}

export interface Palette {
  seeds: Seed[] | null
  /** The picture's mean luma, 0–1. */
  lum: number
}

/* ── Monet-mini: Chumpy's WallpaperPalette.kt, line for line ── */
export function palette(src: string): Promise<Palette | null> {
  return new Promise<Palette | null>((resolve) => {
    const img = new Image()
    img.onload = () => {
      const DIM = 192
      const k = Math.min(1, DIM / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.max(1, (img.width * k) | 0)
      c.height = Math.max(1, (img.height * k) | 0)
      const ctx = c.getContext('2d', { willReadFrequently: true })
      if (!ctx) return resolve(null)
      ctx.drawImage(img, 0, 0, c.width, c.height)
      let data: Uint8ClampedArray
      try {
        data = ctx.getImageData(0, 0, c.width, c.height).data
      } catch {
        return resolve(null)
      }
      const rgb = (px: number): number => px / 255
      const bins = new Float32Array(12) // the vote is the saturation itself
      const vN = new Float32Array(12) // voters per bin — the family's average saturation
      const vS = new Float32Array(12)
      let lumSum = 0
      let lumN = 0
      for (let i = 0; i < data.length; i += 4) {
        const r = rgb(data[i])
        const g = rgb(data[i + 1])
        const b = rgb(data[i + 2])
        const mx = Math.max(r, g, b)
        const mn = Math.min(r, g, b)
        const d = mx - mn
        const l = (mx + mn) / 2
        lumSum += 0.2126 * r + 0.7152 * g + 0.0722 * b
        lumN++
        const s = d <= 0 ? 0 : d / (1 - Math.abs(2 * l - 1) || 1)
        if (s < 0.15 || l < 0.15 || l > 0.85) continue // grays and near-black/white stay out
        const h = !d ? 0 : mx === r ? (((g - b) / d) % 6 + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
        const hue = (h * 60 + 360) % 360
        const bin = Math.min(11, (hue / 30) | 0)
        bins[bin] += s
        vS[bin] += s
        vN[bin]++
      }
      const seedsOut: Seed[] = []
      const w = [...bins]
      for (let k = 0; k < 3; k++) {
        let best = -1
        for (let i = 0; i < 12; i++) if (best < 0 || w[i] > w[best]) best = i
        if (best < 0 || w[best] <= 0) break
        const sat = vN[best] ? vS[best] / vN[best] : 0.6
        seedsOut.push({ h: best * 30 + 15, s: Math.min(0.85, Math.max(0.62, sat)) })
        w[(best + 11) % 12] = w[(best + 1) % 12] = w[best] = 0 // the picked bin's neighbors are silenced
      }
      resolve({ seeds: seedsOut.length ? seedsOut : null, lum: lumN ? lumSum / lumN : 0.5 })
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/** Dark/light mapping follows the *current* scheme, read off the real surface. */
export function isDark(doc: Document): boolean {
  const probe = doc.createElement('span')
  probe.style.cssText = 'color:var(--surface);position:absolute;visibility:hidden'
  doc.body.appendChild(probe)
  const m = getComputedStyle(probe).color.match(/[\d.]+/g)
  probe.remove()
  const [r = 0, g = 0, b = 0] = m ? m.map(Number) : []
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}

/** The accent tokens from the seeds, mapped for the current scheme. */
export function accentTokens(seeds: Seed[], dark: boolean): Record<string, string> {
  const [s1, s2 = seeds[0], s3 = seeds[0]] = seeds
  const col = (o: Seed, l: string, sa?: number): string => `hsl(${o.h.toFixed(0)} ${(sa ?? o.s).toFixed(2)} ${l})`
  return {
    '--primary': col(s1, dark ? '72%' : '40%'),
    '--on-primary': dark ? '#241703' : '#ffffff',
    '--accent-icon': col(s1, dark ? '76%' : '42%'),
    '--primary-container': col(s1, dark ? '27%' : '90%'),
    '--on-primary-container': col(s1, dark ? '88%' : '14%'),
    '--secondary-container': col(s2, dark ? '20%' : '92%'),
    '--on-secondary-container': col(s2, dark ? '88%' : '14%', s2.s * 0.8),
    '--tertiary-container': col(s3, dark ? '24%' : '90%'),
    '--on-tertiary-container': col(s3, dark ? '86%' : '14%')
  }
}

/** Resolved colors of the surface tokens, through one probe element — never var-of-var
 *  (a cycled redefinition is invalid CSS). Reads the stylesheet's own color, so callers
 *  must lift their inline overrides first or the fade compounds on every pass. */
export function surfaceColors(): Array<{ token: string, r: number, g: number, b: number, a: number }> {
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
  document.body.appendChild(probe)
  const out: Array<{ token: string, r: number, g: number, b: number, a: number }> = []
  for (const t of SURFACES) {
    probe.style.background = `var(${t})`
    const m = getComputedStyle(probe).background.match(/rgba?\([^)]+\)|color\(srgb [^)]+\)/)
    if (!m) continue
    const n = (m[0].match(/[\d.]+/g) ?? []).map(Number)
    let [r, g, b, a] = [0, 0, 0, 1]
    if (m[0].startsWith('color(')) {
      ;[r, g, b] = n.map((v) => Math.round(v * 255))
      a = n[3]
    } else {
      ;[r, g, b, a = 1] = n
    }
    out.push({ token: t, r, g, b, a })
  }
  probe.remove()
  return out
}

/** The scrim's own luma — the dim is driven by the theme's surface tone (their scrimColor). */
export function scrimLuma(): number {
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
  document.body.appendChild(probe)
  probe.style.background = 'var(--scrim)'
  const sc = getComputedStyle(probe).background.match(/[\d.]+/g)
  probe.remove()
  if (!sc) return 0
  return (0.2126 * Number(sc[0]) + 0.7152 * Number(sc[1]) + 0.0722 * Number(sc[2])) / 255
}

/** Chumpy's readability guard, mirrored: with the composed dim the backdrop must sit dark
 *  enough for the light text — on bright wallpapers (sky, snow) the user dim alone won't get
 *  there, so the needed extra scrim is computed and the higher of the two applies.
 *  Target ≈0.28 luma — the white text's 3.5:1 zone (M3's scrim aim).
 *  (1-d)·Lwall + d·Lscrim = 0.28  →  d = (Lwall − 0.28) / (Lwall − Lscrim). */
export function autoDim(lum: number): number {
  const READ = 0.28
  if (lum <= READ) return 0
  const lr = scrimLuma()
  return Math.min(0.9, Math.max(0, (lum - READ) / Math.max(0.05, lum - lr)))
}

/** Import: downscale hard (the store's budget), plain JPEG. */
export function importImage(img: HTMLImageElement): string {
  const MAX = 1600
  const k = Math.min(1, MAX / Math.max(img.width, img.height))
  const c = document.createElement('canvas')
  c.width = (img.width * k) | 0
  c.height = (img.height * k) | 0
  c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.85)
}

export function loadSrc(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, no) => {
    const i = new Image()
    i.onload = () => ok(i)
    i.onerror = no
    i.src = src
  })
}

/** Built-in demo wallpapers — saturated gradient fields for the histogram to bite on. */
const DEMOS = [
  ['#0b3a4a', '#12676b', '#17a398', '#b3d67e'],
  ['#3d0a5e', '#7a1e8f', '#d34fd4', '#ffb2d8'],
  ['#4a1d05', '#a34a0f', '#e88b2d', '#ffd870']
]

export function demoImage(i = 0): string {
  const fam = DEMOS[i % DEMOS.length]
  const c = document.createElement('canvas')
  c.width = 1280
  c.height = 1920
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 1280, 1920)
  fam.forEach((col, n) => g.addColorStop(n / (fam.length - 1), col))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 1280, 1920)
  for (let n = 0; n < 140; n++) {
    // color blobs for a histogram with an appetite
    ctx.globalAlpha = 0.1 + Math.random() * 0.14
    ctx.fillStyle = fam[(Math.random() * fam.length) | 0]
    const r = 80 + Math.random() * 380
    ctx.beginPath()
    ctx.arc(Math.random() * 1280, Math.random() * 1920, r, 0, 7)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  return c.toDataURL('image/jpeg', 0.85)
}
