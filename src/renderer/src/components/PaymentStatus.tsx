import type { ReactNode } from 'react'
import { Icon } from './ui/Icon'

/** The bot a person writes to when a payment was turned down (the site links the same one). */
export const MA7_BOT_URL = 'https://t.me/ma7amnesiabot'

/**
 * A payment request on its way: «Отправлена → Проверка → Готово», the first done, the second turning while the
 * admin looks for the transfer, the last still to come — and under them, in words, what is going on. The same in
 * the payment dialog and on the account's card, so the person sees one thing wherever they look.
 */
export function PaymentSteps({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="pay-steps" role="status">
      <ol className="pay-steps-track">
        <li className="pay-step pay-step-done">
          <span className="pay-step-dot">
            <Icon name="check" size={14} />
          </span>
          <span className="pay-step-label">Отправлена</span>
        </li>
        <li className="pay-step pay-step-now">
          <span className="pay-step-dot">
            <span className="pay-spin" aria-hidden="true" />
          </span>
          <span className="pay-step-label">Проверка</span>
        </li>
        <li className="pay-step">
          <span className="pay-step-dot" />
          <span className="pay-step-label">Готово</span>
        </li>
      </ol>
      <p className="pay-steps-note">{children}</p>
    </div>
  )
}

/**
 * The admin's answer, as a screen of its own: a large mark — a green tick, or a red cross — the word for it, and
 * what it means. `compact`: the same on the account's card, the mark beside the words.
 */
export function PaymentResult({
  kind,
  title,
  children,
  compact = false
}: {
  kind: 'approved' | 'rejected'
  title: string
  children: ReactNode
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className={`pay-outcome pay-outcome-${kind}${compact ? ' pay-outcome-compact' : ''}`} role={kind === 'rejected' ? 'alert' : 'status'}>
      <span className="pay-outcome-mark" aria-hidden="true">
        <Icon name={kind === 'approved' ? 'check' : 'close'} size={compact ? 22 : 32} />
      </span>
      <span className="pay-outcome-words">
        <span className="pay-outcome-title">{title}</span>
        <span className="pay-outcome-text">{children}</span>
      </span>
    </div>
  )
}
