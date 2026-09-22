/*
 * Browser-only harness for the setup screen: a window of the app's real size, and the controls
 * needed to watch the animation again, slower, or from its last beat. installer.js loads this file
 * only when the setup bridge is missing, so it never runs in the packaged app.
 */
;(function () {
  'use strict'

  var api = window.__setupPreview
  var app = document.querySelector('.app')
  if (!api || !app) return

  document.body.classList.add('pv')

  // ── The window ──

  var frame = document.createElement('div')
  frame.className = 'pv-window'
  var title = document.createElement('div')
  title.className = 'pv-title'
  title.innerHTML = '<span></span><b>—</b><b>▢</b><b>✕</b>'
  // The window is renamed the moment it stops being the installer; the mock follows.
  var caption = title.firstElementChild
  caption.textContent = document.title
  new MutationObserver(function () {
    caption.textContent = document.title
  }).observe(document.querySelector('title'), { childList: true })
  app.parentNode.insertBefore(frame, app)
  frame.appendChild(title)
  frame.appendChild(app)

  // ── The controls ──

  var bar = document.createElement('div')
  bar.className = 'pv-bar'
  document.body.appendChild(bar)

  function button(label, onClick) {
    var el = document.createElement('button')
    el.type = 'button'
    el.textContent = label
    el.addEventListener('click', onClick)
    bar.appendChild(el)
    return el
  }

  function group() {
    var el = document.createElement('div')
    el.className = 'pv-group'
    bar.appendChild(el)
    return el
  }

  button('Ещё раз', function () {
    api.play()
  })
  button('Быстрая машина', function () {
    api.burst()
  })
  button('Сбой', function () {
    api.failNow()
  })
  button('Отказ от UAC', function () {
    api.cancelNow()
  })
  button('К финалу', function () {
    api.finishNow()
  })
  var updating = button('Обновление', function () {
    var on = updating.getAttribute('aria-pressed') !== 'true'
    updating.setAttribute('aria-pressed', String(on))
    api.setMode(on ? 'update' : 'install')
  })
  updating.setAttribute('aria-pressed', 'false')
  button('Из приложения', function () {
    updating.setAttribute('aria-pressed', 'true')
    api.fromApp()
  })

  var speeds = group()
  var speedButtons = []
  ;[0.5, 1, 2].forEach(function (value) {
    var el = document.createElement('button')
    el.type = 'button'
    el.textContent = '×' + value
    el.setAttribute('aria-pressed', String(value === 1))
    el.addEventListener('click', function () {
      api.setSpeed(value)
      speedButtons.forEach(function (other) {
        other.setAttribute('aria-pressed', String(other === el))
      })
      api.play()
    })
    speeds.appendChild(el)
    speedButtons.push(el)
  })

  // Overrides the system setting in both directions, so both readings can be checked from here.
  var reduced = button('Сокращённая анимация', function () {
    var on = document.documentElement.getAttribute('data-motion') !== 'reduce'
    document.documentElement.setAttribute('data-motion', on ? 'reduce' : 'full')
    reduced.setAttribute('aria-pressed', String(on))
    api.play()
  })
  reduced.setAttribute('aria-pressed', 'false')

  // Re-parenting the app restarted its entrance animations; play the timeline from the top.
  api.play()
})()
