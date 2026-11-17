import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { ThemeMode } from '@shared/uiSettings'
import {
  ACCENTS, SURFACES, WALLPAPER_BASE_ZOOM, accentTokens, backdropTooDark, demoImage, importWallpaperFile,
  isDark, palette, setWallpaper, subscribeWallpaper, getWallpaper, surfaceColors, type Seed
} from '../lib/wallpaper'

/** The system scheme, live: «system» reads the media query, and a flip of the OS theme wakes
 *  the layer even though the `theme` prop itself does not change. */
const DARK_QUERY = '(prefers-color-scheme: dark)'
const subscribeScheme = (cb: () => void): (() => void) => {
  const mq = window.matchMedia(DARK_QUERY)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const systemDark = (): boolean => window.matchMedia(DARK_QUERY).matches

/**
 * The wallpaper layer: one picture behind the app, blur + dim scrim over it, three seed hues
 * sampled from the picture's saturated pixels (Monet-mini) and the app's own tokens faded toward
 * translucency over the picture (surfaces keep their colors but gain alpha). Ported from the
 * wallpaper stack, out of the lab's prototype.
 *
 * The stage is the app's negative backdrop: rendered first inside `.app`, it lies under all the
 * content (the app isolates itself while a picture is on), and the surfaces' alpha is what lets
 * the picture breathe through. A picture is picked in «Настройки → Интерфейс» or handed to the
 * window by drag & drop or paste. `theme` and the live system scheme retrigger the accents'
 * dark/light mapping — the scheme itself is read off the live surface, so «system» follows it.
 * `connected` feeds the offline drain: the picture alone goes grayscale while the tunnel is
 * not up. Bare text on the header follows the dimmed picture's own light (their backdropTooDark).
 */
export function Wallpaper({ theme, connected }: { theme: ThemeMode; connected: boolean }): React.JSX.Element | null {
  // The shared store: the settings screen writes the same state this layer reads.
  const saved = useSyncExternalStore(subscribeWallpaper, getWallpaper)
  const darkScheme = useSyncExternalStore(subscribeScheme, systemDark)
  const seeds = useRef<Seed[] | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const on = saved.img !== null

  /* ── The picture's changes repaint the whole layer ── */
  useEffect(() => {
    const root = document.documentElement
    const rs = root.style
    root.classList.toggle('fsw-on', on)
    const bare = (): void => {
      root.classList.remove('fsw-bare-dark', 'fsw-bare-light')
    }
    if (!on) {
      // Off: the tokens return to the stylesheet, the accents yield with them.
      seeds.current = null
      bare()
      for (const t of [...SURFACES, ...SURFACES.map((x) => `${x}-solid`), ...ACCENTS]) rs.removeProperty(t)
      return
    }
    let dead = false
    const run = async (): Promise<void> => {
      const img = saved.img!
      // The inline overrides lift first: the probe must read the stylesheet's own color, or the
      // fade compounds on every re-render (0.78 → 0.78·0.55 → …).
      for (const t of SURFACES) rs.removeProperty(t)
      for (const { token, r, g, b, a } of surfaceColors()) {
        rs.setProperty(token, `rgb(${r} ${g} ${b} / ${(a * saved.fade).toFixed(3)})`)
        // The opaque twin: controls that must read over the picture at rest (the routing chip)
        // stand on it, and yield the translucency back on hover.
        rs.setProperty(`${token}-solid`, `rgb(${r} ${g} ${b})`)
      }
      const res = await palette(img)
      if (dead) return
      seeds.current = res?.seeds ?? null
      const dark = isDark(document)
      if (!res?.seeds) {
        for (const t of ACCENTS) rs.removeProperty(t)
      } else {
        for (const [t, v] of Object.entries(accentTokens(res.seeds, dark))) rs.setProperty(t, v)
      }
      // Bare text: the picture and the scrim composed at the setting's alpha decide which
      // scheme the header wears — never the app theme alone.
      const tooDark = backdropTooDark(res?.lum ?? 0.5, saved.dim, saved.tone)
      root.classList.toggle('fsw-bare-dark', tooDark)
      root.classList.toggle('fsw-bare-light', !tooDark)
    }
    void run()
    return () => {
      dead = true
    }
    // theme rides along as the trigger: «system»'s scheme change re-walks the whole surface,
    // and darkScheme catches the OS flip while the prop stays «system».
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.img, saved.dim, saved.fade, saved.tone, theme, darkScheme])

  const pick = useCallback(async (file?: File | null): Promise<void> => {
    const f = file ?? input.current?.files?.[0] ?? null
    if (!f) {
      input.current?.click()
      return
    }
    try {
      setWallpaper({ img: await importWallpaperFile(f), scale: 1, offsetX: 0, offsetY: 0 })
    } catch (e) {
      console.warn('wallpaper: import failed', e)
    }
  }, [])

  /* The window itself takes the photo: drag & drop, or paste (Ctrl+V) — no dialog at all. */
  useEffect(() => {
    const stopover = (e: DragEvent): void => {
      e.preventDefault()
    }
    const onDrop = (e: DragEvent): void => {
      stopover(e)
      const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'))
      if (f) void pick(f)
    }
    const onPaste = (e: ClipboardEvent): void => {
      const it = [...(e.clipboardData?.items ?? [])].find((x) => x.type.startsWith('image/'))
      const f = it?.getAsFile()
      if (f) void pick(f)
    }
    document.addEventListener('dragover', stopover)
    document.addEventListener('drop', onDrop)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('dragover', stopover)
      document.removeEventListener('drop', onDrop)
      document.removeEventListener('paste', onPaste)
    }
  }, [pick])

  /* The console's handrail, dev only: demo()/drop()/blur(n)/dim(n)/fade(n)/tone(t)/gray(on)/place(…)/pick(). */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const api = {
      pick: (f?: File): Promise<void> => pick(f),
      drop: (): void => setWallpaper({ img: null, scale: 1, offsetX: 0, offsetY: 0 }),
      demo: (i = 0): void => setWallpaper({ img: demoImage(i), scale: 1, offsetX: 0, offsetY: 0 }),
      blur: (n: number): void => setWallpaper({ blur: n }),
      dim: (n: number): void => setWallpaper({ dim: n }),
      fade: (n: number): void => setWallpaper({ fade: n }),
      tone: (t: 'auto' | 'light' | 'dark'): void => setWallpaper({ tone: t }),
      gray: (on: boolean): void => setWallpaper({ grayOffline: on }),
      place: (scale: number, offsetX: number, offsetY: number): void =>
        setWallpaper({ scale, offsetX, offsetY })
    }
    ;(window as unknown as Record<string, unknown>).__fsw = api
    return () => {
      delete (window as unknown as Record<string, unknown>).__fsw
    }
  }, [pick])

  if (!on) return null
  // The picture's framing: the blur's own overscan, the user's scale, and the pan inside the
  // slack the two leave. The offline drain rides the picture alone — never the interface.
  const zoom = WALLPAPER_BASE_ZOOM * saved.scale
  const slack = (zoom - 1) * 50
  const gray = saved.grayOffline && !connected ? 1 : 0
  return (
    <>
      <div className={`fsw-stage fsw-tone-${saved.tone}`} aria-hidden="true">
        <div
          className="fsw-img"
          style={{
            '--fsw-src': `url("${saved.img}")`,
            '--fsw-blur': `${saved.blur}px`,
            '--fsw-zoom': zoom.toFixed(4),
            '--fsw-tx': `${(saved.offsetX * slack).toFixed(3)}%`,
            '--fsw-ty': `${(saved.offsetY * slack).toFixed(3)}%`,
            '--fsw-gray': gray
          } as React.CSSProperties}
        />
        {/* The dim scrim — the scheme's own opaque surface (or the pinned tone's), its alpha
            driven by the setting, exactly as the scrim color and alpha. */}
        <div className="fsw-scrim" style={{ opacity: saved.dim }} />
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={() => {
          void pick(input.current?.files?.[0])
          if (input.current) input.current.value = ''
        }}
      />
    </>
  )
}
