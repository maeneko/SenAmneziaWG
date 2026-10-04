import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyQuotes, PaymentDetails } from '@shared/types'
import { errorText } from '../lib/errors'
import { formatAmount, formatDate, formatRubles, pluralDays, pluralDevices } from '../lib/format'
import { wheelPairs } from '../lib/wheels'
import { CopyButton } from './CopyButton'
import { Dialog } from './Dialog'
import { Button, IconButton } from './ui'

/** How often the dialog, waiting for a top-up, asks MA7 whether the admin has answered. */
const PAY_POLL_MS = 5000

/** The roll of RollingNumber, as in app.css (.roll-in, .roll-out): design.md §6, standard curve. */
const ROLL_MS = 240
const ROLL_EASE = 'cubic-bezier(0.2, 0, 0, 1)'

/**
 * A number that rolls like an odometer when it changes: each character is a wheel of its own, and only the ones that
 * changed turn — up when the number grows (the old digit leaves upward, the new one rises from below), down when it
 * falls. Digits are matched by place (wheelPairs); a digit the number gains comes out of nothing.
 * What is around it («₽») stays put: it is written by the caller, not here. Each wheel is one grid cell with the
 * overflow cut, so nothing moves around it; a new key per change restarts the roll on quick presses, and the old
 * digits go once they have left. The first render plays nothing (design.md §6). `format`: how it is written («1 140»).
 */
function RollingNumber({ value, format = String }: { value: number; format?: (n: number) => string }): React.JSX.Element {
  const [shown, setShown] = useState<{ value: number; from: number | null; dir: 'up' | 'down'; step: number }>({
    value,
    from: null,
    dir: 'up',
    step: 0
  })
  if (value !== shown.value) {
    setShown({ value, from: shown.value, dir: value > shown.value ? 'up' : 'down', step: shown.step + 1 })
  }
  const now = format(shown.value)
  const was = shown.from === null ? now : format(shown.from)

  // A wheel takes the width of its new character, the old one rolls out over it. Where the two differ — a digit
  // appearing from nothing or going away, a group space — the wheel's width runs from the old to the new with the
  // roll, so the number widens smoothly and what follows it («₽», the edge of a button) slides instead of jumping.
  const root = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (shown.from === null || !root.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    for (const wheel of root.current.querySelectorAll<HTMLElement>('.roll')) {
      const [out, into] = wheel.children as unknown as [HTMLElement, HTMLElement]
      const from = out.getBoundingClientRect().width
      const to = into.getBoundingClientRect().width
      if (Math.abs(from - to) > 0.5) {
        wheel.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: ROLL_MS, easing: ROLL_EASE })
      }
    }
  }, [shown.step, shown.from])

  const settled = (): void => setShown((cur) => (cur.step === shown.step ? { ...cur, from: null } : cur))
  let reported = false

  const wheels: React.ReactNode[] = []
  for (const [key, before, after] of wheelPairs(was, now)) {
    if (before === after) {
      wheels.push(<span key={key}>{after}</span>)
      continue
    }
    // One wheel reports the end for all of them: they turn together.
    const report = !reported
    reported = true
    wheels.push(
      <span key={`${key}-${shown.step}`} className="roll">
        <span className={`roll-out roll-${shown.dir}`} aria-hidden="true" onAnimationEnd={report ? settled : undefined}>
          {before}
        </span>
        {/* A character going away leaves an empty wheel: a zero-width space keeps its line, so the old one shows. */}
        <span className={`roll-in roll-${shown.dir}`}>{after || '\u200b'}</span>
      </span>
    )
  }
  return (
    <span className="roll-number" ref={root}>
      {wheels}
    </span>
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
export function KeysDialog({
  login,
  keys,
  onClose,
  onChanged
}: {
  login: string
  /** Devices the account has, as far as the page knows; MA7's table corrects it. */
  keys: number
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  const [count, setCount] = useState(keys + 1)
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
      const priced = await window.awg.getKeyQuotes(login)
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
  }, [login])

  // On opening, and on every way back to the choice: after a top-up the balance, and with it every sum, is new.
  useEffect(() => {
    if (stage === 'pick') void price()
  }, [stage, price])

  const quotes = table?.quotes ?? []
  const q = quotes.find((x) => x.target === count) ?? null
  const min = quotes.length ? quotes[0].target : keys + 1
  const max = table?.maxKeys ?? null
  const atMost = table !== null && quotes.length === 0
  const adding = count - (q?.current ?? keys)

  async function buy(): Promise<void> {
    if (!q || busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const result = await window.awg.buyKeys(login, count, q.amount)
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
      setDetails(await window.awg.getPaymentDetails(login))
    } catch (e) {
      setError(errorText(e))
    }
  }, [login])

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
      await window.awg.requestTopup(login, count, q.shortfall)
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
      window.awg.getProfile(login).then(
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
  }, [stage, q, login])

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
        <RollingNumber value={atMost ? table.maxKeys : count} />
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
          <span className="pay-amount-sum">{v ? (
              <>
                <RollingNumber value={v.amount} format={formatAmount} /> ₽
              </>
            ) : (
              '—'
            )}</span>
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
            Пополнить на <RollingNumber value={v.shortfall} format={formatAmount} /> ₽
          </Button>
        ) : (
          <Button icon="check" disabled={!q || busy || pending} onClick={() => void buy()}>
            {busy ? (
              'Оплачиваю…'
            ) : v && v.amount > 0 ? (
              // The sum on wheels: the button widens with it, smoothly, as the sum above does.
              <>
                Оплатить <RollingNumber value={v.amount} format={formatAmount} /> ₽
              </>
            ) : (
              'Добавить'
            )}
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
