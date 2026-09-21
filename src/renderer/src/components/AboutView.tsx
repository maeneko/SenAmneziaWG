import { useEffect, useState } from 'react'
import type { AboutInfo } from '@shared/types'
import { Logo } from './ui'

/** The daemon the app is a client for; the link opens in the browser, never inside the app. */
const ENGINE_URL = 'https://github.com/amnezia-vpn/amneziawg-go'

/** «О SenAWG»: one block of «Приложение» — it used to be a tab, and a fifth tab did not fit the window. */
export function AboutView(): React.JSX.Element {
  const [about, setAbout] = useState<AboutInfo | null>(null)

  useEffect(() => {
    let alive = true
    void window.awg.getAbout().then(
      (info) => {
        if (alive) setAbout(info)
      },
      () => {
        /* the block simply keeps saying «определяется…» */
      }
    )
    return () => {
      alive = false
    }
  }, [])

  return (
    <section className="settings-group" aria-labelledby="set-about">
      <div className="about-head">
        <Logo className="about-logo" />
        <div className="about-title">
          <h2 id="set-about" className="settings-title about-name">
            О SenAWG
          </h2>
          <p className="hint">Это как AmneziaVPN, но от меня :P.</p>
        </div>
      </div>
      <dl className="about-list">
        <dt>Ядро</dt>
        <dd>{about?.engine ?? 'определяется…'}</dd>
        <dt>Версия приложения</dt>
        <dd className="about-build">{about?.app ?? 'определяется…'}</dd>
      </dl>
      <p className="hint about-foot">
        <a className="about-link" href={ENGINE_URL} target="_blank" rel="noreferrer">
          Проект amneziawg-go
        </a>
      </p>
    </section>
  )
}
