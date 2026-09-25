/*
 * The harness: runs the application's page in the window with ?demo=mac-update and plays what macOS does
 * around it. The page tells what it is doing through postMessage (src/renderer/src/demo/bridge.ts); the
 * «quit» it sends is the old process going, after which the page is opened again as the new copy.
 */
const win = document.getElementById('win') as HTMLDivElement
const frame = document.getElementById('app') as HTMLIFrameElement
const steps = [...document.querySelectorAll<HTMLLIElement>('#steps li')]
const fail = document.getElementById('fail') as HTMLInputElement

let speed = 1
/** The new copy's page is loading behind a closed window. */
let opening = false
/** Launch Services opening an application: about a second from the old process gone to the new window. */
const GAP_MS = 1100
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms / speed))

const ORDER = ['check', 'download', 'stage', 'quit', 'open', 'done'] as const
type Step = (typeof ORDER)[number]

function mark(now: Step | null, { skip = [] as Step[] } = {}): void {
  const at = now ? ORDER.indexOf(now) : -1
  for (const li of steps) {
    const i = ORDER.indexOf(li.dataset.step as Step)
    li.dataset.state = skip.includes(li.dataset.step as Step) ? 'skip' : i < at ? 'done' : i === at ? 'now' : ''
  }
}

function open(params: Record<string, string> = {}): void {
  const q = new URLSearchParams({ demo: 'mac-update', speed: String(speed), ...params })
  frame.src = `/index.html?${q}`
}

function versionIs(v: string): void {
  document.querySelectorAll('.v').forEach((el) => (el.textContent = v))
}

async function relaunch(version: string): Promise<void> {
  mark('quit')
  win.classList.add('win-gone')
  await wait(GAP_MS)
  mark('open')
  win.classList.add('win-opening')
  opening = true
  open(fail.checked ? { updated: version, failed: '1' } : { updated: version })
}

window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as { type?: string; step?: string; version?: string; updated?: boolean }
  if (data?.type !== 'senawg-demo') return
  switch (data.step) {
    case 'checking':
      return mark('check')
    case 'available':
    case 'downloading':
      if (data.version) versionIs(data.version)
      return mark('download')
    case 'ready':
    case 'installing':
      if (data.version) versionIs(data.version)
      return mark('stage')
    case 'quit':
      return void relaunch(data.version ?? '')
    case 'loaded':
      // Shown once its page has painted, as Electron's ready-to-show does — not on the frame's load, which
      // comes before the first frame and would flash an empty window.
      if (opening) {
        opening = false
        setTimeout(() => {
          win.classList.remove('win-gone')
          setTimeout(() => win.classList.remove('win-opening'), 300)
        }, 200)
      }
      // The new copy: done, or — the swap failed — the old one again, which says nothing.
      if (frame.src.includes('updated=')) {
        if (data.updated) mark('done')
        else mark('done', { skip: ['done'] })
      }
      return
  }
})

/** From the start again, whatever was playing: the window back in place. */
function restart(params: Record<string, string> = {}): void {
  opening = false
  win.classList.remove('win-gone', 'win-opening')
  versionIs('…')
  mark(null)
  open(params)
}
document.getElementById('again')!.addEventListener('click', () => restart())
document.getElementById('ready')!.addEventListener('click', () => restart({ start: 'ready' }))
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) =>
  b.addEventListener('click', () => {
    speed = Number(b.dataset.speed)
    document.querySelectorAll('[data-speed]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)))
  })
)

// The version the site will offer: one patch above this build, as the bridge computes it.
versionIs('…')
mark(null)
open()
