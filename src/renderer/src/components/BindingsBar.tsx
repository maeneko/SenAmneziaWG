import { useEffect, useRef, useState } from 'react'

/**
 * The slots of a master key as a bar. It is painted at `from` and moves to `to`, and moves again whenever `to`
 * changes: growing by one when this computer is added, shrinking by one when it is unbound — the person sees
 * the slot being taken or given back.
 */
export function BindingsBar({ from, to, limit }: { from: number; to: number; limit: number }): React.JSX.Element {
  const [shown, setShown] = useState(from)
  const fill = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    // Reading the width makes the browser settle the bar where it stands; only then does the new width
    // transition instead of simply being there. Not a frame callback: a window that is hidden or minimized
    // runs none, and the bar would never get to its number.
    void fill.current?.offsetWidth
    setShown(to)
  }, [to])
  const pct = Math.min(100, Math.round((shown / Math.max(1, limit)) * 100))
  return (
    <div className="key-bindings" role="status">
      <div className="key-bindings-head">
        <span>Привязки</span>
        <span>
          {shown} из {limit}
        </span>
      </div>
      <div className="key-meter">
        <span ref={fill} className={shown >= limit ? 'key-meter-full' : undefined} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
