import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRequest } from '../src/catalog.js'

const upstreamCard = {
  id: 'base1-1',
  localId: '1',
  name: 'Alakazam',
  category: 'Pokemon',
  image: 'https://assets.example/1',
  set: { id: 'base1', name: 'Base Set' },
  variants: { normal: true, reverse: false, holo: false, firstEdition: false, wPromo: false },
  hp: 80,
}

const upstreamSet = {
  id: 'base1',
  name: 'Base Set',
  cardCount: { official: 102, total: 1, normal: 1, holo: 0, reverse: 0, firstEd: 0 },
  cards: [{ id: 'base1-1', localId: '1', name: 'Alakazam', image: 'https://assets.example/1' }],
  serie: { id: 'base', name: 'Base' },
}

function store(catalog) {
  return {
    snapshot() {
      return {
        cards: catalog.cards || [],
        sets: catalog.sets || [],
        series: catalog.series || [],
      }
    },
  }
}

function upstream(routes) {
  return async (url) => {
    const hit = routes[`${url.pathname}${url.search}`] ?? routes[url.pathname]
    if (!hit) return { status: 404, json: { status: 404, title: 'missing' }, text: '' }
    if (typeof hit.status === 'number' && hit.status !== 200) {
      return { status: hit.status, json: hit.json ?? { status: hit.status }, text: '' }
    }
    return { status: 200, json: hit, text: JSON.stringify(hit) }
  }
}

test('a new card is returned by id and merged into the card list', async () => {
  const custom = {
    id: 'demo-001',
    localId: '001',
    name: 'Demo Partner',
    category: 'Pokemon',
    set: { id: 'demo', name: 'Demo Set' },
    variants: { normal: true },
    _meta: { upstream: false, upstreamSetId: null },
  }
  const fetchUpstream = async (url) => {
    if (url.pathname === '/v2/en/cards') {
      const filtered = url.searchParams.get('name') === 'eq:Demo Partner'
      return { status: 200, json: filtered ? [] : [{ id: 'base1-1', localId: '1', name: 'Alakazam', image: 'https://assets.example/1' }], text: '' }
    }
    return { status: 404, json: { status: 404 }, text: '' }
  }
  const catalog = store({ cards: [custom] })

  const one = await resolveRequest({
    method: 'GET',
    targetUrl: '/v2/en/cards/demo-001',
    store: catalog,
    fetchUpstream,
  })
  assert.equal(one.status, 200)
  assert.equal(one.body.name, 'Demo Partner')
  assert.equal(one.body._meta, undefined)

  const list = await resolveRequest({
    method: 'GET',
    targetUrl: '/v2/en/cards?name=eq:Demo Partner',
    store: catalog,
    fetchUpstream,
  })
  assert.deepEqual(list.body.map((card) => card.id), ['demo-001'])
})

test('an override replaces the upstream card in detail and list results', async () => {
  const override = {
    ...upstreamCard,
    name: 'Alakazam Prime',
    _meta: { upstream: true, upstreamSetId: 'base1' },
  }
  const fetchUpstream = upstream({
    '/v2/en/cards': [{ id: 'base1-1', localId: '1', name: 'Alakazam', image: 'https://assets.example/1' }],
    '/v2/en/cards/base1-1': upstreamCard,
    '/v2/en/sets/base1': upstreamSet,
    '/v2/en/sets/base1/1': upstreamCard,
  })
  const catalog = store({ cards: [override] })

  const detail = await resolveRequest({ method: 'GET', targetUrl: '/v2/en/cards/base1-1', store: catalog, fetchUpstream })
  assert.equal(detail.body.name, 'Alakazam Prime')
  assert.equal(detail.source, 'override')

  const list = await resolveRequest({ method: 'GET', targetUrl: '/v2/en/cards', store: catalog, fetchUpstream })
  assert.equal(list.body[0].name, 'Alakazam Prime')

  const hidden = await resolveRequest({
    method: 'GET',
    targetUrl: '/v2/en/cards?name=eq:Alakazam',
    store: catalog,
    fetchUpstream,
  })
  assert.deepEqual(hidden.body, [])

  const fromSet = await resolveRequest({ method: 'GET', targetUrl: '/v2/en/sets/base1/1', store: catalog, fetchUpstream })
  assert.equal(fromSet.body.name, 'Alakazam Prime')
})

test('custom sets and series are added and set totals include their cards', async () => {
  const card = {
    id: 'demo-001',
    localId: '001',
    name: 'Demo Partner',
    category: 'Pokemon',
    set: { id: 'demo', name: 'Demo Set' },
    variants: { normal: true, holo: true },
    _meta: { upstream: false, upstreamSetId: null },
  }
  const set = { id: 'demo', name: 'Demo Set', serie: { id: 'custom', name: 'Custom' }, cardCount: { official: 1 } }
  const serie = { id: 'custom', name: 'Custom' }
  const fetchUpstream = upstream({
    '/v2/en/sets': [{ id: 'base1', name: 'Base Set', cardCount: { total: 102, official: 102 } }],
    '/v2/en/sets/demo': { status: 404 },
    '/v2/en/series': [{ id: 'base', name: 'Base', logo: 'https://assets.example/base' }],
    '/v2/en/series/custom': { status: 404 },
  })
  const catalog = store({ cards: [card], sets: [set], series: [serie] })

  const sets = await resolveRequest({ method: 'GET', targetUrl: '/v2/en/sets', store: catalog, fetchUpstream })
  const demo = sets.body.find((item) => item.id === 'demo')
  assert.equal(demo.cardCount.total, 1)
  assert.equal(demo.cardCount.official, 1)

  const detail = await resolveRequest({ method: 'GET', targetUrl: '/v2/en/sets/demo', store: catalog, fetchUpstream })
  assert.equal(detail.body.cards[0].id, 'demo-001')
  assert.equal(detail.body.cardCount.holo, 1)

  const series = await resolveRequest({ method: 'GET', targetUrl: '/v2/en/series/custom', store: catalog, fetchUpstream })
  assert.equal(series.body.sets[0].id, 'demo')
})

test('pagination is applied after custom cards are merged', async () => {
  const custom = {
    id: 'demo-001',
    localId: '9',
    name: 'Demo Partner',
    category: 'Pokemon',
    set: { id: 'demo', name: 'Demo Set' },
    variants: { normal: true },
  }
  const fetchUpstream = upstream({
    '/v2/en/cards': [
      { id: 'base1-1', localId: '1', name: 'Alakazam' },
      { id: 'base1-2', localId: '2', name: 'Blastoise' },
    ],
  })
  const page = await resolveRequest({
    method: 'GET',
    targetUrl: '/v2/en/cards?pagination:page=2&pagination:itemsPerPage=2&sort:field=localId&sort:order=ASC',
    store: store({ cards: [custom] }),
    fetchUpstream,
  })
  assert.deepEqual(page.body.map((card) => card.id), ['demo-001'])
})

test('requests stay untouched when the catalog is empty', async () => {
  let called = false
  const result = await resolveRequest({
    method: 'GET',
    targetUrl: '/v2/en/cards',
    store: store({}),
    fetchUpstream: async () => {
      called = true
      return { status: 200, json: [] }
    },
  })
  assert.equal(result, null)
  assert.equal(called, false)
})
