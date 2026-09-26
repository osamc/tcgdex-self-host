import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp } from '../src/server.js'
import { ID_MAX_LENGTH, LOCAL_ID_MAX_LENGTH, isSafeId, isSafeLocalId, nextCopyId } from '../src/store.js'

const TOKEN = 'test-token-value-123'

const overrideCard = {
  id: 'exu-M',
  localId: 'M',
  name: 'Unown',
  category: 'Pokemon',
  set: { id: 'exu', name: 'Unseen Forces' },
  variants: { firstEdition: false, holo: true, normal: false, reverse: false, wPromo: false },
}

const customCard = {
  id: 'demo-001',
  localId: '001',
  name: 'Demo Partner',
  category: 'Pokemon',
  set: { id: 'demo', name: 'Demo Set' },
  variants: { normal: true, reverse: false, holo: false, firstEdition: false, wPromo: false },
}

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, url: `http://127.0.0.1:${address.port}` }
}

function upstreamServer() {
  return listen((req, res) => {
    const url = new URL(req.url, 'http://upstream.local')
    if (url.pathname === '/ping') {
      res.writeHead(200)
      res.end('ok')
      return
    }
    if (url.pathname === '/v2/en/cards/exu-M') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(overrideCard))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 404 }))
  })
}

async function startManager(upstreamUrl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgdex-export-'))
  const app = createApp({
    token: TOKEN,
    dataDir,
    upstreamUrl,
    cacheTtlSeconds: 0,
    publicDir: path.join(import.meta.dirname, '..', 'public'),
  })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  return {
    app,
    dataDir,
    base: `http://127.0.0.1:${app.server.address().port}`,
  }
}

function authHeaders() {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
}

async function putCard(base, lang, card) {
  const response = await fetch(`${base}/manage/api/cards/${lang}/${encodeURIComponent(card.id)}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(card),
  })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  return body
}

test('nextCopyId appends a suffix and stays inside the id length limit', () => {
  assert.equal(nextCopyId('exu-M', ['exu-M'], ID_MAX_LENGTH), 'exu-M-copy')
  assert.equal(nextCopyId('exu-M', ['exu-m', 'exu-m-copy'], ID_MAX_LENGTH), 'exu-M-copy-2')
  assert.equal(nextCopyId('M', [], LOCAL_ID_MAX_LENGTH), 'M-copy')

  const longId = `a${'b'.repeat(ID_MAX_LENGTH - 1)}`
  const copy = nextCopyId(longId, [], ID_MAX_LENGTH)
  assert.equal(copy.length, ID_MAX_LENGTH)
  assert.ok(copy.endsWith('-copy'))
  assert.equal(isSafeId(copy), true)

  const longLocal = 'z'.repeat(LOCAL_ID_MAX_LENGTH)
  const localCopy = nextCopyId(longLocal, [longLocal], LOCAL_ID_MAX_LENGTH)
  assert.equal(localCopy.length, LOCAL_ID_MAX_LENGTH)
  assert.equal(isSafeLocalId(localCopy), true)
})

test('export returns saved cards, sets, and series without internal fields', async () => {
  const upstream = await upstreamServer()
  const manager = await startManager(upstream.url)
  try {
    await putCard(manager.base, 'en', overrideCard)
    await putCard(manager.base, 'fr', { ...customCard, id: 'demo-002', name: 'Partenaire' })
    await putCard(manager.base, 'en', customCard)
    const set = await fetch(`${manager.base}/manage/api/sets/en/demo`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ id: 'demo', name: 'Demo Set', serie: { id: 'custom', name: 'Custom' } }),
    })
    assert.equal(set.status, 200)
    const serie = await fetch(`${manager.base}/manage/api/series/en/custom`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ id: 'custom', name: 'Custom' }),
    })
    assert.equal(serie.status, 200)

    const denied = await fetch(`${manager.base}/manage/api/export`)
    assert.equal(denied.status, 401)

    const exported = await fetch(`${manager.base}/manage/api/export`, { headers: authHeaders() })
    assert.equal(exported.status, 200)
    const bundle = await exported.json()
    assert.deepEqual(bundle.cards.map((card) => `${card.lang}/${card.id}`), [
      'en/demo-001',
      'en/exu-M',
      'fr/demo-002',
    ])
    assert.deepEqual(bundle.sets.map((item) => item.id), ['demo'])
    assert.deepEqual(bundle.series.map((item) => item.id), ['custom'])
    for (const record of [...bundle.cards, ...bundle.sets, ...bundle.series]) {
      assert.equal(record._meta, undefined)
      assert.equal(record._lang, undefined)
      assert.equal(typeof record.lang, 'string')
    }
    assert.equal(bundle.cards.find((card) => card.id === 'exu-M').name, 'Unown')

    const cardsOnly = await fetch(`${manager.base}/manage/api/export?kind=cards`, { headers: authHeaders() })
    const cardsBundle = await cardsOnly.json()
    assert.equal(cardsBundle.cards.length, 3)
    assert.deepEqual(cardsBundle.sets, [])
    assert.deepEqual(cardsBundle.series, [])

    const badKind = await fetch(`${manager.base}/manage/api/export?kind=rules`, { headers: authHeaders() })
    assert.equal(badKind.status, 400)

    const other = await startManager(upstream.url)
    try {
      const imported = await fetch(`${other.base}/manage/api/import`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ document: bundle }),
      })
      assert.equal(imported.status, 200, await imported.text())
      const again = await fetch(`${other.base}/manage/api/export`, { headers: authHeaders() })
      const roundTrip = await again.json()
      assert.deepEqual(
        roundTrip.cards.map((card) => `${card.lang}/${card.id}/${card.name}`),
        bundle.cards.map((card) => `${card.lang}/${card.id}/${card.name}`),
      )
      const restored = await fetch(`${other.base}/manage/api/cards/en/exu-M`, { headers: authHeaders() })
      assert.equal((await restored.json())._meta.upstream, true)
      const custom = await fetch(`${other.base}/manage/api/cards/en/demo-001`, { headers: authHeaders() })
      assert.equal((await custom.json())._meta.upstream, false)
    } finally {
      other.app.metrics.flush()
      await new Promise((resolve) => other.app.server.close(resolve))
      fs.rmSync(other.dataDir, { recursive: true, force: true })
    }
  } finally {
    manager.app.metrics.flush()
    await new Promise((resolve) => manager.app.server.close(resolve))
    await new Promise((resolve) => upstream.server.close(resolve))
    fs.rmSync(manager.dataDir, { recursive: true, force: true })
  }
})

test('duplicating an override proposes a new card and does not replace the original', async () => {
  const upstream = await upstreamServer()
  const manager = await startManager(upstream.url)
  try {
    const saved = await putCard(manager.base, 'en', overrideCard)
    assert.equal(saved._meta.upstream, true)
    await putCard(manager.base, 'en', customCard)
    await putCard(manager.base, 'en', {
      ...overrideCard,
      id: 'exu-M-copy',
      localId: 'M-copy',
      name: 'Already used',
    })

    const customAttempt = await fetch(`${manager.base}/manage/api/duplicate`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ kind: 'cards', lang: 'en', id: 'demo-001' }),
    })
    assert.equal(customAttempt.status, 400)

    const missing = await fetch(`${manager.base}/manage/api/duplicate`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ kind: 'cards', lang: 'en', id: 'nope' }),
    })
    assert.equal(missing.status, 404)

    const duplicated = await fetch(`${manager.base}/manage/api/duplicate`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ kind: 'cards', lang: 'en', id: 'exu-M' }),
    })
    assert.equal(duplicated.status, 200)
    const draft = await duplicated.json()
    assert.equal(draft.copiedFrom, 'exu-M')
    assert.equal(draft.record.id, 'exu-M-copy-2')
    assert.equal(draft.record.localId, 'M-copy-2')
    assert.equal(draft.record.name, 'Unown copy')
    assert.equal(draft.record._meta, undefined)
    assert.equal(draft.record.set.id, 'exu')

    const catalog = await fetch(`${manager.base}/manage/api/catalog`, { headers: authHeaders() })
    const ids = (await catalog.json()).cards.map((card) => card.id).sort()
    assert.deepEqual(ids, ['demo-001', 'exu-M', 'exu-M-copy'])

    const created = await putCard(manager.base, 'en', draft.record)
    assert.equal(created._meta.upstream, false)
    assert.equal(created.id, 'exu-M-copy-2')

    const original = await fetch(`${manager.base}/manage/api/cards/en/exu-M`, { headers: authHeaders() })
    const originalBody = await original.json()
    assert.equal(originalBody.name, 'Unown')
    assert.equal(originalBody._meta.upstream, true)
  } finally {
    manager.app.metrics.flush()
    await new Promise((resolve) => manager.app.server.close(resolve))
    await new Promise((resolve) => upstream.server.close(resolve))
    fs.rmSync(manager.dataDir, { recursive: true, force: true })
  }
})
