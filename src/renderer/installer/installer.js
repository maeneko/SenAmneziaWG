/*
 * Drives the setup screen.
 *
 * In the packaged app the main process drives it through the preload bridge (src/main/setup):
 *   window.awgSetup.mode             'install' | 'update' — an update asks nothing but consent
 *   window.awgSetup.auto             an update the application itself started («Перезапустить и обновить»):
 *                                    consent was given there, so the screen goes straight to work
 *   window.awgSetup.defaultPath      where the express install puts the app
 *   window.awgSetup.buildId          the line at the foot
 *   window.awgSetup.returning        servers kept from an earlier install: the greeting is «С возвращением!»
 *   window.awgSetup.seamless         an update over the application the person just left: only the logo
 *                                    shows, and the screen leaves into the new application when done
 *   window.awgSetup.pickFolder()     Promise<string | null> — the system folder dialog
 *   window.awgSetup.install(path)    do it → Promise<{ ok, cancelled }>: `cancelled` is the administrator
 *                                    prompt being declined — not a failure, the screen goes back to the choice
 *   window.awgSetup.onProgress(fn)   fn({ step: 0 | 1 | 2, state: 'active' | 'done' })
 *   window.awgSetup.onFailed(fn)     fn({ step, message }) — the end of the road, nothing follows
 *   window.awgSetup.entered()        the greeting has landed and stopped moving; the app may take the window over
 *
 * Without that bridge — in a browser, or in `npm run dev` — the screen rehearses the same timeline
 * on made-up durations, so the animation can be worked on without a Windows machine.
 */
;(function () {
  'use strict'

  /** 2πr for r = 59, the ring's radius in the SVG. */
  var CIRCUMFERENCE = 370.71
  /** Where the express install puts the app; the bridge overrides it with the real thing. */
  var DEFAULT_PATH = 'C:\\Program Files\\SenAWG'
  /** The finished ring deserves a beat of its own before the screen becomes the greeting. */
  var DONE_HOLD_MS = 900
  /** Rehearsal only: what each step roughly costs on a real machine. */
  var REHEARSAL_MS = [1500, 2200, 1100]

  // Same rule as the application's own (src/renderer/src/main.tsx): the greeting laid out here must be
  // the one the application lays out, including the strip macOS reserves for its window buttons.
  document.documentElement.dataset.platform = /Macintosh|Mac OS X/.test(navigator.userAgent) ? 'mac' : 'other'

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
  var pathNote = document.getElementById('path-note')
  var foot = document.getElementById('foot')
  var introTitle = document.getElementById('intro-title')
  var introSub = document.getElementById('intro-sub')
  var expressLabel = document.querySelector('#express span')
  var firstKey = document.getElementById('first-key')
  var welcomeTitle = document.getElementById('welcome-title')

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
    // Nothing was announced, so nothing is celebrated: the logo simply leaves.
    if (seamless) return handoff()
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
    after(cssMs('--t-fade') * 1.35, mode === 'update' ? leave : fly)
  }

  /**
   * An update ends on the application itself, which is not the first-run greeting the logo flies to:
   * whoever updates already has servers. So nothing flies — the logo fades with the rest, and the
   * application takes the window.
   */
  function leave() {
    logo.style.transition = 'opacity ' + cssMs('--t-fade') + 'ms var(--ease-out)'
    logo.style.opacity = '0'
    after(cssMs('--t-fade'), function () {
      stage.classList.add('setup-done')
      document.title = 'SenAWG'
      if (bridge && bridge.entered) bridge.entered()
    })
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
      document.title = 'SenAWG' // the window stops being «Установка SenAWG» the moment it is the app
      // The application replaces this page with the same picture, so it may only do so once nothing here
      // is moving any more: the greeting is still assembling itself after the logo has landed.
      settled(function () {
        // The application's field arrives focused, ring and all; this one takes focus first, so the
        // swap changes nothing the eye can find. Two frames let the ring be painted before it happens.
        welcome.classList.add('settled')
        if (!returning) firstKey.focus({ preventScroll: true })
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            if (bridge && bridge.entered) bridge.entered()
          })
        })
      })
    })
  }

  /** Calls fn when every animation of the greeting has ended. */
  function settled(fn) {
    var running = welcome.getAnimations ? welcome.getAnimations({ subtree: true }) : []
    Promise.all(
      running.map(function (animation) {
        return animation.finished.catch(function () {})
      })
    ).then(fn)
  }

  // ── Failure ──

  /**
   * The end of the road: the service is what the app connects through, so there is nothing to hand
   * over to. The screen keeps the list — which step broke is half the answer — and says what broke.
   */
  function fail(index, message) {
    clearTimers()
    // The one time the seamless update has something to say: the steps and the reason come back.
    setup.classList.remove('seamless')
    setup.dataset.phase = 'failed'
    if (steps[index]) steps[index].dataset.state = 'failed'
    setSub(mode === 'update' ? 'Обновление не удалось' : 'Установка не удалась')
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
        if (picked) setPath(picked)
      })
      return
    }
    // No dialog in a browser: walk through paths that look like the ones people actually pick.
    var samples = [DEFAULT_PATH, 'D:\\Programs\\SenAWG', 'C:\\Users\\User\\AppData\\Local\\SenAWG']
    var next = samples.indexOf(pathInput.value) + 1
    setPath(samples[next % samples.length])
  }

  function setPath(value) {
    pathInput.value = value
    showAppDir()
  }

  /**
   * The application always goes into a folder called SenAWG (awg-helper's setup.AppDir does the same):
   * picking D:\Programs must not scatter its files among everything else there, or uninstalling could not
   * tell them from the user's own. Said out loud, so the path in the field is not a surprise later.
   */
  function appDirOf(picked) {
    var p = picked.replace(/^\s+|[\s\\/]+$/g, '')
    if (!p) return ''
    var name = p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1)
    return name.toLowerCase() === 'senawg' ? p : p + '\\SenAWG'
  }

  function showAppDir() {
    var dir = appDirOf(pathInput.value)
    pathNote.textContent = dir ? 'Программа: ' + dir : ''
    pathNote.title = dir
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
    if (!bridge) return rehearse()
    bridge.install(path).then(
      function (result) {
        if (result && result.cancelled) backToChoice()
      },
      function (err) {
        // The call itself broke (not the install): still an ending the screen has to show.
        fail(0, err && err.message ? err.message : 'Не удалось начать установку.')
      }
    )
  }

  /** Which panel the install button was pressed on: where a declined prompt returns to. */
  var choiceMadeOn = 'intro'

  /**
   * The administrator prompt was declined: nothing was touched, so nothing is said either. The ring
   * leaves the way it came, and the screen is the choice again, as if the button had not been pressed.
   */
  function backToChoice() {
    clearTimers()
    setup.classList.add('ring-off')
    setup.dataset.phase = 'intro'
    showPanel(choiceMadeOn)
    after(cssMs('--t-fade'), function () {
      setup.classList.remove('ring-on', 'ring-off')
      setProgress(0, 0)
      startedAt = Date.now()
    })
  }

  // ── Whole screen ──

  function reset() {
    clearTimers()
    stage.classList.remove('setup-leaving', 'setup-done')
    welcome.classList.remove('on', 'settled')
    // The application's own greeting for someone whose servers are still here (Welcome.tsx, `back`):
    // no key to ask for, so no field; the note that the keys are safe comes with the application itself.
    welcome.classList.toggle('welcome-back', returning)
    welcomeTitle.textContent = returning ? 'С возвращением!' : 'Приветствую вас!'
    setup.dataset.phase = 'intro'
    setup.dataset.mode = mode
    setup.classList.toggle('seamless', seamless)
    setup.classList.remove('ring-on', 'ring-off')
    showPanel('intro')
    choiceMadeOn = 'intro'
    setPath(installPath)
    if (mode === 'update') {
      introTitle.textContent = 'Обновление'
      introSub.textContent = 'SenAWG уже установлен. Обновим его до этой версии.'
      expressLabel.textContent = 'Обновить'
    } else {
      introTitle.textContent = 'Добро пожаловать!'
      introSub.textContent = 'Установим SenAWG на этот компьютер.'
      expressLabel.textContent = 'Быстрая установка'
    }
    logo.style.transition = ''
    logo.style.transform = ''
    logo.style.opacity = ''
    steps.forEach(function (step) {
      step.dataset.state = 'pending'
    })
    setProgress(0, 0)
    setSubNow(mode === 'update' ? 'Обновление' : 'Установка')
    error.textContent = ''
    document.title = (mode === 'update' ? 'Обновление' : 'Установка') + ' SenAWG'
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
        fail(1, 'Не удалось установить службу SenAWG (код 5). Без неё приложение не сможет подключаться.')
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
  if (bridge && bridge.buildId) foot.textContent = bridge.buildId
  // In a browser `?mode=update` (or the dev bar) plays the update; in the app the bridge says which it is.
  var mode = bridge && bridge.mode ? bridge.mode : /[?&]mode=update\b/.test(location.search) ? 'update' : 'install'
  // `?auto=1` in a browser. Only an update can be started for the user: a first install still asks where to.
  var auto = mode === 'update' && (bridge ? Boolean(bridge.auto) : /[?&]auto=1\b/.test(location.search))
  // `?seamless=1` in a browser. Only an update the application started can be seamless.
  var seamless = mode === 'update' && (bridge ? Boolean(bridge.seamless) : /[?&]seamless=1\b/.test(location.search))
  // `?back=1` in a browser. Only a fresh install greets anyone: an update ends on the application itself.
  var returning = mode === 'install' && (bridge ? Boolean(bridge.returning) : /[?&]back=1\b/.test(location.search))

  document.getElementById('express').addEventListener('click', function () {
    choiceMadeOn = 'intro'
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
  pathInput.addEventListener('input', showAppDir)
  document.getElementById('install').addEventListener('click', function () {
    var chosen = pathInput.value.trim()
    if (!chosen) return
    choiceMadeOn = 'path'
    begin(chosen)
  })

  reset()
  // Declining the administrator prompt still lands on the question, with «Обновить» to try again.
  if (auto) begin(installPath)

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
      },
      setMode: function (value) {
        mode = value
        reset()
      },
      setReturning: function (value) {
        returning = value
        reset()
      },
      /** The update the application started without closing first: only the logo, then the new application. */
      setSeamless: function (value) {
        seamless = value
        if (value) mode = 'update'
        reset()
      },
      /** «Перезапустить и обновить» in the application: the update screen that asks nothing. */
      fromApp: function () {
        mode = 'update'
        reset()
        begin(installPath)
      },
      /** Rehearsal of declining the administrator prompt. */
      cancelNow: function () {
        reset()
        enterWork(installPath)
        at(1400, backToChoice)
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
