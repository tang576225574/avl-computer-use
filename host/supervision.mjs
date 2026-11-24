import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connect } from 'node:net'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'

const exec = promisify(execFile)
const dependencies = {
  x11: [], dbus: [], sshd: [], xfce: ['x11', 'dbus'], novnc: ['x11'],
  wm: ['xfce'], panel: ['xfce'], terminal: ['xfce'], capture: ['x11'],
}
const order = Object.keys(dependencies)
const runRepair = execute => execute()

function banner(port, prefix) {
  return new Promise(resolve => {
    const socket = connect({host:'127.0.0.1', port})
    let bytes = ''
    const end = value => { socket.destroy(); resolve(value) }
    socket.setTimeout(1000, () => end(false))
    socket.on('data', chunk => {
      bytes += chunk.toString('ascii')
      if (bytes.length >= prefix.length) end(bytes.startsWith(prefix))
    })
    socket.once('close', () => resolve(false))
    socket.once('error', () => end(false))
  })
}

function localDesktop(signal) {
  const children = new Map()
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/TOKEN|PASSWORD|_PW$|API_KEY|SECRET/i.test(key)) delete env[key]
  }
  const display = env.DISPLAY || ':1'
  const runtime = env.XDG_RUNTIME_DIR
  const novnc = env.NOVNC_HOME || '/usr/libexec/noVNCdim'
  const port = env.VNC_PORT || '5902', web = env.NOVNC_PORT || '6902'
  const uid = String(process.getuid())
  const matches = async name => {
    try {
      const {stdout} = await exec('/usr/bin/pgrep', ['-u',uid,'-x',name], {env,timeout:1000,signal})
      for (const pid of stdout.trim().split(/\s+/)) {
        const data = await readFile('/proc/'+pid+'/environ').catch(() => Buffer.alloc(0))
        if (data.toString().split('\0').some(value => value.startsWith('DISPLAY=') &&
          value.slice(8).replace(/\.0$/,'') === display.replace(/\.0$/,''))) return true
      }
    } catch { /* A process may disappear while its environment is read. */ }
    return false
  }
  const commands = {
    x11: ['/usr/bin/Xvnc', display, '-auth',env.XAUTHORITY, '-geometry',env.VNC_RESOLUTION || '1920x1080',
      '-depth',env.VNC_COL_DEPTH || '24', '-rfbport',port, '-localhost', '-nolisten','tcp',
      '-SecurityTypes','VncAuth','-PasswordFile',resolve(runtime,'vnc.passwd'),'-AcceptKeyEvents=0','-AcceptPointerEvents=0',
      '-AcceptCutText=0','-SendCutText=0','-SetPrimary=0','-SendPrimary=0'],
    dbus: ['/usr/bin/dbus-daemon','--session','--nofork','--address='+env.DBUS_SESSION_BUS_ADDRESS],
    xfce: ['/usr/bin/xfce4-session'],
    wm: ['/usr/bin/xfwm4','--replace'],
    panel: ['/usr/bin/xfce4-panel'],
    terminal: ['/usr/bin/xfce4-terminal','--disable-server'],
    novnc: [resolve(novnc,'utils/websockify/run'),'--web',novnc,'127.0.0.1:'+web,'127.0.0.1:'+port],
  }
  const owns = name => {
    const proc = children.get(name)
    return proc && proc.exitCode === null && proc.signalCode === null
  }
  async function stop(name) {
    const proc = children.get(name)
    if (!proc?.pid || !owns(name)) return
    const exited = new Promise(done => proc.once('exit',done))
    proc.kill('SIGTERM')
    await Promise.race([exited,delay(1000,undefined,{ref:false})])
    if (owns(name)) {
      proc.kill('SIGKILL')
      await Promise.race([exited,delay(1000,undefined,{ref:false})])
      if (owns(name)) throw Error('Previous desktop process is still exiting')
    }
  }
  const probes = {
    x11: async () => Boolean(owns('x11') && await banner(Number(port),'RFB ') &&
      await exec('/usr/bin/xset',['q'],{env,timeout:1500,signal})),
    dbus: async () => Boolean(owns('dbus') && await exec('/usr/bin/gdbus',['call','--session','--dest',
      'org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.ListNames'],
      {env,timeout:1500,signal})),
    xfce: () => matches('xfce4-session'),
    wm: () => matches('xfwm4'),
    panel: () => matches('xfce4-panel'),
    terminal: () => matches('xfce4-terminal'),
    novnc: async () => {
      if (!owns('novnc')) return false
      const response = await fetch('http://127.0.0.1:'+web+'/vnc.html', {
        method:'HEAD', signal:AbortSignal.any([signal,AbortSignal.timeout(1500)]), redirect:'error',
      })
      return response.ok
    },
    sshd: async () => {
      const pid = (await readFile('/run/sshd/avl.pid','utf8')).trim()
      if (!/^\d+$/.test(pid) || (await readFile('/proc/'+pid+'/comm','utf8')).trim() !== 'sshd') return false
      return banner(Number(env.AVL_SSHD_PORT || 22),'SSH-')
    },
  }
  return {
    async probe(name) { try { return await probes[name]() } catch { return false } },
    async recover(name) {
      if (name === 'sshd') {
        await exec('/usr/bin/sudo',['-n','-u','avl-ops','--','/usr/local/libexec/avl/ops-sshd'], {
          env, signal, timeout:6000, maxBuffer:8192,
        })
        return
      }
      await stop(name)
      signal.throwIfAborted()
      const [file,...args] = commands[name]
      const proc = spawn(file,args,{env,stdio:['ignore','inherit','inherit']})
      children.set(name,proc)
      await new Promise((done,fail) => { proc.once('spawn',done); proc.once('error',fail) })
    },
    async close() { await Promise.all([...children.keys()].map(stop)) },
  }
}

export function createSupervision({
  capture, onChange = () => {}, enabled = process.env.AVL_MANAGE_DESKTOP === '1',
  interval = 5000, system, tryAutoRepair = runRepair,
} = {}) {
  const lifetime = new AbortController()
  if (enabled) system ??= localDesktop(lifetime.signal)
  let current = {enabled,state:enabled ? 'checking' : 'disabled',components:{}}
  const counts = new Map(), attempts = new Map()
  let running, timer, closed = false
  function publish(components) {
    const states = Object.values(components).map(c => c.state)
    const state = ['failed','recovering','degraded','checking'].find(s => states.includes(s)) ?? 'healthy'
    const next = {enabled,state,components}
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      current = next
      onChange(current)
    }
  }
  async function cycle(prefer, submitRepair) {
    const components = {}, health = {}
    await Promise.all(order.map(async name => {
      if (name === 'capture') health[name] = !capture?.wanted() || await capture.healthy()
      else health[name] = await system.probe(name)
    }))
    if (closed) return
    const eligible = []
    for (const name of order) {
      const waiting = dependencies[name].some(dep => !health[dep])
      const idle = name === 'capture' && !capture?.wanted()
      if (idle || waiting || health[name]) {
        counts.delete(name); attempts.delete(name)
        components[name] = { state:idle ? 'idle' : waiting ? 'waiting' : 'healthy', attempts:0 }
        continue
      }
      const count = (counts.get(name) || 0)+1, tried = attempts.get(name) || 0
      counts.set(name,count)
      components[name] = {state:tried >= 3 ? 'failed' : 'degraded', attempts:tried}
      if (count >= 2 && tried < 3) eligible.push(name)
    }
    const repair = eligible.includes(prefer) ? prefer : eligible[0]
    if (repair) {
      await submitRepair(async () => {
        const tried = (attempts.get(repair) || 0)+1
        attempts.set(repair,tried)
        components[repair] = {state:'recovering',attempts:tried}
        try {
          if (repair === 'capture') await capture.restart()
          else await system.recover(repair)
        } catch {
          components[repair] = {state: tried >= 3 ? 'failed' : 'degraded',attempts:tried,detail:'repair command failed'}
        }
      })
    }
    if (!closed) publish(components)
  }
  function check(prefer, submitRepair = tryAutoRepair) {
    if (closed || !enabled) return Promise.resolve()
    return running ??= cycle(prefer,submitRepair).finally(() => {running = undefined})
  }
  return {
    snapshot: () => current,
    check,
    async start() {
      if (!enabled || closed || timer) return
      timer = setInterval(() => { void check().catch(() => {}) },interval)
      timer.unref()
      await check()
    },
    async request(name) {
      if (!enabled || closed) throw Error('Desktop supervision is disabled')
      if (!order.includes(name)) throw Error('Unknown desktop component')
      // The tool caller already holds the desktop maintenance reservation.
      await check(name,runRepair)
      return current.components[name]
    },
    async close() {
      closed = true; clearInterval(timer); lifetime.abort()
      await running?.catch(() => {})
      await system?.close?.()
    },
  }
}
