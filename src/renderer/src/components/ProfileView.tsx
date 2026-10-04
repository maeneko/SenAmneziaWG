import { useCallback, useEffect, useState } from 'react'
import { accountName, hasAccessToken } from '@shared/account'
import type { PaymentDetails, Profile, ProfileStatus, PromoDiscount } from '@shared/types'
import { errorText } from '../lib/errors'
import { formatAgo, formatDate, formatDiscount, formatRubles, pluralDays, pluralDevices } from '../lib/format'
import { dismissRejection, paymentOutcome, paymentRejected, pendingPayment, startPayment, trackPayment } from '../lib/payments'
import { type CachedProfile, cachedProfile, loadProfile } from '../lib/profiles'
import { CopyButton } from './CopyButton'
import { Dialog } from './Dialog'
import { KeysDialog } from './KeysDialog'
import { MA7_BOT_URL, PaymentResult, PaymentSteps } from './PaymentStatus'
import { Button, IconButton } from './ui'

/** The capsule next to the login: a word for the state, and a hint for the long story. */
const STATUS: Record<ProfileStatus, { label: string; hint: string }> = {
  active: { label: 'Активна', hint: 'Подписка оплачена' },
  processing: { label: 'Проверка оплаты', hint: 'Платёж получен и ждёт подтверждения' },
  unpaid: { label: 'Не оплачена', hint: 'Подписка ещё не оплачивалась' },
  overdue: { label: 'Просрочена', hint: 'Срок вышел, а на балансе не хватило на продление' }
}

/** The paid period is a month: the bar under «Подписка» shows how much of it is left. */
const PERIOD_DAYS = 30
/** Days left from which the bar takes the warning tone. */
const LOW_DAYS = 3
const DAY_MS = 86_400_000

/**
 * Payment through the application (the client is in main/ma7.ts): MA7 gives the requisites (POST /api/page/payment)
 * and takes «Подтвердить» (POST /api/page/paid) — both only with the access token, so an old link without one
 * keeps «Оплатить» disabled. The switches stay for a MA7 that loses a route again.
 */
const PAY_READY = true
const CONFIRM_READY = true
/** How often the payment dialog, and the account while a transfer is checked, ask MA7 whether the admin has answered. */
const PAY_POLL_MS = 5000

/**
 * «Профиль»: the MA7 account a master key was issued to (the login after «#» in its sen:// link) — whether
 * the subscription is paid and until when, the balance, and a promo code. Paying is done in the bot.
 * `keyless`: accounts whose key is gone from this computer (revoked or unbound); they get the way to a new one.
 */
export function ProfileView({ logins, keyless }: { logins: string[]; keyless: string[] }): React.JSX.Element {
  return (
    <>
      {logins.map((login) => (
        <ProfileSection key={login} login={login} keyless={keyless.includes(login)} />
      ))}
    </>
  )
}

function ProfileSection({ login, keyless }: { login: string; keyless: boolean }): React.JSX.Element {
  // The last known account stands at once; the fresh one replaces it when MA7 answers.
  const [data, setData] = useState(() => cachedProfile(login))
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [paying, setPaying] = useState(false)
  const closePay = useCallback(() => setPaying(false), [])
  const [promo, setPromo] = useState(false)
  const closePromo = useCallback(() => setPromo(false), [])
  const [leaving, setLeaving] = useState(false)
  const closeLeave = useCallback(() => setLeaving(false), [])
  // «Устройства»: which way the dialog was opened, «−» or «+»; null while it is closed.
  const [changing, setChanging] = useState<'more' | 'fewer' | null>(null)
  const closeChange = useCallback(() => setChanging(null), [])
  // «Промокод применён»: stays under the account until the next thing is done with it.
  const [discount, setDiscount] = useState<PromoDiscount | null>(null)
  // The admin turned the last payment down: a red card until «Оплатить снова» or «Написать в бот», or a few days
  // (lib/payments.ts).
  const [rejected, setRejected] = useState(() => paymentRejected(login))
  // The admin took the payment while «Профиль» was open: a green card until the page is left. `until`: the new end
  // date when it moved, null when the money went on the balance.
  const [approved, setApproved] = useState<{ until: number | null } | null>(null)

  // Every fresh answer: shown, and read for the admin's answer to a payment request.
  const take = useCallback(
    (entry: CachedProfile): void => {
      setData(entry)
      const before = pendingPayment(login)
      const outcome = trackPayment(entry.profile)
      if (outcome === 'approved') {
        const until = entry.profile.paidUntil
        setApproved({ until: until !== null && until > (before?.paidUntil ?? 0) ? until : null })
      } else if (outcome === 'rejected' || entry.profile.status === 'processing') {
        // A newer request, or its answer: the green card of the one before is not about it.
        setApproved(null)
      }
      setRejected(paymentRejected(login))
    },
    [login]
  )
  const dismiss = (): void => {
    dismissRejection(login)
    setRejected(false)
  }

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      take(await loadProfile(login, window.awg.getProfile))
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [login, take])

  useEffect(() => {
    void load()
  }, [load])

  // While the transfer is checked the account is asked again every few seconds, quietly (no «Обновляю…»): the
  // admin's answer shows up by itself.
  const processing = data?.profile.status === 'processing'
  useEffect(() => {
    if (!processing) return
    const timer = window.setInterval(() => {
      loadProfile(login, window.awg.getProfile).then(take, () => undefined)
    }, PAY_POLL_MS)
    return () => window.clearInterval(timer)
  }, [processing, login, take])

  // Stable: the payment dialog hands it to its close handler, and a new one would move the focus.
  const paid = useCallback(() => {
    setPaying(false)
    void load()
  }, [load])

  const now = Date.now()
  const p = data?.profile
  // An old link brings the login alone: MA7 shows the account by it, but promo codes and payment need the access
  // token a fresh link from the bot carries after the login.
  const name = accountName(login)
  const token = hasAccessToken(login)
  // Nothing to pay for without devices, nor while a transfer is checked. A first purchase is not paid here either:
  // the number of keys is chosen in the bot, and MA7 turns «Подтвердить» down for it (409 BUY_IN_BOT) — after the
  // money has gone. The account says where to go instead.
  const unpaid = p?.status === 'unpaid'
  const canPay = p !== undefined && p.monthly > 0 && p.status !== 'processing' && !unpaid
  const short = p !== undefined && p.monthly > p.balance && p.status !== 'processing' && !unpaid
  // More devices only on a paid, running period: they are paid for the days left of it (MA7 setkeycount wants status 1).
  const canAdd = p?.status === 'active' && !keyless
  return (
    <>
      <section className="settings-group key-card" aria-labelledby={`profile-${login}`} aria-busy={loading || undefined}>
        <header className="key-head">
          <div className="key-head-main">
            <h2 id={`profile-${login}`} className="key-name mono">
              {name}
            </h2>
            {p && (
              <span className={`key-state key-state-${p.status}`} title={STATUS[p.status].hint}>
                {STATUS[p.status].label}
              </span>
            )}
            {/* «Выйти» in the head, not under the buttons: with the balance warning the card fills the window already. */}
            <span className="profile-tools">
              <CopyButton text={name} label="Скопировать логин" />
              <IconButton icon="logout" label="Выйти из аккаунта" onClick={() => setLeaving(true)} />
            </span>
          </div>
          <p className="key-checked">
            Аккаунт MA7{data ? ` · обновлено ${formatAgo(data.at / 1000, now)}` : ''}
          </p>
        </header>

        {p && <Period profile={p} now={now} />}
        {p && (
          <dl className="profile-facts">
            <div>
              <dt>Баланс</dt>
              <dd>{formatRubles(p.balance)}</dd>
            </div>
            <div>
              <dt>К оплате</dt>
              <dd>{formatRubles(p.monthly)} в месяц</dd>
            </div>
            <div>
              <dt>Устройств</dt>
              {/* «−» and «+» around the number they change, not in the row of buttons: those are about paying. The «+»
                  glyph ends on the right edge the other values keep. */}
              <dd className="fact-action">
                {canAdd && (
                  <IconButton
                    icon="minus"
                    tone="accent"
                    className="fact-add"
                    label={token ? 'Меньше устройств' : 'Меньше устройств — нужен новый мастер-ключ из бота'}
                    disabled={!token || p.keys <= 1}
                    onClick={() => setChanging('fewer')}
                  />
                )}
                {p.keys}
                {canAdd && (
                  <IconButton
                    icon="plus"
                    tone="accent"
                    className="fact-add"
                    label={token ? 'Больше устройств' : 'Больше устройств — нужен новый мастер-ключ из бота'}
                    disabled={!token}
                    onClick={() => setChanging('more')}
                  />
                )}
              </dd>
            </div>
          </dl>
        )}
        {keyless && (
          <p className="profile-short" role="status">
            На этом компьютере нет ключа этого аккаунта — его отозвали или отвязали, VPN не подключится.{' '}
            {p && p.status !== 'active' && p.status !== 'processing' ? 'Оплатите подписку и получите' : 'Получите'} новый
            мастер-ключ в Telegram-боте MA7.
          </p>
        )}
        {unpaid && !keyless && (
          <p className="profile-short" role="status">
            Подписка ещё не оплачена. Первая оплата — в Telegram-боте MA7: там выбирают, сколько нужно ключей.
          </p>
        )}
        {short && !keyless && (
          <p className="profile-short" role="status">
            {p.status === 'overdue' ? 'Баланса не хватило на продление.' : 'Баланса не хватит на следующий месяц.'} Оплатите
            подписку{PAY_READY ? '' : ' в Telegram-боте MA7'}, чтобы VPN продолжал работать.
          </p>
        )}
        {processing && (
          // The request with the admin: the same steps as in the payment dialog.
          <div className="pay-card">
            <PaymentSteps>Перевод проверяет администратор — обычно это занимает до часа. Когда он подтвердит оплату, подписка продлится.</PaymentSteps>
          </div>
        )}
        {approved && !processing && (
          <div className="pay-card">
            <PaymentResult kind="approved" title="Оплата подтверждена" compact>
              {approved.until !== null ? `Подписка действует до ${formatDate(approved.until)}.` : 'Деньги на балансе — с них продлится подписка.'}
            </PaymentResult>
          </div>
        )}
        {rejected && !processing && (
          // No «Понятно»: the card goes with either way on from it, or by itself after a few days.
          <div className="pay-card pay-card-rejected">
            <PaymentResult kind="rejected" title="Оплата не подтверждена" compact>
              Администратор не нашёл перевод. Если вы оплатили, напишите в Telegram-бот MA7.
            </PaymentResult>
            <div className="pay-card-actions">
              <a className="btn btn-tonal sl" href={MA7_BOT_URL} target="_blank" rel="noreferrer" onClick={dismiss}>
                Написать в бот
              </a>
              {canPay && token && (
                <Button
                  icon="card"
                  onClick={() => {
                    dismiss()
                    setPaying(true)
                  }}
                >
                  Оплатить снова
                </Button>
              )}
            </div>
          </div>
        )}

        {discount !== null && (
          <p className="profile-note promo-done" role="status">
            Промокод применён: скидка {formatDiscount(discount)}
          </p>
        )}
        {error && <p className="form-error key-error">{error}</p>}
        {!p && loading && <p className="hint">Загрузка…</p>}

        <div className="key-actions profile-actions">
          {/* After a rejection the red card carries «Оплатить снова»: one way to pay, not two. */}
          {canPay && !rejected && (
            <Button
              icon="card"
              disabled={!PAY_READY || !token}
              title={!PAY_READY ? 'В разработке' : token ? undefined : 'Нужен новый мастер-ключ из бота'}
              onClick={() => {
                setApproved(null)
                setPaying(true)
              }}
            >
              Оплатить
            </Button>
          )}
          {p && (
            <Button
              variant="tonal"
              icon="ticket"
              disabled={!token}
              title={token ? undefined : 'Нужен новый мастер-ключ из бота'}
              onClick={() => {
                setDiscount(null)
                setPromo(true)
              }}
            >
              Промокод
            </Button>
          )}
          <Button variant="tonal" disabled={loading} onClick={() => void load()}>
            {loading && p ? 'Обновляю…' : p ? 'Обновить' : 'Повторить'}
          </Button>
        </div>
        {/* With the warning above, the bot is named there: one line less in a card that fills the window. */}
        {p && !token && (
          <p className="hint profile-note">
            Промокоды, оплата и устройства — с новым мастер-ключом. Получите его в Telegram-боте MA7 и добавьте в приложение ещё раз:
            ключ и устройства останутся прежними.
          </p>
        )}
        {canPay && !PAY_READY && !short && token && <p className="hint profile-note">Оплата из приложения в разработке. Пока оплатите подписку в Telegram-боте MA7.</p>}
      </section>

      {/* No «onDone»: the login leaves the keys, and with it this section (and «Профиль», if it was the last). */}
      {leaving && <LogoutDialog login={login} keyless={keyless} onClose={closeLeave} />}

      {paying && p && (
        <PayDialog profile={p} onClose={closePay} onPaid={paid} />
      )}

      {/* Whatever happened in it — devices bought, a top-up sent — the account is asked again on the way out. */}
      {changing && p && <KeysDialog login={login} keys={p.keys} start={changing} onClose={closeChange} onChanged={() => void load()} />}

      {promo && (
        <PromoDialog
          login={login}
          onClose={closePromo}
          onApplied={(off) => {
            setPromo(false)
            setDiscount(off)
            // The discount changes what the next month costs.
            void load()
          }}
        />
      )}
    </>
  )
}

/** «Подписка»: until when it is paid, and a bar of how much of the month is left. */
function Period({ profile: p, now }: { profile: Profile; now: number }): React.JSX.Element {
  const days = p.paidUntil === null ? null : Math.ceil((p.paidUntil - now) / DAY_MS)
  let summary: string
  if (p.status === 'unpaid' || days === null) summary = 'не оплачена'
  else if (p.status === 'processing') summary = 'платёж проверяется'
  else if (days > 0) summary = `ещё ${pluralDays(days)}`
  else if (days === 0) summary = 'заканчивается сегодня'
  else summary = `закончилась ${pluralDays(-days)} назад`
  const left = days === null ? 0 : Math.min(100, Math.max(0, Math.round((days / PERIOD_DAYS) * 100)))

  return (
    <>
      <div className="key-devices-head">
        <h3 className="key-devices-title">Подписка</h3>
        <span className="key-devices-count">{summary}</span>
      </div>
      <div className="key-meter" role="presentation">
        <span className={days !== null && days <= LOW_DAYS ? 'key-meter-low' : undefined} style={{ width: `${left}%` }} />
      </div>
      <dl className="profile-facts">
        <div>
          <dt>{days !== null && days < 0 ? 'Действовала до' : 'Действует до'}</dt>
          <dd>{p.paidUntil === null ? '—' : formatDate(p.paidUntil)}</dd>
        </div>
      </dl>
    </>
  )
}

/** «Промокод»: one field; applied, the dialog closes and the card says what it took off. */
function PromoDialog({ login, onClose, onApplied }: { login: string; onClose: () => void; onApplied: (discount: PromoDiscount) => void }): React.JSX.Element {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A stable handler: the dialog puts the focus back to its first field whenever this one changes.
  const close = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])

  async function apply(): Promise<void> {
    const text = code.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.awg.applyPromo(login, text)
      if (result.ok) {
        onApplied(result.discount)
        return
      }
      setError(result.error)
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }

  return (
    <Dialog
      title="Промокод"
      onClose={close}
      actions={
        <>
          <Button variant="tonal" disabled={busy} onClick={onClose}>
            Отмена
          </Button>
          <Button icon="check" disabled={busy || !code.trim()} onClick={() => void apply()}>
            {busy ? 'Применяю…' : 'Применить'}
          </Button>
        </>
      }
    >
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault()
          void apply()
        }}
      >
        <input
          className="input mono"
          aria-label="Промокод"
          placeholder="Введите код"
          autoComplete="off"
          spellCheck={false}
          value={code}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setCode(e.target.value)
            setError(null)
          }}
        />
        {error && <p className="form-error">{error}</p>}
      </form>
      <p className="pay-note">Скидка по промокоду действует на следующие платежи за подписку.</p>
    </Dialog>
  )
}

/** «Выйти из аккаунта»: the login leaves the master keys; the keys, their servers and the VPN stay. */
function LogoutDialog({ login, keyless, onClose }: { login: string; keyless: boolean; onClose: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])

  async function logout(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.awg.logoutProfile(login)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Выйти из аккаунта?"
      onClose={close}
      actions={
        <>
          <Button variant="tonal" disabled={busy} onClick={onClose}>
            Отмена
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void logout()}>
            {busy ? 'Выхожу…' : 'Выйти'}
          </Button>
        </>
      }
    >
      <p className="pay-note">
        Аккаунт <span className="mono">{accountName(login)}</span> пропадёт из приложения.{' '}
        {keyless ? '' : 'Мастер-ключ и серверы останутся, VPN продолжит работать. '}Чтобы вернуть «Профиль», снова
        вставьте ссылку мастер-ключа с логином.
      </p>
      {error && <p className="form-error">{error}</p>}
    </Dialog>
  )
}


/**
 * «Оплатить»: a transfer by phone number to the account MA7 names, then «Подтвердить». The money is not
 * checked here: an admin finds the transfer and confirms it, and until then the account is `processing`.
 * After «Подтвердить» the dialog waits for that answer, asking MA7 for the account every few seconds: money on the
 * balance or a longer period means the transfer was found; the account back where it was means it was not
 * (lib/payments.ts — the same rule the card uses once the dialog is closed).
 */
function PayDialog({ profile: p, onClose, onPaid }: { profile: Profile; onClose: () => void; onPaid: () => void }): React.JSX.Element {
  const [details, setDetails] = useState<PaymentDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [stage, setStage] = useState<'details' | 'waiting' | 'approved' | 'rejected'>('details')
  const [paidUntil, setPaidUntil] = useState<number | null>(null)

  const fetchDetails = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      setDetails(await window.awg.getPaymentDetails(p.login))
    } catch (e) {
      setError(errorText(e))
    }
  }, [p.login])

  useEffect(() => {
    void fetchDetails()
  }, [fetchDetails])

  async function confirm(): Promise<void> {
    setSending(true)
    setError(null)
    try {
      await window.awg.confirmPayment(p.login)
      startPayment(p)
      setStage('waiting')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    if (stage !== 'waiting') return
    let gone = false
    const timer = window.setInterval(() => {
      window.awg.getProfile(p.login).then(
        (now) => {
          const outcome = paymentOutcome(p, now)
          if (gone || !outcome) return
          // A renewal puts the money on the balance and leaves the date: the date is named only when it moved.
          setPaidUntil(now.paidUntil !== null && now.paidUntil > (p.paidUntil ?? 0) ? now.paidUntil : null)
          setStage(outcome)
        },
        // No answer this time: the next tick asks again.
        () => undefined
      )
    }, PAY_POLL_MS)
    return () => {
      gone = true
      window.clearInterval(timer)
    }
  }, [stage, p.login, p.paidUntil])

  // Once the request is sent, closing refreshes the account: it shows «Проверка оплаты» or the new date.
  const finish = stage === 'details' ? onClose : onPaid
  // A stable handler: the dialog puts the focus back to its first button whenever this one changes.
  const close = useCallback(() => {
    if (!sending) finish()
  }, [sending, finish])

  // After «Подтвердить» the requisites have done their work: the steps stand in their place, and the admin's answer
  // is a screen of its own — the mark, the words, the ways on.
  let actions: React.ReactNode
  let body: React.ReactNode
  if (stage === 'details') {
    actions = (
      <>
        <Button variant="tonal" disabled={sending} onClick={onClose}>
          Отмена
        </Button>
        <Button icon="check" disabled={!CONFIRM_READY || !details || sending} title={CONFIRM_READY ? undefined : 'В разработке'} onClick={() => void confirm()}>
          {sending ? 'Отправляю…' : 'Подтвердить'}
        </Button>
      </>
    )
    body = (
      <>
        <div className="pay-amount">
          <span className="pay-amount-label">К оплате</span>
          <span className="pay-amount-sum">{formatRubles(p.monthly)}</span>
          <span className="pay-amount-sub">за месяц · {pluralDevices(p.keys)}</span>
        </div>
        {details && (
          <dl className="pay-details">
            <div>
              <dt>Банк</dt>
              <dd>{details.bank}</dd>
            </div>
            <div>
              <dt>Номер телефона</dt>
              <dd className="mono">{details.phone}</dd>
              <CopyButton text={details.phone.replace(/[^\d+]/g, '')} label="Скопировать номер" />
            </div>
            {details.recipient && (
              <div>
                <dt>Получатель</dt>
                <dd>{details.recipient}</dd>
              </div>
            )}
          </dl>
        )}
        {!details && !error && <p className="hint">Загружаю реквизиты…</p>}
        {error && !details ? (
          // The requisites did not come: «Подтвердить» stays where it is, the retry sits by the reason.
          <div className="pay-retry">
            <p className="form-error">{error}</p>
            <Button variant="tonal" onClick={() => void fetchDetails()}>
              Повторить
            </Button>
          </div>
        ) : (
          error && <p className="form-error">{error}</p>
        )}
        {CONFIRM_READY ? (
          <p className="pay-note">
            Переведите сумму по номеру телефона через СБП, затем нажмите «Подтвердить». Администратор проверит перевод и
            продлит подписку.
          </p>
        ) : (
          <p className="pay-note">
            Переведите сумму по номеру телефона через СБП, затем сообщите об оплате в Telegram-боте MA7: «Оплатить» → «Я
            оплатил». Подтверждение из приложения в разработке.
          </p>
        )}
      </>
    )
  } else if (stage === 'waiting') {
    actions = (
      <Button variant="tonal" onClick={onPaid}>
        Закрыть
      </Button>
    )
    body = (
      <>
        <div className="pay-amount">
          <span className="pay-amount-label">Перевод</span>
          <span className="pay-amount-sum">{formatRubles(p.monthly)}</span>
          <span className="pay-amount-sub">за месяц · {pluralDevices(p.keys)}</span>
        </div>
        <PaymentSteps>Администратор ищет перевод — обычно это занимает до часа. Окно можно закрыть: ответ придёт в «Профиль» и уведомлением.</PaymentSteps>
      </>
    )
  } else if (stage === 'approved') {
    actions = <Button onClick={onPaid}>Готово</Button>
    body = (
      <PaymentResult kind="approved" title="Оплата подтверждена">
        {paidUntil !== null ? `Подписка действует до ${formatDate(paidUntil)}.` : 'Деньги на балансе — с них продлится подписка.'}
      </PaymentResult>
    )
  } else {
    // «Закрыть» and «Оплатить снова» under it; the bot is a link in the words — three buttons do not fit the window.
    actions = (
      <>
        <Button variant="tonal" onClick={onPaid}>
          Закрыть
        </Button>
        <Button
          icon="card"
          onClick={() => {
            dismissRejection(p.login)
            setStage('details')
          }}
        >
          Оплатить снова
        </Button>
      </>
    )
    body = (
      <PaymentResult kind="rejected" title="Оплата не подтверждена">
        Администратор не нашёл перевод. Если вы оплатили, напишите{' '}
        <a className="pay-outcome-link" href={MA7_BOT_URL} target="_blank" rel="noreferrer" onClick={() => dismissRejection(p.login)}>
          в Telegram-бот MA7
        </a>{' '}
        — разберёмся.
      </PaymentResult>
    )
  }

  return (
    <Dialog title="Оплата подписки" step={stage} onClose={close} actions={actions}>
      {body}
    </Dialog>
  )
}
