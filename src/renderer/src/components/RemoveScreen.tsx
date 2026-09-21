import { useCallback, useEffect, useRef, useState } from 'react'
import type { SetupFailure, SetupProgress, UninstallResult } from '@shared/types'
import { Button, Logo } from './ui'

/** 2πr for r = 59: the ring's full length. */
const RING = 370.71
const FLIGHT_MS = 620

type StepState = 'pending' | 'active' | 'done' | 'failed'
type Phase = 'waiting' | 'working' | 'failed' | 'done' | 'final' | 'leaving'

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The logo between the header and the ring. It always has the ring logo's size and only ever scales
 * down, so it is never an upscaled bitmap; `back` flies it from the ring to the header.
 */
function fly(header: Element, mark: Element, back: boolean, done: () => void): () => void {
  const a = header.getBoundingClientRect()
  const b = mark.getBoundingClientRect()
  const flyer = document.createElement('img')
  flyer.src = (mark as HTMLImageElement).src
  flyer.className = 'remove-flyer'
  Object.assign(flyer.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` })
  document.body.appendChild(flyer)
  const s = a.width / b.width
  const atHeader = { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${s})`, borderRadius: `${9 / s}px` }
  const atMark = { transform: 'none', borderRadius: '21px' }
  const anim = flyer.animate(back ? [atMark, atHeader] : [atHeader, atMark], {
    duration: reducedMotion() ? 1 : FLIGHT_MS,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    fill: 'both'
  })
  anim.onfinish = () => {
    done()
    // One frame more: whatever takes over from the flyer is drawn by React on the next one.
    requestAnimationFrame(() => requestAnimationFrame(() => flyer.remove()))
  }
  return () => {
    anim.cancel()
    flyer.remove()
  }
}

/**
 * «Удалить SenAWG», on screen from the confirmation to the end: the setup screen run backwards. The
 * logo flies from the header into a full ring (everything installed); the ring unwinds a third per step,
 * the steps being the setup's own in reverse order; at the end the ring is gone and the logo loses its
 * colour. A failure stops the ring where it stopped and offers the way back into the application, which
 * is still there. Declining the administrator prompt goes straight back.
 */
export function RemoveScreen({ keepData, onReturn, onClosed }: {
  keepData: boolean
  /** The way back has started: the application may come up again under the flying logo. */
  onReturn: () => void
  /** The screen is gone; `error` is what the application should keep saying, if anything. */
  onClosed: (error: string | null) => void
}): React.JSX.Element {
  const markLogo = useRef<HTMLDivElement>(null)
  const arc = useRef<SVGCircleElement>(null)
  const [landed, setLanded] = useState(false)
  const [phase, setPhase] = useState<Phase>('waiting')
  const [steps, setSteps] = useState<StepState[]>(['pending', 'pending', 'pending'])
  const [ring, setRing] = useState({ offset: RING, ms: 0, ease: 'linear' })
  const [sub, setSub] = useState({ n: 0, text: 'Windows спрашивает права администратора', prev: '' })
  const [error, setError] = useState<string | null>(null)
  const errorRef = useRef<string | null>(null)
  const finish = useRef<HTMLButtonElement>(null)
  const back = useRef<HTMLButtonElement>(null)

  const say = useCallback((text: string) => setSub((s) => (s.text === text ? s : { n: s.n + 1, text, prev: s.text })), [])

  const leave = useCallback(() => {
    setPhase('leaving')
    onReturn()
    const header = document.querySelector('.page-header .logo')
    const mark = markLogo.current?.querySelector('img')
    const close = (): void => onClosed(errorRef.current)
    if (!header || !mark) return close()
    setLanded(false)
    fly(header, mark, true, close)
  }, [onClosed, onReturn])

  // Arrival: the logo leaves the header for the ring, and the ring fills — everything that is installed.
  useEffect(() => {
    const header = document.querySelector('.page-header .logo') as HTMLElement | null
    const mark = markLogo.current?.querySelector('img')
    let cancel = (): void => {}
    if (header && mark) {
      header.style.visibility = 'hidden'
      cancel = fly(header, mark, false, () => setLanded(true))
    } else {
      setLanded(true)
    }
    const t = setTimeout(() => setRing({ offset: 0, ms: 560, ease: 'cubic-bezier(0.2, 0, 0, 1)' }), 200)
    return () => {
      clearTimeout(t)
      cancel()
      if (header) header.style.visibility = ''
    }
  }, [])

  // The removal itself. It starts once, when the screen is up; its events drive everything below.
  useEffect(() => {
    let alive = true
    const offProgress = window.awg.onUninstallProgress(({ step, state }: SetupProgress) => {
      if (!alive) return
      setPhase('working')
      say('Удаление')
      setSteps((prev) => prev.map((s, i) => (i === step ? state : i < step ? 'done' : s)))
      setRing(
        state === 'active'
          ? { offset: (RING * (step + 0.55)) / 3, ms: 900, ease: 'linear' }
          : { offset: (RING * (step + 1)) / 3, ms: 260, ease: 'cubic-bezier(0.2, 0, 0, 1)' }
      )
    })
    const offFailed = window.awg.onUninstallFailed(({ step, message }: SetupFailure) => {
      if (!alive) return
      errorRef.current = message
      setError(message)
      setSteps((prev) => prev.map((s, i) => (i === step ? 'failed' : s)))
      // The ring stops where it stopped: how far it got is part of the answer.
      const now = arc.current ? parseFloat(getComputedStyle(arc.current).strokeDashoffset) : NaN
      setRing((r) => ({ offset: Number.isFinite(now) ? now : r.offset, ms: 0, ease: 'linear' }))
    })
    const started = setTimeout(() => {
      void window.awg.uninstall(keepData).then(
        (result: UninstallResult) => {
          if (!alive) return
          if (result === 'cancelled') return leave()
          if (result === 'failed') {
            setPhase('failed')
            say('Удаление не удалось')
            return
          }
          setPhase('done')
          say('Готово')
          setRing({ offset: RING, ms: 260, ease: 'cubic-bezier(0.2, 0, 0, 1)' })
          setTimeout(() => alive && setPhase('final'), 700)
        },
        (err: unknown) => {
          if (!alive) return
          const message = err instanceof Error ? err.message : String(err)
          errorRef.current = message
          setError(message)
          setPhase('failed')
          say('Удаление не удалось')
        }
      )
    }, FLIGHT_MS)
    return () => {
      alive = false
      clearTimeout(started)
      offProgress()
      offFailed()
    }
    // Once per screen: a removal is never started twice, whatever the callbacks do meanwhile.
  }, [])

  useEffect(() => {
    if (phase === 'failed') back.current?.focus()
    if (phase === 'final') finish.current?.focus()
  }, [phase])

  const visual = phase === 'final' ? 'done' : phase
  return (
    <section className="remove-screen" data-phase={visual} aria-label="Удаление SenAWG">
      <div className="titlebar-drag" aria-hidden="true" />
      <div className="remove-main">
        <div className="mark" ref={markLogo}>
          <svg className="ring" viewBox="0 0 128 128" aria-hidden="true">
            <circle className="ring-track" cx="64" cy="64" r="59" />
            <circle
              ref={arc}
              className="ring-arc"
              cx="64"
              cy="64"
              r="59"
              style={{ strokeDashoffset: ring.offset, transitionDuration: `${ring.ms}ms`, transitionTimingFunction: ring.ease }}
            />
          </svg>
          <span className="ring-pulse" aria-hidden="true" />
          <Logo className={`mark-logo${landed ? ' landed' : ''}`} />
        </div>

        <div className="remove-panel">
          <div className={`panel${phase !== 'final' ? ' panel-on' : ''}`}>
            <h1 className="remove-title">SenAWG</h1>
            <p className="remove-sub" role="status" aria-live="polite">
              {sub.prev && (
                <span key={sub.n - 1} className="sub-out" aria-hidden="true">
                  {sub.prev}
                </span>
              )}
              <span key={sub.n} className="sub-in">
                {sub.text}
              </span>
            </p>
            <ol className="steps">
              {['Отключение и остановка службы', 'Служба подключения', keepData ? 'Файлы программы' : 'Файлы программы, серверы и ключи'].map(
                (label, i) => (
                  <li key={label} className="step" data-state={steps[i]}>
                    <span className="step-mark" aria-hidden="true">
                      <span className="m-dot" />
                      <span className="m-spin" />
                      <span className="m-done">
                        <svg viewBox="0 0 20 20">
                          <path d="M5.4 10.4 8.5 13.5 14.6 7" />
                        </svg>
                      </span>
                      <span className="m-fail">
                        <svg viewBox="0 0 20 20">
                          <path d="M6.8 6.8 13.2 13.2M13.2 6.8 6.8 13.2" />
                        </svg>
                      </span>
                    </span>
                    <span className="step-label">{label}</span>
                  </li>
                )
              )}
            </ol>
          </div>

          <div className={`panel remove-final${phase === 'final' ? ' panel-on' : ''}`}>
            <h1 className="remove-title">SenAWG удалён</h1>
            <p className="remove-final-sub">
              {keepData
                ? 'Серверы и ключи остались на диске — при новой установке они будут на месте.'
                : 'Серверы и ключи стёрты вместе с программой.'}
            </p>
            {phase === 'final' && (
              <Button ref={finish} onClick={() => void window.awg.finishUninstall()}>
                Завершить
              </Button>
            )}
          </div>
        </div>
      </div>

      {error && phase !== 'leaving' && (
        <p className="notice remove-error" role="alert">
          {error}
        </p>
      )}
      {phase === 'failed' && (
        <Button ref={back} variant="tonal" className="remove-back" onClick={leave}>
          Вернуться в приложение
        </Button>
      )}
    </section>
  )
}
