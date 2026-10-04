import { useCallback, useEffect, useRef, useState } from 'react'
import { accountName, hasAccessToken } from '@shared/account'
import type { KeyQuotes, PaymentDetails, Profile, ProfileStatus, PromoDiscount } from '@shared/types'
import { errorText } from '../lib/errors'
import { formatAgo, formatDate, formatDiscount, formatRubles, pluralDays, pluralDevices } from '../lib/format'
import { dismissRejection, paymentOutcome, paymentRejected, startPayment, trackPayment } from '../lib/payments'
import { type CachedProfile, cachedProfile, loadProfile } from '../lib/profiles'
import { Dialog } from './Dialog'
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
  const [adding, setAdding] = useState(false)
  const closeAdd = useCallback(() => setAdding(false), [])
  // «Промокод применён»: stays under the account until the next thing is done with it.
  const [discount, setDiscount] = useState<PromoDiscount | null>(null)
  // The admin turned the last payment down: a red card until «Понятно» or «Оплатить снова» (lib/payments.ts).
  const [rejected, setRejected] = useState(() => paymentRejected(login))

  // Every fresh answer: shown, and read for the admin's answer to a payment request.
  const take = useCallback(
    (entry: CachedProfile): void => {
      setData(entry)
      trackPayment(entry.profile)
      setRejected(paymentRejected(login))
    },
    [login]
  )

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
              <dd>{p.keys}</dd>
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
          // A card of its own while the admin checks the transfer: what is going on, and the ring turning on the right.
          <div className="pay-wait-card" role="status">
            <div className="pay-wait-text">
              <span className="pay-wait-title">Ожидание подтверждения</span>
              <span>Перевод проверяет администратор. Когда он подтвердит оплату, подписка продлится.</span>
            </div>
            <span className="pay-spin" aria-hidden="true" />
          </div>
        )}
        {rejected && !processing && (
          <div className="pay-reject-card" role="alert">
            <div className="pay-wait-text">
              <span className="pay-wait-title">Оплата не подтверждена</span>
              <span>Администратор не нашёл перевод. Если вы оплатили, напишите в Telegram-бот MA7.</span>
            </div>
            <div className="pay-reject-actions">
              <Button
                variant="tonal"
                onClick={() => {
                  dismissRejection(login)
                  setRejected(false)
                }}
              >
                Понятно
              </Button>
              {canPay && token && (
                <Button
                  icon="card"
                  onClick={() => {
                    dismissRejection(login)
                    setRejected(false)
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
              onClick={() => setPaying(true)}
            >
              Оплатить
            </Button>
          )}
          {canAdd && (
            <Button
              variant="tonal"
              icon="plus"
              disabled={!token}
              title={token ? undefined : 'Нужен новый мастер-ключ из бота'}
              onClick={() => setAdding(true)}
            >
              Устройства
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
      {adding && p && <KeysDialog profile={p} onClose={closeAdd} onChanged={() => void load()} />}

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
        <span className={days !== null && days <= LOW_DAYS ? 'key-meter-full' : undefined} style={{ width: `${left}%` }} />
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

/** Copies a value and says so on the button itself for a moment. */
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

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <IconButton
      className={className}
      icon={copied ? 'check' : 'copy'}
      label={copied ? 'Скопировано' : label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => undefined)}
    />
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

  return (
    <Dialog
      title="Оплата подписки"
      onClose={close}
      actions={
        stage === 'details' ? (
          <>
            <Button variant="tonal" disabled={sending} onClick={onClose}>
              Отмена
            </Button>
            <Button
              icon="check"
              disabled={!CONFIRM_READY || !details || sending}
              title={CONFIRM_READY ? undefined : 'В разработке'}
              onClick={() => void confirm()}
            >
              {sending ? 'Отправляю…' : 'Подтвердить'}
            </Button>
          </>
        ) : stage === 'waiting' ? (
          <>
            <Button variant="tonal" onClick={onPaid}>
              Закрыть
            </Button>
            {/* In place of «Подтвердить»: the request is with the admin, nothing to press until they answer. */}
            <span className="pay-waiting" role="status">
              Ожидание подтверждения
              <span className="pay-spin" aria-hidden="true" />
            </span>
          </>
        ) : (
          <Button variant={stage === 'approved' ? 'filled' : 'tonal'} onClick={onPaid}>
            {stage === 'approved' ? 'Готово' : 'Закрыть'}
          </Button>
        )
      }
    >
      <div className="pay-amount">
        <span className="pay-amount-label">К оплате</span>
        <span className="pay-amount-sum">{formatRubles(p.monthly)}</span>
        <span className="pay-amount-sub">
          за месяц · {pluralDevices(p.keys)}
        </span>
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

      {stage === 'details' &&
        (CONFIRM_READY ? (
          <p className="pay-note">
            Переведите сумму по номеру телефона через СБП, затем нажмите «Подтвердить». Администратор проверит перевод и
            продлит подписку.
          </p>
        ) : (
          <p className="pay-note">
            Переведите сумму по номеру телефона через СБП, затем сообщите об оплате в Telegram-боте MA7: «Оплатить» → «Я
            оплатил». Подтверждение из приложения в разработке.
          </p>
        ))}
      {stage === 'waiting' && (
        <p className="pay-note">Заявка отправлена. Администратор проверит перевод и продлит подписку — окно можно закрыть.</p>
      )}
      {stage === 'approved' && (
        <p className="pay-result" role="status">
          Оплата подтверждена{' — '}
          {paidUntil !== null ? `подписка действует до ${formatDate(paidUntil)}` : 'деньги на балансе, с них продлится подписка'}
        </p>
      )}
      {stage === 'rejected' && (
        <p className="form-error" role="status">
          Администратор не подтвердил оплату. Если вы перевели деньги, напишите в Telegram-бот MA7.
        </p>
      )}
    </Dialog>
  )
}

/**
 * «Устройства»: more devices on the account, and so on its master key. MA7 prices them (keyquote, the same sum the
 * bot shows): devices above the ones already paid for this period cost their share of the month for the days
 * left, the end date stays. The sums for every count up to the most come in one answer when the dialog opens, so
 * «+» and «−» only turn the page — nothing is asked between presses. «Оплатить с баланса» charges exactly the sum
 * shown — MA7 refuses another and sends the new one, shown here instead (setkeycount). When the balance lacks, the
 * transfer goes the way a payment does — requisites, «Подтвердить», the admin — and only the money comes back: the
 * devices are bought after it, at the sum of that moment. Removing devices stays in the bot.
 */
function KeysDialog({ profile: p, onClose, onChanged }: { profile: Profile; onClose: () => void; onChanged: () => void }): React.JSX.Element {
  const [count, setCount] = useState(p.keys + 1)
  // One sum per count, from the next one up to the most MA7 gives; empty when the account is at the most already.
  const [table, setTable] = useState<KeyQuotes | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Why the sum on screen is not the one the person saw last: MA7 counted again, or the top-up came.
  const [note, setNote] = useState<{ text: string; good: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<'pick' | 'topup' | 'waiting' | 'done'>('pick')
  const [bought, setBought] = useState<{
    devices: number
    charged: number
  } | null>(null)
  const [details, setDetails] = useState<PaymentDetails | null>(null)
  const touched = useRef(false)

  // The newest request wins: an older answer that comes late is dropped.
  const asked = useRef(0)
  const price = useCallback(async (): Promise<void> => {
    const id = ++asked.current
    setLoading(true)
    setError(null)
    try {
      const priced = await window.awg.getKeyQuotes(p.login)
      if (id !== asked.current) return
      setTable(priced)
      // The account may have more devices by now than the card showed: the count starts where the table does.
      const { quotes } = priced
      setCount((n) => (quotes.length && !quotes.some((x) => x.target === n) ? quotes[0].target : n))
    } catch (e) {
      if (id === asked.current) setError(errorText(e))
    } finally {
      if (id === asked.current) setLoading(false)
    }
  }, [p.login])

  // On opening, and on every way back to the choice: after a top-up the balance, and with it every sum, is new.
  useEffect(() => {
    if (stage === 'pick') void price()
  }, [stage, price])

  const quotes = table?.quotes ?? []
  const q = quotes.find((x) => x.target === count) ?? null
  const min = quotes.length ? quotes[0].target : p.keys + 1
  const max = table?.maxKeys ?? null
  const atMost = table !== null && quotes.length === 0
  const adding = count - (q?.current ?? p.keys)

  async function buy(): Promise<void> {
    if (!q || busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const result = await window.awg.buyKeys(p.login, count, q.amount)
      touched.current = true
      if (result.ok) {
        setBought({ devices: result.devices, charged: result.charged })
        setStage('done')
      } else {
        // Nothing was charged: the new sum stands where the old one was, to be pressed again or not — and the rest of
        // the table is asked again, it moved for the same reason.
        setTable((t) => (t ? { ...t, quotes: t.quotes.map((x) => (x.target === result.quote.target ? result.quote : x)) } : t))
        setNote({ text: result.error, good: false })
        void price()
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const fetchDetails = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      setDetails(await window.awg.getPaymentDetails(p.login))
    } catch (e) {
      setError(errorText(e))
    }
  }, [p.login])

  function toTopup(): void {
    setStage('topup')
    setNote(null)
    if (!details) void fetchDetails()
  }

  async function sendTopup(): Promise<void> {
    if (!q || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.awg.requestTopup(p.login, count, q.shortfall)
      touched.current = true
      setStage('waiting')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  // The top-up is with the admin: the account is asked every few seconds, and once the balance holds the sum the
  // devices are priced again — the admin may take a day, and the days left with it.
  useEffect(() => {
    if (stage !== 'waiting' || !q) return
    const need = q.amount
    let gone = false
    const timer = window.setInterval(() => {
      window.awg.getProfile(p.login).then(
        (now) => {
          if (gone || now.balance < need) return
          setNote({
            text: `Баланс пополнен: ${formatRubles(now.balance)}. Проверьте сумму и оплатите устройства`,
            good: true
          })
          setStage('pick')
        },
        () => undefined
      )
    }, PAY_POLL_MS)
    return () => {
      gone = true
      window.clearInterval(timer)
    }
  }, [stage, q, p.login])

  const finish = useCallback(() => {
    if (busy) return
    if (touched.current) onChanged()
    onClose()
  }, [busy, onChanged, onClose])

  const stepper = (
    <div className="keys-stepper">
      <span className="keys-stepper-label">Устройств будет</span>
      <IconButton icon="minus" label="Меньше" disabled={busy || atMost || count <= min} onClick={() => setCount((n) => n - 1)} />
      <span className="keys-stepper-value" aria-live="polite">
        {atMost ? table.maxKeys : count}
      </span>
      <IconButton icon="plus" label="Больше" disabled={busy || (max !== null && count >= max)} onClick={() => setCount((n) => n + 1)} />
    </div>
  )

  let title = 'Добавить устройства'
  let body: React.ReactNode
  let actions: React.ReactNode

  if (stage === 'pick') {
    // Asked again (after a refused sum, a top-up) the sums on screen stay, dimmed, until the new ones come.
    const pending = loading
    const v = q
    const enough = v !== null && v.balance >= v.amount
    const free = v ? adding - v.addKeys : 0
    body = (
      <>
        {stepper}
        <div className={`pay-amount${pending ? ' keys-amount-busy' : ''}`} aria-busy={pending || undefined}>
          <span className="pay-amount-label">Доплата сейчас</span>
          <span className="pay-amount-sum">{v ? formatRubles(v.amount) : '—'}</span>
          <span className="pay-amount-sub">
            {!v
              ? pending
                ? 'Считаю…'
                : atMost
                  ? 'больше устройств не добавить'
                  : 'нет расчёта'
              : v.amount > 0
                ? `за ${pluralDays(v.daysLeft)} из ${v.periodDays} до конца подписки`
                : 'уже оплачено в этом периоде'}
          </span>
        </div>
        {v && (
          <dl className={`profile-facts${pending ? ' keys-stale' : ''}`}>
            {v.addKeys > 0 && (
              <div>
                <dt>Расчёт</dt>
                <dd>
                  {v.addKeys} × {formatRubles(v.price)}
                  {v.discountMonthly > 0 ? ` − ${formatRubles(v.discountMonthly)}` : ''} × {v.daysLeft}/{v.periodDays}
                </dd>
              </div>
            )}
            {free > 0 && (
              <div>
                <dt>Без доплаты</dt>
                <dd>{pluralDevices(free)}</dd>
              </div>
            )}
            <div>
              <dt>{v.paidUntil !== null ? `С ${formatDate(v.paidUntil)}` : 'В месяц'}</dt>
              <dd>{formatRubles(v.monthlyNext)} в месяц</dd>
            </div>
            <div>
              <dt>Баланс</dt>
              <dd>{formatRubles(v.balance)}</dd>
            </div>
          </dl>
        )}
        {note && (
          <p className={note.good ? 'profile-note promo-done' : 'profile-short'} role="status">
            {note.text}
          </p>
        )}
        {v && !enough && (
          <p className="profile-short" role="status">
            На балансе не хватает {formatRubles(v.shortfall)}. Пополните его — после подтверждения устройства можно будет оплатить здесь же.
          </p>
        )}
        {atMost && (
          <p className="profile-short" role="status">
            У аккаунта уже {pluralDevices(table.maxKeys)} — это наибольшее число, которое выдаёт MA7.
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        {v && (
          <p className="pay-note">
            {free > 0 && v.addKeys === 0
              ? 'Эти места уже оплачены до конца подписки — добавляются бесплатно. '
              : 'Дата окончания подписки не меняется. '}
            Мастер-ключ сразу примет {pluralDevices(count)}: добавьте его ссылку на новом устройстве.
          </p>
        )}
      </>
    )
    actions = (
      <>
        <Button variant="tonal" disabled={busy} onClick={finish}>
          Отмена
        </Button>
        {v && !enough ? (
          <Button icon="card" disabled={!q || busy || pending} onClick={toTopup}>
            Пополнить на {formatRubles(v.shortfall)}
          </Button>
        ) : (
          <Button icon="check" disabled={!q || busy || pending} onClick={() => void buy()}>
            {busy ? 'Оплачиваю…' : v && v.amount > 0 ? `Оплатить ${formatRubles(v.amount)}` : 'Добавить'}
          </Button>
        )}
      </>
    )
  } else if (stage === 'topup' || stage === 'waiting') {
    title = 'Пополнение баланса'
    body = (
      <>
        <div className="pay-amount">
          <span className="pay-amount-label">К пополнению</span>
          <span className="pay-amount-sum">{q ? formatRubles(q.shortfall) : '—'}</span>
          <span className="pay-amount-sub">под {pluralDevices(count)}</span>
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
          <div className="pay-retry">
            <p className="form-error">{error}</p>
            <Button variant="tonal" onClick={() => void fetchDetails()}>
              Повторить
            </Button>
          </div>
        ) : (
          error && <p className="form-error">{error}</p>
        )}
        <p className="pay-note">
          {stage === 'topup'
            ? 'Переведите сумму по номеру телефона через СБП и нажмите «Подтвердить». Администратор проверит перевод и зачислит деньги на баланс — с него и оплатятся устройства.'
            : 'Заявка отправлена. Когда администратор подтвердит перевод, здесь появится расчёт — окно можно закрыть и вернуться в «Устройства» позже.'}
        </p>
      </>
    )
    actions =
      stage === 'topup' ? (
        <>
          <Button variant="tonal" disabled={busy} onClick={() => setStage('pick')}>
            Назад
          </Button>
          <Button icon="check" disabled={!details || busy} onClick={() => void sendTopup()}>
            {busy ? 'Отправляю…' : 'Подтвердить'}
          </Button>
        </>
      ) : (
        <>
          <Button variant="tonal" onClick={finish}>
            Закрыть
          </Button>
          <span className="pay-waiting" role="status">
            Ожидание подтверждения
            <span className="pay-spin" aria-hidden="true" />
          </span>
        </>
      )
  } else {
    title = 'Устройства добавлены'
    body = (
      <>
        <p className="pay-result" role="status">
          Теперь {pluralDevices(bought?.devices ?? count)}
          {bought && bought.charged > 0 ? ` — с баланса списано ${formatRubles(bought.charged)}` : ''}
        </p>
        <p className="pay-note">
          Мастер-ключ уже принимает новые устройства: добавьте его ссылку в SenAWG на каждом из них. С{' '}
          {q?.paidUntil != null ? formatDate(q.paidUntil) : 'следующего месяца'} подписка будет стоить{' '}
          {q ? formatRubles(q.monthlyNext) : '—'} в месяц.
        </p>
      </>
    )
    actions = <Button onClick={finish}>Готово</Button>
  }

  return (
    <Dialog title={title} step={stage} onClose={finish} canClose={!busy} actions={actions}>
      {body}
    </Dialog>
  )
}
