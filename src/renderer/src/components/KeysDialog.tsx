import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyDevices, KeyQuotes, PaymentDetails } from '@shared/types'
import { errorText } from '../lib/errors'
import { formatAgo, formatAmount, formatDate, formatRubles, pluralDays, pluralDevices } from '../lib/format'
import { wheelPairs } from '../lib/wheels'
import { CopyButton } from './CopyButton'
import { Dialog } from './Dialog'
import { PaymentResult, PaymentSteps } from './PaymentStatus'
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
 * «Устройства»: more or fewer devices on the account, and so on its master key. MA7 prices every count from 1 to the
 * most in one answer when the dialog opens (keyquote), so «+» and «−» only turn the page.
 *
 * More: the devices above the ones already paid for this period cost their share of the month for the days left,
 * the end date stays. «Оплатить с баланса» charges exactly the sum shown — MA7 refuses another and sends the new one,
 * shown here instead (setkeycount). When the balance lacks, the transfer goes the way a payment does — requisites,
 * «Подтвердить», the admin — and only the money comes back: the devices are bought after it, at the sum of that
 * moment.
 *
 * Fewer: nothing is charged or returned — the places stay paid until the end date and can be taken back free till
 * then; from it the month costs less. The master key's server does not unbind devices when its limit drops, so MA7
 * refuses to go below the devices bound to the key (TOO_MANY_DEVICES): the dialog lists them and the person ticks
 * the ones to unbind, this computer excepted, before the count goes down.
 */
export function KeysDialog({
  login,
  keys,
  start = 'more',
  onClose,
  onChanged
}: {
  login: string
  /** Devices the account has, as far as the page knows; MA7's table corrects it. */
  keys: number
  /** Which way the count starts: one more, or one fewer. */
  start?: 'more' | 'fewer'
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  const [count, setCount] = useState(Math.max(1, start === 'fewer' ? keys - 1 : keys + 1))
  // One sum per count, from 1 up to the most MA7 gives.
  const [table, setTable] = useState<KeyQuotes | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Why the sum on screen is not the one the person saw last: MA7 counted again, or the top-up came.
  const [note, setNote] = useState<{ text: string; good: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<'pick' | 'topup' | 'waiting' | 'done'>('pick')
  const [result, setResult] = useState<{ devices: number; charged: number; fewer: boolean } | null>(null)
  const [details, setDetails] = useState<PaymentDetails | null>(null)
  // Fewer: who is bound to the key, and the ones ticked to be unbound.
  const [bound, setBound] = useState<KeyDevices | null>(null)
  const [boundError, setBoundError] = useState<string | null>(null)
  const [picked, setPicked] = useState<number[]>([])
  const touched = useRef(false)

  // The newest request wins: an older answer that comes late is dropped.
  const asked = useRef(0)
  const placed = useRef(false)
  const price = useCallback(async (): Promise<void> => {
    const id = ++asked.current
    setLoading(true)
    setError(null)
    try {
      const priced = await window.awg.getKeyQuotes(login)
      if (id !== asked.current) return
      setTable(priced)
      const clamp = (n: number): number => Math.min(Math.max(1, n), Math.max(1, priced.maxKeys))
      // The first answer says how many there really are (the card may be behind): the count starts one away from
      // that, the way the dialog was opened. Later answers leave the person's choice where it is.
      const real = priced.quotes[0]?.current
      if (!placed.current && real !== undefined) {
        placed.current = true
        setCount(clamp(start === 'fewer' ? real - 1 : real + 1))
      } else {
        setCount(clamp)
      }
    } catch (e) {
      if (id === asked.current) setError(errorText(e))
    } finally {
      if (id === asked.current) setLoading(false)
    }
  }, [login, start])

  // On opening, and on every way back to the choice: after a top-up the balance, and with it every sum, is new.
  useEffect(() => {
    if (stage === 'pick') void price()
  }, [stage, price])

  const quotes = table?.quotes ?? []
  const q = quotes.find((x) => x.target === count) ?? null
  const current = quotes[0]?.current ?? keys
  const max = table?.maxKeys ?? null
  const fewer = count < current
  const same = count === current
  const adding = count - current

  const loadBound = useCallback(async (): Promise<void> => {
    setBoundError(null)
    try {
      setBound(await window.awg.getAccountDevices(login))
    } catch (e) {
      setBoundError(errorText(e))
    }
  }, [login])

  // Asked once the count first goes below the current one, and again after an unbinding that failed half-way.
  useEffect(() => {
    if (stage === 'pick' && fewer && bound === null && boundError === null) void loadBound()
  }, [stage, fewer, bound, boundError, loadBound])

  const need = fewer && bound ? Math.max(0, bound.devices.length - count) : 0
  // A count raised again needs fewer ticks: the latest ones go first.
  useEffect(() => {
    setPicked((ids) => (ids.length > need ? ids.slice(0, need) : ids))
  }, [need])

  async function buy(): Promise<void> {
    if (!q || busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const purchase = await window.awg.buyKeys(login, count, q.amount)
      touched.current = true
      if (purchase.ok) {
        setResult({ devices: purchase.devices, charged: purchase.charged, fewer: false })
        setStage('done')
      } else {
        // Nothing was charged: the new sum stands where the old one was, to be pressed again or not — and the rest of
        // the table is asked again, it moved for the same reason.
        setTable((t) => (t ? { ...t, quotes: t.quotes.map((x) => (x.target === purchase.quote.target ? purchase.quote : x)) } : t))
        setNote({ text: purchase.error, good: false })
        void price()
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  // Fewer: the ticked devices go first, one by one, then the count. A failure on the way leaves the ones already
  // unbound unbound, and the list is asked again, so what is shown is what is bound.
  async function reduce(): Promise<void> {
    if (!q || busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      for (const id of picked) {
        await window.awg.unbindAccountDevice(login, id)
        touched.current = true
      }
      const change = await window.awg.buyKeys(login, count, 0)
      touched.current = true
      if (change.ok) {
        setResult({ devices: change.devices, charged: 0, fewer: true })
        setStage('done')
      } else {
        setNote({ text: change.error, good: false })
        void price()
      }
    } catch (e) {
      setError(errorText(e))
      setPicked([])
      setBound(null)
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
    const want = q.amount
    let gone = false
    const timer = window.setInterval(() => {
      window.awg.getProfile(login).then(
        (now) => {
          if (gone || now.balance < want) return
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
      <IconButton icon="minus" label="Меньше" disabled={busy || count <= 1} onClick={() => setCount((n) => n - 1)} />
      <span className="keys-stepper-value" aria-live="polite">
        <RollingNumber value={count} />
      </span>
      <IconButton icon="plus" label="Больше" disabled={busy || (max !== null && count >= max)} onClick={() => setCount((n) => n + 1)} />
    </div>
  )

  let title = 'Устройства'
  let body: React.ReactNode
  let actions: React.ReactNode

  if (stage === 'pick') {
    // Asked again (after a refused sum, a top-up) the sums on screen stay, dimmed, until the new ones come.
    const pending = loading
    const v = q
    const enough = v !== null && v.balance >= v.amount
    const free = v && !fewer ? adding - v.addKeys : 0
    const until = v?.paidUntil != null ? formatDate(v.paidUntil) : null
    const now = quotes.find((x) => x.target === current)

    const box = fewer ? (
      <div className={`pay-amount${pending ? ' keys-amount-busy' : ''}`} aria-busy={pending || undefined}>
        <span className="pay-amount-label">{until ? `С ${until} в месяц` : 'В месяц'}</span>
        <span className="pay-amount-sum">
          {v ? (
            <>
              <RollingNumber value={v.monthlyNext} format={formatAmount} /> ₽
            </>
          ) : (
            '—'
          )}
        </span>
        <span className="pay-amount-sub">{now ? `вместо ${formatRubles(now.monthlyNext)} · сейчас ничего не списывается` : 'сейчас ничего не списывается'}</span>
      </div>
    ) : (
      <div className={`pay-amount${pending ? ' keys-amount-busy' : ''}`} aria-busy={pending || undefined}>
        <span className="pay-amount-label">{same ? 'Устройств столько же' : 'Доплата сейчас'}</span>
        <span className="pay-amount-sum">
          {v ? (
            <>
              <RollingNumber value={same ? v.monthlyNext : v.amount} format={formatAmount} /> ₽
            </>
          ) : (
            '—'
          )}
        </span>
        <span className="pay-amount-sub">
          {!v
            ? pending
              ? 'Считаю…'
              : 'нет расчёта'
            : same
              ? 'в месяц, как сейчас'
              : v.amount > 0
                ? `за ${pluralDays(v.daysLeft)} из ${v.periodDays} до конца подписки`
                : 'уже оплачено в этом периоде'}
        </span>
      </div>
    )

    const sec = Math.floor(Date.now() / 1000)
    const devices = fewer && (
      <>
        {!bound && !boundError && <p className="hint">Проверяю привязанные устройства…</p>}
        {boundError && (
          <div className="pay-retry">
            <p className="form-error">{boundError}</p>
            <Button variant="tonal" onClick={() => setBoundError(null)}>
              Повторить
            </Button>
          </div>
        )}
        {bound && need > 0 && (
          <div className="keys-unbind">
            <p className="keys-unbind-title">
              Привязано {pluralDevices(bound.devices.length)} — отметьте {need === 1 ? 'одно, которое' : `${need}, которые`} отвязать:
            </p>
            <div className="choices">
              {bound.devices.map((d) => {
                const on = picked.includes(d.id)
                const locked = d.current || (!on && picked.length >= need)
                return (
                  <label key={d.id} className={`choice sl${locked ? ' choice-locked' : ''}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={busy || locked}
                      onChange={() => setPicked((ids) => (on ? ids.filter((x) => x !== d.id) : [...ids, d.id]))}
                    />
                    <span className="choice-text">
                      <span>{d.name || 'Без имени'}</span>
                      <span className="hint">
                        {d.current
                          ? 'это устройство — отвязывается во вкладке «Ключ»'
                          : d.lastSeen
                            ? `активность ${formatAgo(d.lastSeen, sec * 1000)}`
                            : 'ещё не выходило на связь'}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        )}
      </>
    )

    body = (
      <>
        {stepper}
        {box}
        {v && !fewer && !same && (
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
              <dt>{until ? `С ${until}` : 'В месяц'}</dt>
              <dd>{formatRubles(v.monthlyNext)} в месяц</dd>
            </div>
            <div>
              <dt>Баланс</dt>
              <dd>{formatRubles(v.balance)}</dd>
            </div>
          </dl>
        )}
        {devices}
        {note && (
          <p className={note.good ? 'profile-note promo-done' : 'profile-short'} role="status">
            {note.text}
          </p>
        )}
        {v && !fewer && !same && !enough && (
          <p className="profile-short" role="status">
            На балансе не хватает {formatRubles(v.shortfall)}. Пополните его — после подтверждения устройства можно будет оплатить здесь же.
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        {v && fewer && (
          <p className="pay-note">
            Деньги за текущий период не возвращаются{until ? `: до ${until} места можно вернуть бесплатно` : ''}.
            {need > 0 ? ' Отвязанные устройства отключатся от VPN.' : ''}
          </p>
        )}
        {v && !fewer && !same && (
          <p className="pay-note">
            {free > 0 && v.addKeys === 0
              ? 'Эти места уже оплачены до конца подписки — добавляются бесплатно. '
              : 'Дата окончания подписки не меняется. '}
            Мастер-ключ сразу примет {pluralDevices(count)}: добавьте его ссылку на новом устройстве.
          </p>
        )}
      </>
    )

    let main: React.ReactNode
    if (fewer) {
      const ready = q !== null && bound !== null && picked.length >= need
      main = (
        <Button variant={need > 0 ? 'danger' : 'filled'} icon={need > 0 ? 'trash' : 'check'} disabled={!ready || busy || pending} onClick={() => void reduce()}>
          {busy ? (need > 0 ? 'Отвязываю…' : 'Уменьшаю…') : need > 0 ? 'Отвязать и уменьшить' : 'Уменьшить'}
        </Button>
      )
    } else if (same) {
      main = (
        <Button icon="check" disabled>
          Без изменений
        </Button>
      )
    } else if (v && !enough) {
      main = (
        <Button icon="card" disabled={!q || busy || pending} onClick={toTopup}>
          Пополнить на <RollingNumber value={v.shortfall} format={formatAmount} /> ₽
        </Button>
      )
    } else {
      main = (
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
      )
    }
    actions = (
      <>
        <Button variant="tonal" disabled={busy} onClick={finish}>
          Отмена
        </Button>
        {main}
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
        {stage === 'topup' ? (
          <p className="pay-note">
            Переведите сумму по номеру телефона через СБП и нажмите «Подтвердить». Администратор проверит перевод и зачислит
            деньги на баланс — с него и оплатятся устройства.
          </p>
        ) : (
          <PaymentSteps>
            Администратор ищет перевод. Когда подтвердит, деньги придут на баланс и здесь появится расчёт — окно можно закрыть и
            вернуться в «Устройства» позже.
          </PaymentSteps>
        )}
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
        <Button variant="tonal" onClick={finish}>
          Закрыть
        </Button>
      )
  } else {
    const until = q?.paidUntil != null ? formatDate(q.paidUntil) : null
    title = 'Устройства'
    body = (
      <PaymentResult kind="approved" title={result?.fewer ? 'Устройств стало меньше' : 'Устройства добавлены'}>
        Теперь {pluralDevices(result?.devices ?? count)}
        {result && result.charged > 0 ? `, с баланса списано ${formatRubles(result.charged)}` : ''}.{' '}
        {result?.fewer
          ? `${until ? `С ${until}` : 'Со следующего месяца'} подписка будет стоить ${q ? formatRubles(q.monthlyNext) : '—'} в месяц.${until ? ` До ${until} места можно вернуть бесплатно.` : ''}`
          : `Мастер-ключ уже принимает новые устройства — добавьте его ссылку в SenAWG на каждом. ${until ? `С ${until}` : 'Со следующего месяца'} подписка будет стоить ${q ? formatRubles(q.monthlyNext) : '—'} в месяц.`}
      </PaymentResult>
    )
    actions = <Button onClick={finish}>Готово</Button>
  }

  return (
    <Dialog title={title} step={stage} onClose={finish} canClose={!busy} actions={actions}>
      {body}
    </Dialog>
  )
}
