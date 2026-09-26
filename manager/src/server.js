import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRequest } from './catalog.js'
import { handleManagement, readBody, sendJson } from './manage.js'
import { createMetrics, templatePath } from './metrics.js'
import { createNeeded } from './needed.js'
import { seedCatalog } from './seed.js'
import { createStore } from './store.js'
import { createUpstream } from './upstream.js'

const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-encoding',
  'authorization',
])

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range',
  'access-control-expose-headers': 'Content-Length,Content-Range',
}

export function createApp(options) {
  const token = options.token || ''
  if (token.length < 16) {
    throw new Error('MANAGEMENT_TOKEN must be at least 16 characters')
  }
  const dataDir = options.dataDir
  const store = createStore(dataDir)
  const upstream = createUpstream(options.upstreamUrl, {
    ttlMs: (options.cacheTtlSeconds ?? 300) * 1000,
  })
  const metrics = createMetrics(dataDir)
  const needed = createNeeded(dataDir)
  const publicDir = options.publicDir || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
  const ctx = { store, upstream, metrics, needed, token, publicDir, dataDir }

  const server = http.createServer(async (req, res) => {
    const started = Date.now()
    try {
      if (urlPath(req.url) === '/healthz') {
        sendJson(res, 200, { status: 'ok' })
        return
      }
      if (await handleManagement(req, res, ctx)) return

      const url = new URL(req.url, 'http://manager.local')
      if (req.method === 'OPTIONS') {
        res.writeHead(200, { ...CORS, 'content-length': 2 })
        res.end('ok')
        record(metrics, req, url, 200, started, 'upstream')
        return
      }

      const resolved = await resolveRequest({
        method: req.method,
        targetUrl: req.url,
        store,
        fetchUpstream: (target) => upstream.request(target.pathname, target.search),
      })
      if (resolved) {
        writeResolved(req, res, resolved)
        record(metrics, req, url, resolved.status, started, resolved.source)
        return
      }

      const status = await proxy(req, res, options.upstreamUrl)
      record(metrics, req, url, status, started, 'upstream')
    } catch (error) {
      if (res.headersSent) return
      const status = error.status || 502
      sendJson(res, status, {
        type: 'https://tcgdex.dev/errors/general',
        title: status === 413 ? 'Payload too large' : 'The upstream TCGdex server is unavailable',
        status,
      })
      try {
        record(metrics, req, new URL(req.url, 'http://manager.local'), status, started, 'upstream')
      } catch {
        // Metrics must not hide the response already sent above.
      }
    }
  })

  return { server, store, metrics, upstream }
}

function urlPath(value) {
  return value.split('?')[0]
}

function writeResolved(req, res, resolved) {
  const payload = Buffer.from(JSON.stringify(resolved.body ?? null))
  const headers = {
    ...CORS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': resolved.source === 'upstream' ? 'public, max-age=300' : 'public, max-age=30',
    'x-content-type-options': 'nosniff',
  }
  res.writeHead(resolved.status, headers)
  res.end(req.method === 'HEAD' ? undefined : payload)
}

async function proxy(req, res, upstreamUrl) {
  const url = new URL(req.url, 'http://manager.local')
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP.has(key) || value == null) continue
    headers[key] = Array.isArray(value) ? value.join(', ') : value
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const body = hasBody ? await readBody(req, 2_000_000) : undefined
  const response = await fetch(`${upstreamUrl.replace(/\/$/, '')}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body: body && body.length ? body : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(60000),
  })
  const responseHeaders = {}
  response.headers.forEach((value, key) => {
    if (HOP.has(key)) return
    responseHeaders[key] = value
  })
  const payload = Buffer.from(await response.arrayBuffer())
  responseHeaders['content-length'] = payload.length
  res.writeHead(response.status, responseHeaders)
  res.end(req.method === 'HEAD' ? undefined : payload)
  return response.status
}

function record(metrics, req, url, status, started, source) {
  metrics.record({
    method: req.method,
    path: `${url.pathname}${url.search}`.slice(0, 300),
    template: templatePath(url.pathname),
    status,
    ms: Date.now() - started,
    source,
  })
}

export function listen(options) {
  const app = createApp(options)
  const port = options.port ?? 8080
  const host = options.host ?? '0.0.0.0'
  return new Promise((resolve) => {
    app.server.listen(port, host, () => {
      const address = app.server.address()
      resolve({ ...app, port: typeof address === 'object' ? address.port : port })
    })
  })
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const port = Number.parseInt(process.env.PORT || '8080', 10)
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')
  seedCatalog(dataDir)
  listen({
    token: process.env.MANAGEMENT_TOKEN || '',
    dataDir,
    upstreamUrl: process.env.UPSTREAM_URL || 'http://127.0.0.1:3000',
    cacheTtlSeconds: Number.parseInt(process.env.UPSTREAM_CACHE_TTL || '300', 10),
    port,
    host: '0.0.0.0',
  }).then((app) => {
    console.log(`tcgdex manager listening on :${app.port}`)
  }).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
