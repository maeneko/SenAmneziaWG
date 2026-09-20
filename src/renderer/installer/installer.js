/*
 * Drives the setup screen.
 *
 * In the packaged app the main process drives it through the preload bridge:
 *   window.awgSetup.defaultPath      where the express install puts the app
 *   window.awgSetup.pickFolder()     Promise<string | null> — the system folder dialog
 *   window.awgSetup.install(path)    do it; progress comes back through onProgress
 *   window.awgSetup.onProgress(fn)   fn({ step: 0 | 1 | 2, state: 'active' | 'done' })
 *   window.awgSetup.onFailed(fn)     fn({ step, message }) — the end of the road, nothing follows
 *   window.awgSetup.entered()        the greeting has landed; the app may take the window over
 *
 * Without that bridge — in a browser, or in `npm run dev` — the screen rehearses the same timeline
 * on made-up durations, so the animation can be worked on without a Windows machine.
 */
;(function () {
  'use strict'

  /** 2πr for r = 59, the ring's radius in the SVG. */
  var CIRCUMFERENCE = 370.71
  /** Where the express install puts the app; the bridge overrides it with the real thing. */
  var DEFAULT_PATH = 'C:\\Program Files\\AmnesiaWG'
  /** The finished ring deserves a beat of its own before the screen becomes the greeting. */
  var DONE_HOLD_MS = 900
  /** Rehearsal only: what each step roughly costs on a real machine. */
  var REHEARSAL_MS = [1500, 2200, 1100]

  var stage = document.getElementById('stage')
  var setup = document.getElementById('setup')
  var welcome = document.getElementById('welcome')
  var logo = document.getElementById('logo')
  var welcomeLogo = document.getElementById('welcome-logo')
  var arc = document.getElementById('arc')
  var sub = document.getElementById('sub')
  var error = document.getElementById('error')
  var steps = Array.prototype.slice.call(document.querySelectorAll('.step'))
  var panels = {
    intro: document.getElementById('panel-intro'),
    path: document.getElementById('panel-path'),
    work: document.getElementById('panel-work')
  }
  var pathInput = document.getElementById('path')

  /** No step is shown for less than this, however fast the real work turns out to be. */
  var MIN_BEAT_MS = 420

  var timers = []
  var speed = 1
  var installPath = DEFAULT_PATH
  var startedAt = Date.now()
  var queue = []
  var pumping = false
  var lastBeatAt = 0

  function clearTimers() {
    timers.forEach(clearTimeout)
    timers = []
    queue = []
    pumping = false
  }

  /** Waiting for the work: scales with the rehearsal speed. */
  function at(ms, fn) {
    timers.push(setTimeout(fn, ms / speed))
    return ms
  }

  /** Waiting for an animation to end: must match its CSS duration exactly, whatever the speed. */
  function after(ms, fn) {
    timers.push(setTimeout(fn, ms))
  }

  /**
   * Paces what the service reports. Installing can finish in a blink — on a warm machine every step
   * may report done within the same second — and a list that flickers through three ticks reads as a
   * glitch, not as work. Beats wait their turn, and the first one waits for the entrance.
   */
  function beat(fn) {
    queue.push(fn)
    pump()
  }

  function pump() {
    if (pumping || queue.length === 0) return
    var now = Date.now()
    var wait = Math.max(MIN_BEAT_MS - (now - lastBeatAt), introMs() - (now - startedAt), 0)
    pumping = true
    timers.push(
      setTimeout(function () {
        pumping = false
        lastBeatAt = Date.now()
        queue.shift()()
        pump()
      }, wait)
    )
  }

  /**
   * How long the first step waits. The grey track draws itself a whole circle first and only then
   * does the progress start filling it: two rings growing at once would be one unreadable ring.
   * Tied to the drawing itself, so reduced motion collapses this wait along with it.
   */
  function introMs() {
    return cssMs('--t-in') * 1.25
  }

  function cssMs(name) {
    var raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    if (raw.slice(-2) === 'ms') return parseFloat(raw)
    if (raw.slice(-1) === 's') return parseFloat(raw) * 1000
    return 0
  }

  // ── Ring ──

  function setProgress(fraction, ms, ease) {
    arc.style.setProperty('--ring-ms', Math.round(ms / speed) + 'ms')
    arc.style.setProperty('--ring-ease', ease || 'linear')
    arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - fraction))
  }

  // ── The line under the name ──

  function setSub(text) {
    var previous = sub.firstElementChild
    if (previous && previous.textContent === text) return
    var next = document.createElement('span')
    next.className = 'sub-in'
    next.textContent = text
    if (previous) {
      previous.className = 'sub-out'
      after(cssMs('--t-swap'), function () {
        if (previous.parentNode === sub) sub.removeChild(previous)
      })
    }
    sub.appendChild(next)
  }

  function setSubNow(text) {
    sub.textContent = ''
    var only = document.createElement('span')
    only.textContent = text
    sub.appendChild(only)
  }

  // ── Steps ──

  /**
   * A running step creeps towards its share of the ring but stops just short of it, so finishing
   * always shows as a small, definite step forward — and an honest one: how long the real work
   * takes is not known in advance.
   */
  function startStep(index, estimateMs) {
    steps[index].dataset.state = 'active'
    setProgress((index + 0.92) / steps.length, estimateMs, 'cubic-bezier(0, 0.6, 0.3, 1)')
  }

  function finishStep(index) {
    steps[index].dataset.state = 'done'
    setProgress((index + 1) / steps.length, 240, 'cubic-bezier(0.2, 0, 0, 1)')
  }

  function finish() {
    setup.dataset.phase = 'done'
    setSub('Готово')
    at(DONE_HOLD_MS, handoff)
  }

  // ── Handoff: the setup screen becomes the greeting, in place ──

  /**
   * In two beats, never at once. First the screen empties — the ring above all, since a ring in
   * mid-air beside the greeting would be neither one screen nor the other — and only the logo is
   * left standing. Then it moves.
   */
  function handoff() {
    stage.classList.add('setup-leaving')
    // A third of a beat past the fade, so the ring is plainly gone before anything else moves.
    after(cssMs('--t-fade') * 1.35, fly)
  }

  /**
   * The logo survives the change as the very same pixels: the greeting is already laid out (hidden)
   * underneath, so its resting place can be measured and the logo flown there on a transform alone.
   * When it lands, the greeting's own logo takes over in the same spot.
   */
  function fly() {
    var from = logo.getBoundingClientRect()
    var to = welcomeLogo.getBoundingClientRect()
    var move = cssMs('--t-move')

    logo.style.transition = 'transform ' + move + 'ms var(--ease-std)'
    logo.style.transform =
      'translate(' + (to.left - from.left) + 'px, ' + (to.top - from.top) + 'px) scale(' + to.width / from.width + ')'
    welcome.classList.add('on')

    after(move, function () {
      stage.classList.add('setup-done')
      document.title = 'AmnesiaWG' // the window stops being «Установка AmnesiaWG» the moment it is the app
      if (bridge && bridge.entered) bridge.entered()
    })
  }

  // ── Failure ──

  /**
   * The end of the road: the service is what the app connects through, so there is nothing to hand
   * over to. The screen keeps the list — which step broke is half the answer — and says what broke.
   */
  function fail(index, message) {
    clearTimers()
    setup.dataset.phase = 'failed'
    if (steps[index]) steps[index].dataset.state = 'failed'
    setSub('Установка не удалась')
    error.textContent = message || 'Не удалось завершить установку.'
  }

  // ── Panels: welcome, folder, work ──

  function showPanel(name) {
    Object.keys(panels).forEach(function (key) {
      panels[key].classList.toggle('panel-on', key === name)
    })
  }

  function chooseFolder() {
    if (bridge && bridge.pickFolder) {
      bridge.pickFolder().then(function (picked) {
        if (picked) pathInput.value = picked
      })
      return
    }
    // No dialog in a browser: walk through paths that look like the ones people actually pick.
    var samples = [DEFAULT_PATH, 'D:\\Programs\\AmnesiaWG', 'C:\\Users\\User\\AppData\\Local\\AmnesiaWG']
    var next = samples.indexOf(pathInput.value) + 1
    pathInput.value = samples[next % samples.length]
  }

  /** The choice is made; from here the screen is the same one it has always been. */
  function enterWork(path) {
    installPath = path
    setup.dataset.phase = 'work'
    setup.classList.add('ring-on') // the ring draws itself once, here
    showPanel('work')
    startedAt = Date.now()
    lastBeatAt = 0
  }

  function begin(path) {
    enterWork(path)
    if (bridge) bridge.install(path)
    else rehearse()
  }

  // ── Whole screen ──

  function reset() {
    clearTimers()
    stage.classList.remove('setup-leaving', 'setup-done')
    welcome.classList.remove('on')
    setup.dataset.phase = 'intro'
    setup.classList.remove('ring-on')
    showPanel('intro')
    pathInput.value = installPath
    logo.style.transition = ''
    logo.style.transform = ''
    steps.forEach(function (step) {
      step.dataset.state = 'pending'
    })
    setProgress(0, 0)
    setSubNow('Установка')
    error.textContent = ''
    document.title = 'Установка AmnesiaWG'
    startedAt = Date.now()
    lastBeatAt = 0
    void stage.offsetWidth // replays the entrance
  }

  /** Rehearsal of the way it ends badly: the service is the step that can really refuse. */
  function failRehearsal() {
    reset()
    enterWork(installPath)
    beat(function () {
      startStep(0, MIN_BEAT_MS)
    })
    beat(function () {
      finishStep(0)
    })
    beat(function () {
      startStep(1, 1400)
      at(1400, function () {
        fail(1, 'Не удалось установить службу AmnesiaWG (код 5). Без неё приложение не сможет подключаться.')
      })
    })
  }

  /**
   * Rehearsal of the other extreme: a machine where every step reports done at once. Goes through
   * the same queue the bridge uses, so this is the real check that nothing flickers.
   */
  function burst() {
    reset()
    enterWork(installPath)
    steps.forEach(function (_, index) {
      beat(function () {
        startStep(index, MIN_BEAT_MS)
      })
      beat(function () {
        finishStep(index)
        if (index === steps.length - 1) at(260, finish)
      })
    })
  }

  /** Rehearsal: the same calls the bridge would make, on invented durations. */
  function rehearse() {
    var t = introMs()
    steps.forEach(function (_, index) {
      var cost = REHEARSAL_MS[index]
      at(t, function () {
        startStep(index, cost)
      })
      t += cost
      at(t, function () {
        finishStep(index)
      })
      t += 260
    })
    at(t, finish)
  }

  // ── Wiring ──

  var bridge = window.awgSetup

  if (bridge && bridge.defaultPath) installPath = bridge.defaultPath

  document.getElementById('express').addEventListener('click', function () {
    begin(installPath)
  })
  document.getElementById('manual').addEventListener('click', function () {
    showPanel('path')
    pathInput.focus()
  })
  document.getElementById('browse').addEventListener('click', chooseFolder)
  document.getElementById('back').addEventListener('click', function () {
    showPanel('intro')
  })
  document.getElementById('install').addEventListener('click', function () {
    var chosen = pathInput.value.trim()
    if (chosen) begin(chosen)
  })

  reset()

  if (bridge) {
    if (bridge.onFailed) {
      bridge.onFailed(function (event) {
        beat(function () {
          fail(event.step, event.message)
        })
      })
    }
    bridge.onProgress(function (event) {
      beat(function () {
        if (event.state !== 'done') {
          startStep(event.step, REHEARSAL_MS[event.step])
          return
        }
        finishStep(event.step)
        if (event.step === steps.length - 1) at(260, finish)
      })
    })
  } else {
    // Browser preview: expose the screen to the dev bar and play it once.
    window.__setupPreview = {
      play: reset,
      burst: burst,
      failNow: failRehearsal,
      reset: reset,
      finishNow: function () {
        reset()
        enterWork(installPath)
        steps.forEach(function (step) {
          step.dataset.state = 'done'
        })
        setProgress(1, 240, 'cubic-bezier(0.2, 0, 0, 1)')
        finish()
      },
      setSpeed: function (value) {
        speed = value
      }
    }
    var css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = './dev/preview.css'
    document.head.appendChild(css)
    var script = document.createElement('script')
    script.src = './dev/preview.js'
    document.body.appendChild(script)
  }
})()
