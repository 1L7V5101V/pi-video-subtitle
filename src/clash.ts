import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'

/**
 * Minimal Clash / mihomo controller client.
 *
 * Exists so a retry can rotate the proxy node: some machines reach YouTube only
 * through a Clash node whose exit IP is flagged by YouTube's bot gate, and
 * switching to another node of the same subscription often fixes it.
 *
 * Discovery order (all lazy, all cached):
 *   1. `PI_SUBTITLE_CLASH_CTRL` — explicit controller (`http://127.0.0.1:9097`
 *      or a Windows named pipe path `\\.\pipe\name`).
 *   2. Clash Verge Rev config files (`%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\`)
 *      → `external-controller-pipe` (with sidecar/production variants) and
 *      `external-controller` TCP, plus the `secret`.
 *   3. Enumerate `\\.\pipe\` via PowerShell for `verge-mihomo-*` pipes.
 *
 * The HTTP conversation uses HTTP/1.0 over a raw socket so the server answers
 * without chunked transfer-encoding (which the named pipe otherwise uses).
 */

export interface ClashController {
  kind: 'tcp' | 'pipe'
  target: string
  secret: string
}

/** Nodes that are not real exit nodes and must never be selected. */
const CLASH_SKIP = /^(DIRECT|REJECT|REJECT-DROP|REJECT-DROP-QUIC|PASS|COMPATIBLE|LOAD-BALANCE)$/i

const DEFAULT_SECRET = 'set-your-secret'
const CLAH_VERGE_DIR = process.env.APPDATA
  ? join(process.env.APPDATA, 'io.github.clash-verge-rev.clash-verge-rev')
  : null

function env(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined ? undefined : value.trim() || undefined
}

/** Retry+rotation can be disabled wholesale with PI_SUBTITLE_CLASH=0. */
export function clashEnabled(): boolean {
  return env('PI_SUBTITLE_CLASH') !== '0'
}

function rawRequest(
  ctrl: ClashController,
  method: string,
  path: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    let socket: net.Socket
    try {
      socket = ctrl.kind === 'pipe' ? net.connect(ctrl.target) : net.connect({ host: '127.0.0.1', port: Number(ctrl.target.split(':')[1] ?? 9097) })
    } catch {
      resolve({ status: 0, body: '' })
      return
    }
    let out = ''
    const done = () => {
      socket.destroy()
      const headerEnd = out.indexOf('\r\n\r\n')
      if (headerEnd === -1) {
        resolve({ status: 0, body: out })
        return
      }
      const head = out.slice(0, headerEnd)
      const status = Number(head.split(' ')[1] ?? 0)
      resolve({ status, body: out.slice(headerEnd + 4) })
    }
    socket.setTimeout(5000, () => done())
    socket.on('error', () => done())
    socket.on('connect', () => {
      const body = payload ? JSON.stringify(payload) : ''
      const lines = [`${method} ${path} HTTP/1.0`, 'Host: localhost']
      if (ctrl.secret) lines.push(`Authorization: Bearer ${ctrl.secret}`)
      if (body) lines.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`)
      socket.write(lines.join('\r\n') + '\r\n\r\n' + body)
    })
    socket.on('data', (chunk) => (out += chunk))
    socket.on('close', done)
  })
}

async function probe(ctrl: ClashController): Promise<boolean> {
  const res = await rawRequest(ctrl, 'GET', '/version')
  if (res.status !== 200) return false
  try {
    return typeof (JSON.parse(res.body) as { version?: unknown }).version === 'string'
  } catch {
    return false
  }
}

let cachedController: ClashController | null | undefined

/** Discover a reachable Clash controller, or null (cached per process). */
export async function discoverClashController(): Promise<ClashController | null> {
  if (!clashEnabled()) return null
  if (cachedController !== undefined) return cachedController
  cachedController = await discover()
  return cachedController
}

async function discover(): Promise<ClashController | null> {
  const explicit = env('PI_SUBTITLE_CLASH_CTRL')
  if (explicit) {
    for (const candidate of [explicit, explicit.startsWith('http') ? explicit.replace(/^https?:\/\//, '') : `http://${explicit}`]) {
      const kind = candidate.includes('://') ? 'tcp' : candidate.startsWith('\\') ? 'pipe' : 'tcp'
      const target = candidate.includes('://') ? candidate.replace(/^https?:\/\//, '') : candidate
      const ctrl: ClashController = { kind, target, secret: env('PI_SUBTITLE_CLASH_SECRET') ?? DEFAULT_SECRET }
      if (await probe(ctrl)) return ctrl
    }
    return null
  }

  const secrets: string[] = []
  const pipes: string[] = []
  const tcpTargets: string[] = []
  if (CLAH_VERGE_DIR) {
    for (const file of ['config.yaml', 'clash-verge.yaml']) {
      try {
        const text = await readFile(join(CLAH_VERGE_DIR, file), 'utf8')
        const secret = /\nsecret:\s*"?([^\s"\n]+)/.exec(text)?.[1]
        if (secret) secrets.push(secret)
        const pipe = /\nexternal-controller-pipe:\s*(\S+)/.exec(text)?.[1]
        if (pipe) pipes.push(pipe)
        const tcp = /\nexternal-controller:\s*"?([^"\s]+)"?/.exec(text)?.[1]
        if (tcp && !tcp.startsWith("'")) tcpTargets.push(tcp)
      } catch {
        // missing config files are fine — try the next candidate
      }
    }
  }

  // The running instance is often the `production` sidecar while the config
  // files mention `sidecar` (or vice versa), so try both spellings.
  const pipeCandidates = [
    ...new Set(pipes.flatMap((p) => [p, p.replace(/sidecar/g, 'production'), p.replace(/production/g, 'sidecar')])),
  ]
  const tcpCandidates = [...new Set([...tcpTargets, '127.0.0.1:9097', '127.0.0.1:9090', '127.0.0.1:9091'])]
  const secret = secrets[0] ?? DEFAULT_SECRET

  for (const pipe of pipeCandidates) {
    if (!pipe.startsWith('\\\\.\\pipe\\')) continue
    const ctrl: ClashController = { kind: 'pipe', target: pipe, secret }
    if (await probe(ctrl)) return ctrl
  }
  for (const target of tcpCandidates) {
    const ctrl: ClashController = { kind: 'tcp', target, secret }
    if (await probe(ctrl)) return ctrl
  }

  // Last resort: enumerate the pipe namespace.
  const psResult = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', "[System.IO.Directory]::GetFiles('\\\\.\\pipe\\')"],
    { encoding: 'utf8', timeout: 15000 },
  )
  for (const line of (psResult.stdout ?? '').split('\n')) {
    const name = line.trim()
    if (!/verge-mihomo-(production|sidecar)/.test(name)) continue
    const ctrl: ClashController = { kind: 'pipe', target: name, secret }
    if (await probe(ctrl)) return ctrl
  }
  return null
}

async function clashRequest(ctrl: ClashController, method: string, path: string, payload?: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const res = await rawRequest(ctrl, method, path, payload)
  if (res.status === 0) throw new Error('Clash 控制器连接失败。')
  if (!res.body) return { status: res.status, body: undefined }
  try {
    return { status: res.status, body: JSON.parse(res.body) as unknown }
  } catch {
    return { status: res.status, body: res.body }
  }
}

/** The routing group: the outermost chain entry of any active connection. */
export async function clashRoutingGroup(ctrl: ClashController): Promise<string | null> {
  if (env('PI_SUBTITLE_CLASH_GROUP')) return env('PI_SUBTITLE_CLASH_GROUP') as string
  const res = await clashRequest(ctrl, 'GET', '/connections')
  if (res.status !== 200) return null
  const connections = (res.body as { connections?: { chains?: string[] }[] }).connections ?? []
  for (const connection of connections) {
    const chains = connection.chains
    if (Array.isArray(chains) && chains.length >= 2) return chains[chains.length - 1]
  }
  return null
}

export interface ClashGroupInfo {
  all: string[]
  now?: string
}

export async function clashGroup(ctrl: ClashController, group: string): Promise<ClashGroupInfo | null> {
  const res = await clashRequest(ctrl, 'GET', `/proxies/${encodeURIComponent(group)}`)
  if (res.status !== 200) return null
  const body = res.body as Partial<ClashGroupInfo>
  if (!Array.isArray(body.all)) return null
  return { all: body.all, now: body.now }
}

/**
 * Pick the next usable node in the group, cycling from the currently selected
 * one and skipping anything already tried in this request.
 */
export function clashPickNext(all: string[], now: string | undefined, tried: ReadonlySet<string>): string | null {
  const usable = all.filter((node) => !CLASH_SKIP.test(node) && !tried.has(node))
  if (usable.length === 0) return null
  const index = now !== undefined ? usable.indexOf(now) : -1
  return usable[(index + 1) % usable.length]
}

export async function clashSelectNode(ctrl: ClashController, group: string, node: string): Promise<boolean> {
  const res = await clashRequest(ctrl, 'PUT', `/proxies/${encodeURIComponent(group)}`, { name: node })
  return res.status >= 200 && res.status < 300
}