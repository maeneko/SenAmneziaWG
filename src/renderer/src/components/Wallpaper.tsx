import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ThemeMode } from '@shared/uiSettings'
import {
  ACCENTS, SURFACES, accentTokens, autoDim, demoImage, importWallpaperFile, isDark,
  palette, setWallpaper, subscribeWallpaper, getWallpaper, surfaceColors, type Seed
} from '../lib/wallpaper'

/**
 * The wallpaper layer: one picture behind the app, blur + dim scrim over it, three seed hues
 * sampled from the picture's saturated pixels (Monet-mini) and the app's own tokens faded toward
 * translucency over the picture (surfaces keep their colors but gain alpha). Ported from Chumpy's
 * wallpaper stack, out of the lab's prototype.
 *
 * The stage is the app's negative backdrop: rendered first inside `.app`, it lies under all the
 * content (the app isolates itself while a picture is on), and the surfaces' alpha is what lets
 * the picture breathe through. A picture is picked in «Настройки → Интерфейс» or handed to the
 * window by drag & drop or paste. `theme` only retriggers the accents' dark/light mapping — the
 * scheme itself is read off the live surface, so «system» follows it.
 */
export function Wallpaper({ theme }: { theme: ThemeMode }): React.JSX.Element | null {
  // The shared store: the settings screen writes the same state this layer reads.
  const saved = useSyncExternalStore(subscribeWallpaper, getWallpaper)
  // The composed dim: the user's setting, lifted where a bright picture needs more.
  const [dim, setDim] = useState(saved.dim)
  const seeds = useRef<Seed[] | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const on = saved.img !== null

  /* ── The picture's changes repaint the whole layer ── */
  useEffect(() => {
    const rs = document.documentElement.style
    document.documentElement.classList.toggle('fsw-on', on)
    if (!on) {
      // Off: the tokens return to the stylesheet, the accents yield with them.
      seeds.current = null
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
      setDim(Math.max(saved.dim, res ? autoDim(res.lum) : 0))
      const dark = isDark(document)
      if (!res?.seeds) {
        for (const t of ACCENTS) rs.removeProperty(t)
      } else {
        for (const [t, v] of Object.entries(accentTokens(res.seeds, dark))) rs.setProperty(t, v)
      }
    }
    void run()
    return () => {
      dead = true
    }
    // theme rides along as the trigger: «system»'s scheme change re-walks the whole surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.img, saved.dim, saved.fade, theme])

  const pick = useCallback(async (file?: File | null): Promise<void> => {
    const f = file ?? input.current?.files?.[0] ?? null
    if (!f) {
      input.current?.click()
      return
    }
    try {
      setWallpaper({ img: await importWallpaperFile(f) })
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

  /* The console's handrail, dev only: demo()/drop()/blur(n)/dim(n)/fade(n)/pick(). */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const api = {
      pick: (f?: File): Promise<void> => pick(f),
      drop: (): void => setWallpaper({ img: null }),
      demo: (i = 0): void => setWallpaper({ img: demoImage(i) }),
      blur: (n: number): void => setWallpaper({ blur: n }),
      dim: (n: number): void => setWallpaper({ dim: n }),
      fade: (n: number): void => setWallpaper({ fade: n })
    }
    ;(window as unknown as Record<string, unknown>).__fsw = api
    return () => {
      delete (window as unknown as Record<string, unknown>).__fsw
    }
  }, [pick])

  if (!on) return null
  return (
    <>
      <div className="fsw-stage" aria-hidden="true">
        <div
          className="fsw-img"
          style={{ '--fsw-src': `url("${saved.img}")`, '--fsw-blur': `${saved.blur}px` } as React.CSSProperties}
        />
        {/* The dim scrim — the theme's own surface tone, alpha driven by the setting. */}
        <div className="fsw-scrim" style={{ opacity: dim }} />
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
