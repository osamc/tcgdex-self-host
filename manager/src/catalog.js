import { isLanguage } from './languages.js'
import { matches, paginate, parseQuery, sortItems, uniqueSorted, withoutPagination } from './query.js'

const CARD_SORTS = new Set(['id', 'localId', 'name', 'image'])
const SET_SORTS = new Set(['id', 'name', 'logo', 'symbol'])
const SERIE_SORTS = new Set(['id', 'name', 'logo'])

const SCALAR_FACETS = {
  categories: 'category',
  'energy-types': 'energyType',
  hp: 'hp',
  illustrators: 'illustrator',
  rarities: 'rarity',
  'regulation-marks': 'regulationMark',
  retreats: 'retreat',
  stages: 'stage',
  suffixes: 'suffix',
  'trainer-types': 'trainerType',
}

const ARRAY_FACETS = {
  types: 'types',
  'dex-ids': 'dexId',
}

const CARD_ALIASES = {
  set: (card) => [card.set?.id, card.set?.name],
}

const SET_ALIASES = {
  serie: (set) => [set.serie?.id, set.serie?.name],
}

export function stripMeta(value) {
  if (Array.isArray(value)) return value.map(stripMeta)
  if (!value || typeof value !== 'object') return value
  const copy = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === '_meta' || key === '_lang') continue
    copy[key] = stripMeta(child)
  }
  return copy
}

export function cardBrief(card) {
  const brief = {
    id: card.id,
    localId: card.localId,
    name: card.name,
  }
  if (card.image) brief.image = card.image
  return brief
}

/**
 * Decide whether a v2 REST request should be rewritten with the local catalog.
 * Returns null when the request should be proxied unchanged.
 */
export async function resolveRequest({ method, targetUrl, store, fetchUpstream }) {
  if (method !== 'GET' && method !== 'HEAD') return null
  const url = new URL(targetUrl, 'http://manager.local')
  const route = parseRoute(url.pathname)
  if (!route || !isLanguage(route.lang)) return null

  const catalog = store.snapshot(route.lang)
  if (catalog.cards.length + catalog.sets.length + catalog.series.length === 0) return null

  const query = parseQuery(url.searchParams)
  const upstreamUrl = withoutPagination(url)

  if (route.endpoint === 'cards' && !route.id) {
    return finishList(await mergeCardList(catalog, query, () => fetchUpstream(upstreamUrl)), url)
  }
  if (route.endpoint === 'sets' && !route.id) {
    return finishList(await mergeSetList(catalog, query, () => fetchUpstream(upstreamUrl)), url)
  }
  if (route.endpoint === 'series' && !route.id) {
    return finishList(await mergeSerieList(catalog, query, () => fetchUpstream(upstreamUrl)), url)
  }
  if (route.endpoint === 'cards' && route.id && !route.subid) {
    return respond(await resolveCard(catalog, route, () => fetchUpstream(url)), url)
  }
  if (route.endpoint === 'sets' && route.id && !route.subid) {
    return respond(await resolveSet(catalog, route, () => fetchUpstream(url)), url)
  }
  if (route.endpoint === 'series' && route.id && !route.subid) {
    return respond(await resolveSerie(catalog, route, () => fetchUpstream(url)), url)
  }
  if (route.endpoint === 'sets' && route.id && route.subid) {
    return respond(await resolveSetCard(catalog, route, () => fetchUpstream(url)), url)
  }
  if (!route.id && (SCALAR_FACETS[route.endpoint] || ARRAY_FACETS[route.endpoint] || route.endpoint === 'variants')) {
    return respond(await resolveFacetList(catalog, route, query, () => fetchUpstream(upstreamUrl)), url)
  }
  if (route.id && !route.subid && (SCALAR_FACETS[route.endpoint] || ARRAY_FACETS[route.endpoint])) {
    return respond(await resolveFacetDetail(catalog, route, query, () => fetchUpstream(upstreamUrl)), url)
  }
  return null
}

function finishList(result, url) {
  return respond(result, url)
}

function respond(result, url) {
  if (!result) return null
  if (result.pass) return null
  return {
    status: result.status,
    source: result.source,
    body: result.body ?? notFoundBody(url),
  }
}

async function mergeCardList(catalog, query, fetchUpstream) {
  const upstream = await safeUpstream(fetchUpstream)
  const upstreamItems = Array.isArray(upstream?.json) ? upstream.json : []
  const usable = upstream?.status === 200 && Array.isArray(upstream.json)
  if (!usable && upstream?.status && upstream.status !== 404 && !Array.isArray(upstream?.json)) {
    return passthrough(upstream)
  }
  let items = mergeById(upstreamItems, catalog.cards, query.filters, CARD_ALIASES, (card) => cardBrief(card))
  items = applySortAndPage(items, query, CARD_SORTS)
  return { status: 200, source: catalog.cards.length ? 'merged' : 'upstream', body: items }
}

async function mergeSetList(catalog, query, fetchUpstream) {
  const upstream = await safeUpstream(fetchUpstream)
  const upstreamItems = Array.isArray(upstream?.json) ? upstream.json : []
  if (upstream && upstream.status !== 200 && !Array.isArray(upstream.json) && upstream.status !== 404) {
    return passthrough(upstream)
  }
  const items = []
  const seen = new Set()
  for (const brief of upstreamItems) {
    const id = keyOf(brief.id)
    seen.add(id)
    const custom = catalog.sets.find((set) => keyOf(set.id) === id)
    if (custom) {
      if (!matches(custom, query.filters, SET_ALIASES)) continue
      items.push(briefForSet(custom, catalog.cards, brief))
    } else {
      items.push(adjustSetBrief(brief, catalog.cards))
    }
  }
  for (const set of catalog.sets) {
    if (seen.has(keyOf(set.id))) continue
    if (!matches(set, query.filters, SET_ALIASES)) continue
    items.push(briefForSet(set, catalog.cards, null))
  }
  return {
    status: 200,
    source: 'merged',
    body: applySortAndPage(items, query, SET_SORTS),
  }
}

async function mergeSerieList(catalog, query, fetchUpstream) {
  const upstream = await safeUpstream(fetchUpstream)
  const upstreamItems = Array.isArray(upstream?.json) ? upstream.json : []
  if (upstream && upstream.status !== 200 && !Array.isArray(upstream.json) && upstream.status !== 404) {
    return passthrough(upstream)
  }
  const items = mergeById(upstreamItems, catalog.series, query.filters, {}, (serie, upstreamBrief) => {
    const brief = serieBrief(serie)
    if (!brief.logo && upstreamBrief?.logo) brief.logo = upstreamBrief.logo
    return brief
  })
  return { status: 200, source: 'merged', body: applySortAndPage(items, query, SERIE_SORTS) }
}

async function resolveCard(catalog, route, fetchUpstream) {
  const direct = findById(catalog.cards, route.id)
  if (direct) return { status: 200, source: direct._meta?.upstream ? 'override' : 'custom', body: stripMeta(direct) }

  const upstream = await safeUpstream(fetchUpstream)
  if (upstream?.status === 200 && upstream.json?.id) {
    const override = findById(catalog.cards, upstream.json.id)
    if (override) return { status: 200, source: 'override', body: stripMeta(override) }
    return { status: 200, source: 'upstream', body: upstream.json }
  }
  const byName = catalog.cards.find((card) => String(card.name).toLowerCase() === route.id.toLowerCase())
  if (byName) return { status: 200, source: 'custom', body: stripMeta(byName) }
  if (!upstream) return { status: 502, source: 'upstream', body: badGateway() }
  return { status: upstream.status, source: 'upstream', body: upstream.json ?? upstream.text }
}

async function resolveSet(catalog, route, fetchUpstream) {
  const upstream = await safeUpstream(fetchUpstream)
  const upstreamSet = upstream?.status === 200 && upstream.json?.id ? upstream.json : null
  const custom = upstreamSet
    ? findById(catalog.sets, upstreamSet.id)
    : findById(catalog.sets, route.id) || findByName(catalog.sets, route.id)
  if (!upstreamSet && !custom) {
    if (!upstream) return { status: 502, source: 'upstream', body: badGateway() }
    return { status: upstream.status, source: 'upstream', body: upstream.json ?? upstream.text }
  }
  const setId = custom?.id || upstreamSet.id
  const cards = mergeSetCards(upstreamSet?.cards, setId, catalog.cards)
  const merged = { ...(upstreamSet ? stripMeta(upstreamSet) : {}), ...(custom ? stripMeta(custom) : {}) }
  merged.cards = cards
  merged.cardCount = countForSet(upstreamSet?.cardCount, custom, cards, catalog.cards, !upstreamSet)
  return { status: 200, source: custom ? (custom._meta?.upstream || upstreamSet ? 'override' : 'custom') : 'merged', body: merged }
}

async function resolveSerie(catalog, route, fetchUpstream) {
  const upstream = await safeUpstream(fetchUpstream)
  const upstreamSerie = upstream?.status === 200 && upstream.json?.id ? upstream.json : null
  const custom = upstreamSerie
    ? findById(catalog.series, upstreamSerie.id)
    : findById(catalog.series, route.id) || findByName(catalog.series, route.id)
  if (!upstreamSerie && !custom) {
    if (!upstream) return { status: 502, source: 'upstream', body: badGateway() }
    return { status: upstream.status, source: 'upstream', body: upstream.json ?? upstream.text }
  }
  const serieId = custom?.id || upstreamSerie.id
  const merged = { ...(upstreamSerie ? stripMeta(upstreamSerie) : {}), ...(custom ? stripMeta(custom) : {}) }
  merged.sets = mergeSerieSets(upstreamSerie?.sets, serieId, catalog.sets, catalog.cards)
  return {
    status: 200,
    source: custom ? (upstreamSerie ? 'override' : 'custom') : 'merged',
    body: merged,
  }
}

async function resolveSetCard(catalog, route, fetchUpstream) {
  const custom = findCardInSet(catalog.cards, route.id, route.subid)
  if (custom) return { status: 200, source: custom._meta?.upstream ? 'override' : 'custom', body: stripMeta(custom) }
  const upstream = await safeUpstream(fetchUpstream)
  if (upstream?.status === 200 && upstream.json?.id) {
    const override = findById(catalog.cards, upstream.json.id)
    if (override) return { status: 200, source: 'override', body: stripMeta(override) }
    return { status: 200, source: 'upstream', body: upstream.json }
  }
  if (!upstream) return { status: 502, source: 'upstream', body: badGateway() }
  return { status: upstream.status, source: 'upstream', body: upstream.json ?? upstream.text }
}

async function resolveFacetList(catalog, route, query, fetchUpstream) {
  const upstream = await safeUpstream(fetchUpstream)
  const base = Array.isArray(upstream?.json) ? upstream.json : []
  if (upstream && !Array.isArray(upstream.json) && upstream.status !== 200) return passthrough(upstream)
  const extra = []
  for (const card of catalog.cards.filter((card) => matches(card, query.filters, CARD_ALIASES))) {
    extra.push(...facetValues(card, route.endpoint))
  }
  return { status: 200, source: 'merged', body: uniqueSorted([...base, ...extra]) }
}

async function resolveFacetDetail(catalog, route, query, fetchUpstream) {
  const upstream = await safeUpstream(fetchUpstream)
  const hits = catalog.cards.some((card) => facetHit(card, route.endpoint, route.id))
  if (!upstream && !hits) return { status: 502, source: 'upstream', body: badGateway() }
  const baseCards = Array.isArray(upstream?.json?.cards) ? upstream.json.cards : []
  const name = upstream?.json?.name ?? coerceFacetName(route.endpoint, route.id)
  if (upstream && upstream.status !== 200 && !upstream.json?.cards && !hits) {
    return passthrough(upstream)
  }
  const cards = mergeById(
    baseCards,
    catalog.cards.filter((card) => facetHit(card, route.endpoint, route.id)),
    query.filters,
    CARD_ALIASES,
    (card) => cardBrief(card),
  )
  return { status: 200, source: 'merged', body: { name, cards } }
}

function mergeById(upstreamItems, customItems, filters, aliases, toOutput) {
  const matching = customItems.filter((item) => matches(stripMeta(item), filters, aliases))
  const matchingIds = new Set(matching.map((item) => keyOf(item.id)))
  const customIds = new Set(customItems.map((item) => keyOf(item.id)))
  const seen = new Set()
  const items = []
  for (const item of upstreamItems) {
    const id = keyOf(item.id)
    seen.add(id)
    if (!customIds.has(id)) {
      items.push(item)
      continue
    }
    if (!matchingIds.has(id)) continue
    const custom = customItems.find((entry) => keyOf(entry.id) === id)
    items.push(toOutput(custom, item))
  }
  for (const custom of matching) {
    const id = keyOf(custom.id)
    if (seen.has(id)) continue
    items.push(toOutput(custom, null))
  }
  return items
}

function briefForSet(set, cards, upstreamBrief) {
  const brief = {
    id: set.id,
    name: set.name,
    cardCount: countForSet(upstreamBrief?.cardCount, set, null, cards, !upstreamBrief),
  }
  const logo = set.logo || upstreamBrief?.logo
  const symbol = set.symbol || upstreamBrief?.symbol
  if (logo) brief.logo = logo
  if (symbol) brief.symbol = symbol
  return brief
}

function adjustSetBrief(brief, cards) {
  if (!brief?.cardCount || typeof brief.cardCount.total !== 'number') return brief
  const delta = totalDelta(brief.id, cards)
  if (!delta) return brief
  return {
    ...brief,
    cardCount: { ...brief.cardCount, total: brief.cardCount.total + delta },
  }
}

function countForSet(upstreamCount, customSet, mergedCards, allCards, customOnly) {
  if (customOnly) {
    const owned = cardsInSet(allCards, customSet?.id)
    return variantCount(customSet, owned)
  }
  const total = mergedCards
    ? mergedCards.length
    : (upstreamCount?.total || 0) + totalDelta(customSet?.id, allCards)
  return {
    ...(upstreamCount || {}),
    total,
    ...(customSet?.cardCount?.official != null ? { official: customSet.cardCount.official } : {}),
  }
}

function variantCount(set, cards) {
  const count = {
    official: set?.cardCount?.official ?? cards.length,
    total: cards.length,
    firstEd: 0,
    holo: 0,
    normal: 0,
    reverse: 0,
  }
  for (const card of cards) {
    const variants = card.variants || {}
    if (variants.firstEdition) count.firstEd += 1
    if (variants.holo) count.holo += 1
    if (variants.normal) count.normal += 1
    if (variants.reverse) count.reverse += 1
  }
  return count
}

function totalDelta(setId, cards) {
  if (!setId) return 0
  const id = keyOf(setId)
  let delta = 0
  for (const card of cards) {
    const now = keyOf(card.set?.id)
    const before = card._meta?.upstreamSetId ? keyOf(card._meta.upstreamSetId) : null
    if (now === id && before !== id) delta += 1
    if (before === id && now !== id) delta -= 1
  }
  return delta
}

function mergeSetCards(upstreamCards, setId, customCards) {
  const id = keyOf(setId)
  const replacements = new Map()
  const movedAway = new Set()
  for (const card of customCards) {
    const cardId = keyOf(card.id)
    if (keyOf(card.set?.id) === id) replacements.set(cardId, cardBrief(card))
    else movedAway.add(cardId)
  }
  const cards = []
  const seen = new Set()
  for (const brief of upstreamCards || []) {
    const cardId = keyOf(brief.id)
    seen.add(cardId)
    if (movedAway.has(cardId)) continue
    cards.push(replacements.get(cardId) || brief)
  }
  for (const [cardId, brief] of replacements) {
    if (!seen.has(cardId)) cards.push(brief)
  }
  return cards
}

function mergeSerieSets(upstreamSets, serieId, customSets, customCards) {
  const id = keyOf(serieId)
  const customById = new Map(customSets.map((set) => [keyOf(set.id), set]))
  const sets = []
  const seen = new Set()
  for (const brief of upstreamSets || []) {
    const setId = keyOf(brief.id)
    seen.add(setId)
    const custom = customById.get(setId)
    if (custom) {
      if (keyOf(custom.serie?.id) !== id) continue
      sets.push(briefForSet(custom, customCards, brief))
    } else {
      sets.push(adjustSetBrief(brief, customCards))
    }
  }
  for (const set of customSets) {
    const setId = keyOf(set.id)
    if (seen.has(setId)) continue
    if (keyOf(set.serie?.id) !== id) continue
    sets.push(briefForSet(set, customCards, null))
  }
  return sets
}

function serieBrief(serie) {
  const brief = { id: serie.id, name: serie.name }
  if (serie.logo) brief.logo = serie.logo
  return brief
}

function cardsInSet(cards, setId) {
  const id = keyOf(setId)
  return cards.filter((card) => keyOf(card.set?.id) === id)
}

function findCardInSet(cards, setKey, localId) {
  const want = String(localId).toLowerCase()
  const padded = want.padStart(3, '0')
  return cards.find((card) => {
    const setOk = keyOf(card.set?.id) === setKey.toLowerCase() || String(card.set?.name || '').toLowerCase() === setKey.toLowerCase()
    const current = String(card.localId).toLowerCase()
    return setOk && (current === want || current === padded || current.padStart(3, '0') === padded)
  })
}

function facetValues(card, endpoint) {
  if (endpoint === 'variants') return Object.keys(card.variants || {})
  if (ARRAY_FACETS[endpoint]) {
    const value = card[ARRAY_FACETS[endpoint]]
    return Array.isArray(value) ? value : []
  }
  const field = SCALAR_FACETS[endpoint]
  const value = card[field]
  return value == null || value === '' ? [] : [value]
}

function facetHit(card, endpoint, id) {
  const want = id.toLowerCase()
  return facetValues(card, endpoint).some((value) => String(value).toLowerCase() === want)
}

function coerceFacetName(endpoint, id) {
  if (endpoint === 'hp' || endpoint === 'retreats' || endpoint === 'dex-ids') {
    const parsed = Number.parseInt(id, 10)
    if (String(parsed) === id) return parsed
  }
  return id
}

function applySortAndPage(items, query, allowedFields) {
  const sorted = query.sort && allowedFields.has(query.sort.field) ? sortItems(items, query.sort) : items
  return paginate(sorted, query.page, query.limit)
}

function findById(items, id) {
  return items.find((item) => keyOf(item.id) === id.toLowerCase()) || null
}

function findByName(items, name) {
  return items.find((item) => String(item.name || '').toLowerCase() === name.toLowerCase()) || null
}

function keyOf(value) {
  return String(value || '').toLowerCase()
}

function parseRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] !== 'v2' || parts.length < 2 || parts.length > 5) return null
  const clean = (value) => (value ? value.replace(/\.json$/i, '') : undefined)
  return {
    version: 'v2',
    lang: clean(parts[1]),
    endpoint: clean(parts[2]),
    id: clean(parts[3]),
    subid: clean(parts[4]),
  }
}

async function safeUpstream(fetchUpstream) {
  try {
    return await fetchUpstream()
  } catch {
    return null
  }
}

function passthrough(upstream) {
  if (!upstream) return { status: 502, source: 'upstream', body: badGateway() }
  return { status: upstream.status, source: 'upstream', body: upstream.json ?? upstream.text, pass: false }
}

function notFoundBody(url) {
  return {
    type: 'https://tcgdex.dev/errors/not-found',
    title: 'The resource you are trying to reach does not exists',
    status: 404,
    endpoint: `${url.pathname}${url.search}`,
    method: 'GET',
  }
}

function badGateway() {
  return {
    type: 'https://tcgdex.dev/errors/general',
    title: 'The upstream TCGdex server is unavailable',
    status: 502,
  }
}
