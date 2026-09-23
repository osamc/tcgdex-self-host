import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp } from '../src/server.js'

const TOKEN = 'test-token-value-123'

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, url: `http://127.0.0.1:${address.port}` }
}

test('management API saves a card, serves it, and counts the request', async () => {
  const upstream = await listen((req, res) => {
    if (req.url === '/ping') {
      res.writeHead(200)
      res.end('ok')
      return
    }
    if (req.url.includes('demo-001')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 404, title: 'missing' }))
      return
    }
    if (req.url.startsWith('/v2/en/cards')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ id: 'base1-1', localId: '1', name: 'Alakazam' }]))
      return
    }
    res.writeHead(404)
    res.end()
  })

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgdex-manager-'))
  const app = createApp({
    token: TOKEN,
    dataDir,
    upstreamUrl: upstream.url,
    cacheTtlSeconds: 0,
    publicDir: path.join(import.meta.dirname, '..', 'public'),
  })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const port = app.server.address().port
  const base = `http://127.0.0.1:${port}`

  try {
    const denied = await fetch(`${base}/manage/api/catalog`)
    assert.equal(denied.status, 401)

    const saved = await fetch(`${base}/manage/api/cards/en/demo-001`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'demo-001',
        localId: '001',
        name: 'Demo Partner',
        category: 'Pokemon',
        set: { id: 'demo', name: 'Demo Set' },
        variants: { normal: true, reverse: false, holo: false, firstEdition: false, wPromo: false },
      }),
    })
    assert.equal(saved.status, 200)
    const savedBody = await saved.json()
    assert.equal(savedBody._meta.upstream, false)

    const card = await fetch(`${base}/v2/en/cards/demo-001`)
    assert.equal(card.status, 200)
    assert.equal((await card.json()).name, 'Demo Partner')

    const list = await fetch(`${base}/v2/en/cards`)
    const ids = (await list.json()).map((item) => item.id)
    assert.deepEqual(ids, ['base1-1', 'demo-001'])

    const health = await fetch(`${base}/healthz`)
    assert.equal(health.status, 200)

    const page = await fetch(`${base}/manage`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /TCGdex Manager/)

    const metrics = await fetch(`${base}/manage/api/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })
    const snapshot = await metrics.json()
    assert.ok(snapshot.windows['24h'].count >= 2)
    assert.ok(snapshot.paths.some((row) => row.path.includes('/v2/:lang/cards')))
  } finally {
    app.metrics.flush()
    await new Promise((resolve) => app.server.close(resolve))
    await new Promise((resolve) => upstream.server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('uploaded card images are served at high.webp and low.webp', async () => {
  const upstream = await listen((req, res) => {
    res.writeHead(404)
    res.end()
  })
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgdex-assets-'))
  const app = createApp({
    token: TOKEN,
    dataDir,
    upstreamUrl: upstream.url,
    cacheTtlSeconds: 0,
    publicDir: path.join(import.meta.dirname, '..', 'public'),
  })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${app.server.address().port}`
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )

  try {
    const uploaded = await fetch(`${base}/manage/api/images/demo-001.png`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'image/png' },
      body: png,
    })
    assert.equal(uploaded.status, 200)
    assert.deepEqual(await uploaded.json(), { path: '/assets/demo-001', file: '/assets/demo-001.png' })

    for (const asset of ['/assets/demo-001', '/assets/demo-001/high.webp', '/assets/demo-001/low.webp', '/assets/demo-001.png']) {
      const response = await fetch(`${base}${asset}`)
      assert.equal(response.status, 200, asset)
      assert.equal(response.headers.get('content-type'), 'image/png')
      assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), png), 0)
    }

    const low = await fetch(`${base}/manage/api/images/demo-001/low.webp`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'image/webp' },
      body: png,
    })
    assert.equal(low.status, 200)
    const preview = await fetch(`${base}/assets/demo-001/low.webp`)
    assert.equal(preview.headers.get('content-type'), 'image/webp')

    const other = Buffer.from('second-upload-bytes')
    const replaced = await fetch(`${base}/manage/api/images/demo-001.webp`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'image/webp' },
      body: other,
    })
    assert.equal(replaced.status, 200)
    const high = await fetch(`${base}/assets/demo-001/high.webp`)
    assert.equal(high.headers.get('content-type'), 'image/webp')
    assert.equal(Buffer.from(await high.arrayBuffer()).toString(), 'second-upload-bytes')
    const stillLow = await fetch(`${base}/assets/demo-001/low.webp`)
    assert.equal(stillLow.headers.get('content-type'), 'image/webp')
    assert.equal(Buffer.compare(Buffer.from(await stillLow.arrayBuffer()), png), 0)
  } finally {
    app.metrics.flush()
    await new Promise((resolve) => app.server.close(resolve))
    await new Promise((resolve) => upstream.server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a short management token is rejected at startup', () => {
  assert.throws(() => createApp({
    token: 'too-short',
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tcgdex-token-')),
    upstreamUrl: 'http://127.0.0.1:9',
  }), /MANAGEMENT_TOKEN/)
})
