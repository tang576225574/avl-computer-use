import assert from 'node:assert/strict'
import test from 'node:test'
import { createSupervision } from '../host/supervision.mjs'

function fixture(options = {}) {
  const bad = new Set(), repairs = []
  const monitor = createSupervision({
    enabled: true, interval: 600_000,
    system: {
      async probe(name) { return !bad.has(name) },
      async recover(name) { repairs.push(name) }, close() {},
    },
    capture: { wanted: () => false },
    ...options,
  })
  return { monitor, bad, repairs }
}

test('two observations precede bounded recovery; X11 dependencies wait', async () => {
  const { monitor, bad, repairs } = fixture()
  for (const name of ['x11','xfce','wm','panel','terminal','novnc']) bad.add(name)
  await monitor.start()
  assert.deepEqual(repairs, [])
  assert.equal(monitor.snapshot().components.terminal.state, 'waiting')
  for (let i=0; i<7; i++) await monitor.check()
  assert.deepEqual(repairs, ['x11','x11','x11'])
  assert.equal(monitor.snapshot().state, 'failed')
  bad.clear()
  await monitor.check()
  assert.equal(monitor.snapshot().state, 'healthy')
  await monitor.close()
})

test('simultaneous requests share one repair; idle capture stays idle', async () => {
  const { monitor, bad, repairs } = fixture()
  await monitor.start()
  bad.add('sshd')
  await monitor.check()
  await Promise.all([monitor.request('sshd'), monitor.request('sshd')])
  assert.deepEqual(repairs, ['sshd'])
  assert.equal(monitor.snapshot().components.capture.state, 'idle')
  await assert.rejects(monitor.request('bash'))
  await monitor.close()
})

test('unmanaged development never examines or restarts desktop processes', async () => {
  const monitor = createSupervision({ enabled:false, system: { probe:assert.fail, recover:assert.fail } })
  await monitor.start()
  assert.equal(monitor.snapshot().state, 'disabled')
  await assert.rejects(monitor.request('x11'))
  await monitor.close()
})

test('busy desktop defers automatic repairs while health checks continue', async t => {
  let busy = true
  const { monitor, bad, repairs } = fixture({ tryAutoRepair: execute => busy ? false : execute() })
  t.after(() => monitor.close())
  bad.add('terminal')
  await monitor.start()
  for (let i = 0; i < 4; i++) await monitor.check()
  assert.deepEqual(repairs, [])
  assert.deepEqual(monitor.snapshot().components.terminal, {state:'degraded', attempts:0})
  bad.add('panel')
  await monitor.check()
  assert.equal(monitor.snapshot().components.panel.state, 'degraded')
  bad.delete('panel')
  busy = false
  await monitor.check()
  assert.deepEqual(repairs, ['terminal'])
  assert.deepEqual(monitor.snapshot().components.terminal, {state:'recovering', attempts:1})
})

test('manual repair uses its existing authorization and reports physical failure', async t => {
  const { monitor } = fixture({
    tryAutoRepair: () => false,
    capture: {
      wanted: () => true,
      healthy: () => false,
      restart: () => { throw Error('capture unavailable') },
    },
  })
  t.after(() => monitor.close())
  await monitor.start()
  await monitor.check()
  assert.equal(monitor.snapshot().components.capture.attempts, 0)
  const result = await monitor.request('capture')
  assert.deepEqual(result, {state:'degraded', attempts:1, detail:'repair command failed'})
})
