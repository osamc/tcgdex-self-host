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

test('a short management token is rejected at startup', () => {
  assert.throws(() => createApp({
    token: 'too-short',
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tcgdex-token-')),
    upstreamUrl: 'http://127.0.0.1:9',
  }), /MANAGEMENT_TOKEN/)
})
