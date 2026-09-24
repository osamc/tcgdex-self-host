import fs from 'node:fs'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { IMAGE_TYPES, publicAssetPath, publicAssetUrl, resolveImageFile, safeImageRelPath, writeImageFile } from './images.js'
import { isLanguage } from './languages.js'
import { isSafeId, isSafeLocalId, validateCard, validateSerie, validateSet } from './store.js'

const VALIDATORS = {
  cards: validateCard,
  sets: validateSet,
  series: validateSerie,
}

export function tokensMatch(provided, expected) {
  const left = Buffer.from(String(provided || ''))
  const right = Buffer.from(String(expected || ''))
  if (left.length !== right.length) {
    timingSafeEqual(right, right)
    return false
  }
  return timingSafeEqual(left, right)
}

export function bearerToken(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

/**
 * @returns {Promise<boolean>} true when the request was handled
 */
export async function handleManagement(req, res, ctx) {
  const url = new URL(req.url, 'http://manager.local')
  if (url.pathname === '/assets' || url.pathname.startsWith('/assets/')) {
    serveImage(req, url.pathname, ctx, res)
    return true
  }
  if (url.pathname !== '/manage' && !url.pathname.startsWith('/manage/')) return false

  if (url.pathname === '/manage' || url.pathname === '/manage/') {
    return sendFile(ctx.publicDir, 'index.html', res)
  }
  if (url.pathname === '/manage/app.js') return sendFile(ctx.publicDir, 'app.js', res)
  if (url.pathname === '/manage/style.css') return sendFile(ctx.publicDir, 'style.css', res)

  if (!url.pathname.startsWith('/manage/api/')) {
    sendJson(res, 404, { error: 'not found' })
    return true
  }

  if (!tokensMatch(bearerToken(req), ctx.token)) {
    sendJson(res, 401, { error: 'unauthorized' })
    return true
  }

  const parts = url.pathname.split('/').filter(Boolean)
  // manage / api / ...
  const action = parts[2]

  if (req.method === 'GET' && action === 'health') {
    const upstream = await ctx.upstream.ping()
    sendJson(res, 200, { upstream: upstream ? 'up' : 'down' })
    return true
  }
  if (req.method === 'GET' && action === 'metrics') {
    sendJson(res, 200, { ...ctx.metrics.snapshot(), upstream: (await ctx.upstream.ping()) ? 'up' : 'down' })
    return true
  }
  if (req.method === 'GET' && action === 'catalog') {
    sendJson(res, 200, ctx.store.list())
    return true
  }
  if (req.method === 'POST' && action === 'import') {
    await handleImport(req, res, ctx)
    return true
  }
  if (action === 'images' && parts[3] && req.method === 'PUT') {
    await handleImageUpload(parts.slice(3).join('/'), req, res, ctx)
    return true
  }
  if (['cards', 'sets', 'series'].includes(action)) {
    await handleCatalogWrite(action, parts[3], parts[4], req, res, ctx)
    return true
  }

  sendJson(res, 404, { error: 'not found' })
  return true
}

async function handleCatalogWrite(kind, lang, id, req, res, ctx) {
  if (!isLanguage(lang) || !isSafeId(id || '')) {
    sendJson(res, 400, { error: 'language or id is invalid' })
    return
  }
  if (req.method === 'GET') {
    const found = ctx.store.get(kind, lang, id)
    if (!found) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    sendJson(res, 200, found)
    return
  }
  if (req.method === 'DELETE') {
    const removed = ctx.store.remove(kind, lang, id)
    sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'not found' })
    return
  }
  if (req.method !== 'PUT') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  const body = await readJson(req, res)
  if (body == null) return
  const errors = VALIDATORS[kind](body)
  if (String(body.id).toLowerCase() !== id.toLowerCase()) errors.push('id in the body must match the URL')
  if (errors.length) {
    sendJson(res, 400, { error: 'invalid definition', details: errors })
    return
  }
  const saved = await annotate(kind, lang, id, body, ctx.upstream)
  ctx.store.put(kind, lang, saved.id, saved)
  sendJson(res, 200, saved)
}

async function annotate(kind, lang, id, body, upstream) {
  const saved = { ...body }
  delete saved._meta
  delete saved._lang
  if (kind === 'cards' && typeof saved.image === 'string') {
    const image = publicAssetUrl(saved.image.trim())
    if (image) saved.image = image
    else delete saved.image
  }
  for (const key of ['logo', 'symbol']) {
    if (typeof saved[key] === 'string') {
      const media = publicAssetUrl(saved[key].trim())
      if (media) saved[key] = media
      else delete saved[key]
    }
  }
  let upstreamHit = false
  let upstreamSetId = null
  try {
    const existing = await upstream.request(`/v2/${lang}/${kind === 'series' ? 'series' : kind}/${encodeURIComponent(id)}`)
    upstreamHit = existing.status === 200 && existing.json && typeof existing.json === 'object' && !Array.isArray(existing.json)
    if (kind === 'cards' && upstreamHit) upstreamSetId = existing.json.set?.id || null
  } catch {
    upstreamHit = false
  }
  saved._meta = {
    upstream: upstreamHit,
    ...(kind === 'cards' ? { upstreamSetId } : {}),
    savedAt: new Date().toISOString(),
  }
  if (!saved.updated) saved.updated = saved._meta.savedAt
  return saved
}

async function handleImport(req, res, ctx) {
  const body = await readJson(req, res)
  if (body == null) return
  if (isJsonImport(body)) {
    await handleJsonImport(body, res, ctx)
    return
  }
  const kind = body.kind === 'series' ? 'series' : body.kind
  const lang = body.lang
  const rawId = String(body.id || '').trim()
  if (!['cards', 'sets', 'series'].includes(kind) || !isLanguage(lang) || !rawId) {
    sendJson(res, 400, { error: 'kind, lang, and id are required' })
    return
  }
  const endpoint = kind === 'series' ? 'series' : kind
  let upstreamPath
  if (kind === 'cards' && rawId.includes('/')) {
    const parts = rawId.split('/')
    if (parts.length !== 2 || !isSafeId(parts[0]) || !isSafeLocalId(parts[1])) {
      sendJson(res, 400, {
        error: 'use a card id like exu-M, or set/localId like exu/M',
      })
      return
    }
    upstreamPath = `/v2/${lang}/sets/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`
  } else if (!isSafeId(rawId)) {
    sendJson(res, 400, {
      error: 'id may contain letters, numbers, dots, underscores, hyphens, %, and !',
    })
    return
  } else {
    upstreamPath = `/v2/${lang}/${endpoint}/${encodeURIComponent(rawId)}`
  }
  try {
    const existing = await ctx.upstream.request(upstreamPath)
    if (existing.status !== 200 || !existing.json || Array.isArray(existing.json)) {
      sendJson(res, 404, { error: 'upstream does not have that record' })
      return
    }
    const record = { ...existing.json }
    delete record.cards
    delete record.sets
    sendJson(res, 200, { kind, lang, record, upstream: true })
  } catch {
    sendJson(res, 502, { error: 'upstream is unavailable' })
  }
}

function isJsonImport(body) {
  if (Array.isArray(body)) return true
  if (!body || typeof body !== 'object') return false
  if (body.document !== undefined) return true
  if (body.record && typeof body.record === 'object') return true
  return Array.isArray(body.cards) || Array.isArray(body.sets) || Array.isArray(body.series)
}

async function handleJsonImport(body, res, ctx) {
  const document = body.document !== undefined ? body.document : body
  const fallback = { lang: body.lang, kind: body.kind }
  let items
  try {
    items = collectJsonImports(document, fallback)
  } catch (error) {
    sendJson(res, 400, { error: error.message })
    return
  }
  if (!items.length) {
    sendJson(res, 400, { error: 'no cards, sets, or series found in JSON' })
    return
  }

  const errors = []
  const prepared = []
  for (const item of items) {
    const label = `${item.kind || 'record'} ${item.record?.id || '(missing id)'}`
    if (!['cards', 'sets', 'series'].includes(item.kind)) {
      errors.push(`${label}: kind must be cards, sets, or series`)
      continue
    }
    if (!isLanguage(item.lang)) {
      errors.push(`${label}: language is invalid`)
      continue
    }
    const record = { ...item.record }
    delete record._meta
    delete record._lang
    delete record.kind
    delete record.lang
    const problems = VALIDATORS[item.kind](record)
    if (problems.length) errors.push(`${label}: ${problems.join('; ')}`)
    else prepared.push({ kind: item.kind, lang: item.lang, record })
  }
  if (errors.length) {
    sendJson(res, 400, { error: 'invalid definition', details: errors })
    return
  }

  const saved = []
  for (const item of prepared) {
    const annotated = await annotate(item.kind, item.lang, item.record.id, item.record, ctx.upstream)
    ctx.store.put(item.kind, item.lang, annotated.id, annotated)
    saved.push({ kind: item.kind, lang: item.lang, id: annotated.id })
  }
  sendJson(res, 200, { saved })
}

/**
 * Accept a single record, `{ kind, lang, record }`, or `{ cards, sets, series }`.
 * Series and sets are ordered before cards.
 */
export function collectJsonImports(document, fallback = {}) {
  if (Array.isArray(document)) {
    return document.flatMap((item) => collectJsonImports(item, fallback))
  }
  if (!document || typeof document !== 'object') {
    throw new Error('JSON import must be an object or an array')
  }
  const lang = document.lang || document._lang || fallback.lang
  if (Array.isArray(document.cards) || Array.isArray(document.sets) || Array.isArray(document.series)) {
    const items = []
    for (const kind of ['series', 'sets', 'cards']) {
      for (const record of document[kind] || []) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          throw new Error(`${kind} entries must be JSON objects`)
        }
        items.push({ kind, lang: record.lang || record._lang || lang, record })
      }
    }
    return items
  }
  if (document.record && typeof document.record === 'object' && !Array.isArray(document.record)) {
    const kind = normalizeKind(document.kind || fallback.kind)
    return [{ kind, lang, record: document.record }]
  }
  const kind = normalizeKind(
    ['cards', 'sets', 'series'].includes(document.kind) ? document.kind : (fallback.kind || inferKind(document)),
  )
  if (!kind) throw new Error('could not tell whether the JSON is a card, set, or series')
  return [{ kind, lang, record: document }]
}

function normalizeKind(kind) {
  if (kind === 'card') return 'cards'
  if (kind === 'set') return 'sets'
  if (kind === 'serie' || kind === 'series') return 'series'
  return ['cards', 'sets', 'series'].includes(kind) ? kind : null
}

function inferKind(record) {
  if (record.category || record.localId || record.variants || record.attacks) return 'cards'
  if (record.serie || record.cardCount || record.abbreviation || record.tcgOnline || record.releaseDate) return 'sets'
  if (record.id && record.name) return 'series'
  return null
}

async function handleImageUpload(name, req, res, ctx) {
  const safe = safeImageRelPath(name)
  if (!safe) {
    sendJson(res, 400, { error: 'image name must be a file such as card.png or card/low.webp' })
    return
  }
  const bytes = await readBody(req, 5_000_000)
  if (!bytes?.length) {
    sendJson(res, 400, { error: 'empty image' })
    return
  }
  if (!writeImageFile(ctx.dataDir, safe, bytes)) {
    sendJson(res, 400, { error: 'image name must be a file such as card.png or card/low.webp' })
    return
  }
  sendJson(res, 200, { path: publicAssetPath(safe), file: `/assets/${safe}` })
}

function serveImage(req, pathname, ctx, res) {
  const file = resolveImageFile(ctx.dataDir, pathname)
  if (!file) {
    sendJson(res, 404, { error: 'not found' })
    return true
  }
  const stat = fs.statSync(file)
  const etag = `"${stat.mtimeMs.toString(16)}-${stat.size.toString(16)}"`
  const headers = {
    'content-type': IMAGE_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'public, max-age=0, must-revalidate',
    'etag': etag,
    'last-modified': stat.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return true
  }
  res.writeHead(200, headers)
  fs.createReadStream(file).pipe(res)
  return true
}

function sendFile(publicDir, name, res) {
  const file = path.resolve(publicDir, name)
  if (!file.startsWith(`${path.resolve(publicDir)}${path.sep}`)) {
    sendJson(res, 403, { error: 'forbidden' })
    return true
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
  res.writeHead(200, {
    'content-type': types[path.extname(name)] || 'application/octet-stream',
    'cache-control': 'no-cache',
  })
  fs.createReadStream(file).pipe(res)
  return true
}

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

export async function readJson(req, res) {
  try {
    const raw = await readBody(req, 1_000_000)
    if (!raw) {
      sendJson(res, 400, { error: 'expected a JSON body' })
      return null
    }
    return JSON.parse(raw.toString('utf8'))
  } catch (error) {
    const status = error.status || 400
    sendJson(res, status, { error: status === 413 ? 'payload too large' : 'invalid JSON' })
    return null
  }
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
