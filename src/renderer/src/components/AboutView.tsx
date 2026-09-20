import { useEffect, useState } from 'react'
import type { AboutInfo } from '@shared/types'
import { Logo } from './ui'

/** The daemon the app is a client for; the link opens in the browser, never inside the app. */
const ENGINE_URL = 'https://github.com/amnezia-vpn/amneziawg-go'

export function AboutView(): React.JSX.Element {
  const [about, setAbout] = useState<AboutInfo | null>(null)

  useEffect(() => {
    let alive = true
    void window.awg.getAbout().then(
      (info) => {
        if (alive) setAbout(info)
      },
      () => {
        /* the panel simply keeps saying «определяется…» */
      }
    )
    return () => {
      alive = false
    }
  }, [])

  return (
    <>
      <section className="settings-group about-head">
        <Logo className="about-logo" />
        <h2 className="settings-title about-name">AmnesiaWG</h2>
      </section>

      <section className="settings-group" aria-labelledby="about-what">
        <h2 id="about-what" className="settings-title">Что это</h2>
        <p className="hint">Это как AmneziaVPN, но от меня :P.</p>
      </section>

      <section className="settings-group" aria-labelledby="about-versions">
        <h2 id="about-versions" className="settings-title">Версии</h2>
        <dl className="about-list">
          <dt>Ядро</dt>
          <dd>{about?.engine ?? 'определяется…'}</dd>
          <dt>Версия приложения</dt>
          <dd className="about-build">{about?.app ?? 'определяется…'}</dd>
        </dl>
        <p className="hint">
          <a className="about-link" href={ENGINE_URL} target="_blank" rel="noreferrer">
            Проект amneziawg-go
          </a>
        </p>
      </section>
    </>
  )
}
