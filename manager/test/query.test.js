import assert from 'node:assert/strict'
import test from 'node:test'
import { matches, paginate, parseQuery, sortItems } from '../src/query.js'

const cards = [
  { id: 'a', name: 'Furret', hp: 110, localId: '2', set: { id: 'swsh3', name: 'Darkness Ablaze' } },
  { id: 'b', name: 'Pikachu', hp: 60, localId: '10', set: { id: 'base1', name: 'Base Set' } },
  { id: 'c', name: 'Stufful', hp: 70, localId: '1', set: { id: 'demo', name: 'Demo Set' } },
]

const aliases = { set: (card) => [card.set?.id, card.set?.name] }

test('contains, exact, wildcard, and numeric filters follow the TCGdex query language', () => {
  const contains = parseQuery(new URLSearchParams('name=fur'))
  assert.deepEqual(cards.filter((card) => matches(card, contains.filters)).map((card) => card.id), ['a'])

  const exact = parseQuery(new URLSearchParams('name=eq:Furret|Pikachu'))
  assert.deepEqual(cards.filter((card) => matches(card, exact.filters)).map((card) => card.id), ['a', 'b'])

  const prefix = parseQuery(new URLSearchParams('name=fu*'))
  assert.deepEqual(cards.filter((card) => matches(card, prefix.filters)).map((card) => card.id), ['a'])

  const suffix = parseQuery(new URLSearchParams('name=*chu'))
  assert.deepEqual(cards.filter((card) => matches(card, suffix.filters)).map((card) => card.id), ['b'])

  const hp = parseQuery(new URLSearchParams('hp=gte:70'))
  assert.deepEqual(cards.filter((card) => matches(card, hp.filters)).map((card) => card.id), ['a', 'c'])

  const bySet = parseQuery(new URLSearchParams('set=eq:demo'))
  assert.deepEqual(cards.filter((card) => matches(card, bySet.filters, aliases)).map((card) => card.id), ['c'])
})

test('sort and pagination run after filtering', () => {
  const query = parseQuery(new URLSearchParams('sort:field=localId&sort:order=ASC&pagination:page=2&pagination:itemsPerPage=1'))
  const sorted = sortItems(cards, query.sort)
  assert.deepEqual(sorted.map((card) => card.localId), ['1', '2', '10'])
  assert.deepEqual(paginate(sorted, query.page, query.limit).map((card) => card.id), ['a'])
})
