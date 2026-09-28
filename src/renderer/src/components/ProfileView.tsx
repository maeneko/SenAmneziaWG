import { useCallback, useEffect, useState } from 'react'
import type { PaymentDetails, Profile, ProfileStatus, PromoDiscount } from '@shared/types'
import { errorText } from '../lib/errors'
import { formatAgo, formatDate, formatDiscount, formatRubles, pluralDays, pluralDevices } from '../lib/format'
import { cachedProfile, loadProfile } from '../lib/profiles'
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
 * Payment through the application waits for MA7: it has neither the route with the requisites nor the one
 * taking «Подтвердить» (the client for both is in main/ma7.ts). Until then «Оплатить» is shown disabled,
 * and the subscription is paid in the MA7 bot.
 * TODO: MA7 — POST /api/page/payment { login } → { success, bank, phone, recipient? }; then PAY_READY = true.
 * TODO: MA7 — POST /api/page/paid { login } → { success }, the account turning `processing`; then CONFIRM_READY = true.
 */
const PAY_READY = false
const CONFIRM_READY = false

/**
 * «Профиль»: the MA7 account a master key was issued to (the login after «#» in its sen:// link) — whether
 * the subscription is paid and until when, the balance, and a promo code. Paying is done in the bot.
 */
export function ProfileView({ logins }: { logins: string[] }): React.JSX.Element {
  return (
    <>
      {logins.map((login) => (
        <ProfileSection key={login} login={login} />
      ))}
    </>
  )
}

function ProfileSection({ login }: { login: string }): React.JSX.Element {
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
  // «Промокод применён»: stays under the account until the next thing is done with it.
  const [discount, setDiscount] = useState<PromoDiscount | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setData(await loadProfile(login, window.awg.getProfile))
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [login])

  useEffect(() => {
    void load()
  }, [load])

  const now = Date.now()
  const p = data?.profile
  // Nothing to pay for without devices (a first purchase goes through the bot), nor while a transfer is checked.
  const canPay = p !== undefined && p.monthly > 0 && p.status !== 'processing'
  const short = p !== undefined && p.monthly > p.balance && p.status !== 'processing'
  return (
    <>
      <section className="settings-group key-card" aria-labelledby={`profile-${login}`} aria-busy={loading || undefined}>
        <header className="key-head">
          <div className="key-head-main">
            <h2 id={`profile-${login}`} className="key-name mono">
              {login}
            </h2>
            {p && (
              <span className={`key-state key-state-${p.status}`} title={STATUS[p.status].hint}>
                {STATUS[p.status].label}
              </span>
            )}
            {/* «Выйти» in the head, not under the buttons: with the balance warning the card fills the window already. */}
            <span className="profile-tools">
              <CopyButton text={login} label="Скопировать логин" />
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
        {short && (
          <p className="profile-short" role="status">
            {p.status === 'overdue' ? 'Баланса не хватило на продление.' : 'Баланса не хватит на следующий месяц.'} Оплатите
            подписку{PAY_READY ? '' : ' в Telegram-боте MA7'}, чтобы VPN продолжал работать.
          </p>
        )}
        {p?.status === 'processing' && (
          <p className="key-note profile-note">Перевод проверяет администратор. Когда он подтвердит оплату, подписка продлится.</p>
        )}

        {discount !== null && (
          <p className="profile-note promo-done" role="status">
            Промокод применён: скидка {formatDiscount(discount)}
          </p>
        )}
        {error && <p className="form-error key-error">{error}</p>}
        {!p && loading && <p className="hint">Загрузка…</p>}

        <div className="key-actions profile-actions">
          {canPay && (
            <Button icon="card" disabled={!PAY_READY} title={PAY_READY ? undefined : 'В разработке'} onClick={() => setPaying(true)}>
              Оплатить
            </Button>
          )}
          {p && (
            <Button
              variant="tonal"
              icon="ticket"
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
        {canPay && !PAY_READY && !short && <p className="hint profile-note">Оплата из приложения в разработке. Пока оплатите подписку в Telegram-боте MA7.</p>}
      </section>

      {/* No «onDone»: the login leaves the keys, and with it this section (and «Профиль», if it was the last). */}
      {leaving && <LogoutDialog login={login} onClose={closeLeave} />}

      {paying && p && (
        <PayDialog
          profile={p}
          onClose={closePay}
          onPaid={() => {
            setPaying(false)
            void load()
          }}
        />
      )}

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
function LogoutDialog({ login, onClose }: { login: string; onClose: () => void }): React.JSX.Element {
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
        Аккаунт <span className="mono">{login}</span> пропадёт из приложения. Мастер-ключ и серверы останутся, VPN продолжит
        работать. Чтобы вернуть «Профиль», снова вставьте ссылку мастер-ключа с логином.
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
 * The amount is the month in full — that is what the admin credits.
 */
function PayDialog({ profile: p, onClose, onPaid }: { profile: Profile; onClose: () => void; onPaid: () => void }): React.JSX.Element {
  const [details, setDetails] = useState<PaymentDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

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
      onPaid()
    } catch (e) {
      setError(errorText(e))
      setSending(false)
    }
  }

  // A stable handler: the dialog puts the focus back to its first button whenever this one changes.
  const close = useCallback(() => {
    if (!sending) onClose()
  }, [sending, onClose])

  // Digits only, as a bank's «по номеру телефона» field takes them.
  const amount = String(Math.round(p.monthly * 100) / 100)
  return (
    <Dialog
      title="Оплата подписки"
      onClose={close}
      actions={
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
          <div>
            <dt>Сумма</dt>
            <dd className="mono">{amount}</dd>
            <CopyButton text={amount} label="Скопировать сумму" />
          </div>
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
          Переведите сумму по номеру телефона через СБП. Подтверждение оплаты из приложения в разработке — администратор
          сам найдёт перевод и продлит подписку.
        </p>
      )}
    </Dialog>
  )
}
