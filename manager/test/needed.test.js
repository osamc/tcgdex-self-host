import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp } from '../src/server.js'
import { createNeeded } from '../src/needed.js'

const TOKEN = 'test-token-value-123'

function authHeaders() {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
}

async function startManager(dataDir) {
  const app = createApp({
    token: TOKEN,
    dataDir,
    upstreamUrl: 'http://127.0.0.1:9',
    cacheTtlSeconds: 0,
    publicDir: path.join(import.meta.dirname, '..', 'public'),
  })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  return { app, base: `http://127.0.0.1:${app.server.address().port}` }
}

test('the needed list is saved and still there after a restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgdex-needed-'))
  const first = await startManager(dataDir)
  try {
    const denied = await fetch(`${first.base}/manage/api/needed`)
    assert.equal(denied.status, 401)

    const empty = await fetch(`${first.base}/manage/api/needed`, { headers: authHeaders() })
    assert.deepEqual(await empty.json(), { items: [] })

    const rejected = await fetch(`${first.base}/manage/api/needed`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: '   ', lang: 'en' }),
    })
    assert.equal(rejected.status, 400)

    const created = await fetch(`${first.base}/manage/api/needed`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        lang: 'en',
        name: 'Unown A',
        set: 'uf',
        localId: 'A',
        notes: 'Still missing from the catalog',
      }),
    })
    assert.equal(created.status, 200)
    const item = await created.json()
    assert.equal(item.name, 'Unown A')
    assert.equal(item.done, false)

    const done = await fetch(`${first.base}/manage/api/needed/${item.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ done: true }),
    })
    assert.equal(done.status, 200)
    const finished = await done.json()
    assert.equal(finished.name, 'Unown A')
    assert.equal(finished.done, true)
  } finally {
    first.app.metrics.flush()
    await new Promise((resolve) => first.app.server.close(resolve))
  }

  const reloaded = createNeeded(dataDir).list()
  assert.equal(reloaded.length, 1)
  assert.equal(reloaded[0].name, 'Unown A')
  assert.equal(reloaded[0].set, 'uf')
  assert.equal(reloaded[0].localId, 'A')
  assert.equal(reloaded[0].done, true)

  const second = await startManager(dataDir)
  try {
    const listed = await fetch(`${second.base}/manage/api/needed`, { headers: authHeaders() })
    const body = await listed.json()
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].done, true)

    const removed = await fetch(`${second.base}/manage/api/needed/${body.items[0].id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    assert.equal(removed.status, 200)
    const after = await fetch(`${second.base}/manage/api/needed`, { headers: authHeaders() })
    assert.deepEqual(await after.json(), { items: [] })
  } finally {
    second.app.metrics.flush()
    await new Promise((resolve) => second.app.server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('open cards stay above ones that are already done', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgdex-needed-sort-'))
  try {
    const needed = createNeeded(dataDir)
    const older = needed.add({ name: 'Older', lang: 'en' })
    const newer = needed.add({ name: 'Newer', lang: 'fr' })
    needed.update(older.id, { done: true })
    assert.deepEqual(needed.list().map((item) => item.name), ['Newer', 'Older'])
    assert.equal(newer.lang, 'fr')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
