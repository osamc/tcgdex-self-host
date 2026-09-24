import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DeckParser } from 'pokemon-tcg-deck-parser'
import { createApp } from '../src/server.js'
import { seedCatalog } from '../src/seed.js'

const TOKEN = 'test-token-value-123'
const DECK = 'Pokémon: 24\n2 Unown UF M\n'

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, url: `http://127.0.0.1:${address.port}` }
}

function emptyUpstream() {
  return listen((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 404, title: 'missing' }))
  })
}

test('JSON import stores a card, set, and series', async () => {
  const upstream = await emptyUpstream()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgdex-json-'))
  const app = createApp({
    token: TOKEN,
    dataDir,
    upstreamUrl: upstream.url,
    cacheTtlSeconds: 0,
    publicDir: path.join(import.meta.dirname, '..', 'public'),
  })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${app.server.address().port}`

  try {
    const imported = await fetch(`${base}/manage/api/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        lang: 'en',
        document: {
          series: [{ id: 'custom-json', name: 'From JSON' }],
          sets: [{ id: 'jsonset', name: 'JSON Set', serie: { id: 'custom-json', name: 'From JSON' } }],
          cards: [{
            id: 'jsonset-1',
            localId: '1',
            name: 'JSON Partner',
            category: 'Pokemon',
            set: { id: 'jsonset', name: 'JSON Set' },
            variants: { normal: true, reverse: false, holo: false, firstEdition: false, wPromo: false },
            image: '/assets/jsonset-1',
          }],
        },
      }),
    })
    assert.equal(imported.status, 200)
    assert.deepEqual((await imported.json()).saved.map((row) => row.id), ['custom-json', 'jsonset', 'jsonset-1'])

    const card = await fetch(`${base}/v2/en/cards/jsonset-1`)
    assert.equal(card.status, 200)
    assert.equal((await card.json()).name, 'JSON Partner')

    const rejected = await fetch(`${base}/manage/api/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ lang: 'en', kind: 'cards', document: { id: 'nope' } }),
    })
    assert.equal(rejected.status, 400)
  } finally {
    app.metrics.flush()
    await new Promise((resolve) => app.server.close(resolve))
    await new Promise((resolve) => upstream.server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('the preseeded Unown card is what the deck parser returns for "2 Unown UF M"', async () => {
  const upstream = await emptyUpstream()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgdex-uf-'))
  const copied = seedCatalog(dataDir)
  assert.ok(copied.includes('cards/en/uf-m.json'))
  assert.ok(copied.includes('images/uf-m.png'))

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
    const parser = new DeckParser({
      lang: 'en',
      endpoint: `${base}/v2`,
      cacheTTL: 0,
      hydrate: 'resume',
    })
    const deck = await parser.parseAndResolve(DECK)
    assert.equal(deck.unresolved.length, 0)
    assert.equal(deck.cards.length, 1)
    const entry = deck.cards[0]
    assert.equal(entry.quantity, 2)
    assert.equal(entry.name, 'Unown UF M')
    assert.equal(entry.tcgdexId, 'uf-m')
    assert.equal(entry.card.image, '/assets/uf-m')
    assert.equal(entry.card.localId, 'M')

    const image = await fetch(`${base}${entry.card.image}/high.webp`)
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/png')
    assert.ok((await image.arrayBuffer()).byteLength > 100)

    const again = seedCatalog(dataDir)
    assert.deepEqual(again, [])
  } finally {
    app.metrics.flush()
    await new Promise((resolve) => app.server.close(resolve))
    await new Promise((resolve) => upstream.server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
