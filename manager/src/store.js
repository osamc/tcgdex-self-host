import fs from 'node:fs'
import path from 'node:path'
import { isLanguage } from './languages.js'

const KINDS = {
  cards: 'cards',
  sets: 'sets',
  series: 'series',
}

// TCGdex ids are mostly [A-Za-z0-9._-], but Unseen Forces Unown cards include
// punctuation forms such as exu-! and exu-%3F.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._%!-]{0,120}$/
const LOCAL_ID_PATTERN = /^[A-Za-z0-9._%!-]{1,40}$/

export const ID_MAX_LENGTH = 121
export const LOCAL_ID_MAX_LENGTH = 40

export function isSafeId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) && !value.includes('..')
}

export function isSafeLocalId(value) {
  return typeof value === 'string' && LOCAL_ID_PATTERN.test(value) && !value.includes('..')
}

/**
 * Next unused id for a duplicated record. `taken` is compared case-insensitively.
 * The suffix is `-copy`, then `-copy-2`, `-copy-3`, and so on.
 */
export function nextCopyId(original, taken, maxLength) {
  const used = new Set()
  for (const value of taken || []) used.add(String(value).toLowerCase())
  const stem = String(original)
  for (let n = 1; n < 1000; n += 1) {
    const suffix = n === 1 ? '-copy' : `-copy-${n}`
    if (suffix.length >= maxLength) break
    const candidate = `${stem.slice(0, maxLength - suffix.length)}${suffix}`
    if (!candidate.includes('..') && !used.has(candidate.toLowerCase())) return candidate
  }
  throw new Error('could not find an unused copy id')
}

export function createStore(dir) {
  const root = path.resolve(dir)
  fs.mkdirSync(root, { recursive: true })
  for (const kind of Object.keys(KINDS)) {
    fs.mkdirSync(path.join(root, kind), { recursive: true })
  }

  let cache = null

  function invalidate() {
    cache = null
  }

  try {
    const watcher = fs.watch(root, { recursive: true }, () => invalidate())
    watcher.on('error', () => {})
    watcher.unref?.()
  } catch {
    // Watching is a convenience. Writes through the store still invalidate.
  }

  function readCatalog() {
    if (cache) return cache
    const problems = []
    const buckets = { cards: [], sets: [], series: [] }
    for (const kind of Object.keys(KINDS)) {
      const kindDir = path.join(root, kind)
      if (!fs.existsSync(kindDir)) continue
      for (const lang of fs.readdirSync(kindDir)) {
        const langDir = path.join(kindDir, lang)
        if (!fs.statSync(langDir).isDirectory()) continue
        if (!isLanguage(lang)) {
          problems.push({ file: path.join(kind, lang), message: 'unknown language folder' })
          continue
        }
        for (const file of fs.readdirSync(langDir)) {
          if (!file.endsWith('.json')) continue
          const full = path.join(langDir, file)
          try {
            const body = JSON.parse(fs.readFileSync(full, 'utf8'))
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
              throw new Error('expected a JSON object')
            }
            if (!isSafeId(String(body.id || ''))) {
              throw new Error('id is missing or uses unsupported characters')
            }
            if (body.id.toLowerCase() !== file.slice(0, -5).toLowerCase()) {
              throw new Error('filename does not match id')
            }
            buckets[kind].push({ ...body, _lang: lang })
          } catch (error) {
            problems.push({ file: path.join(kind, lang, file), message: error.message })
          }
        }
      }
    }
    cache = { ...buckets, problems }
    return cache
  }

  function forLang(kind, lang) {
    return readCatalog()[kind].filter((item) => item._lang === lang).map((item) => ({ ...item }))
  }

  return {
    root,
    invalidate,
    problems() {
      return readCatalog().problems.map((problem) => ({ ...problem }))
    },
    snapshot(lang) {
      return {
        cards: forLang('cards', lang),
        sets: forLang('sets', lang),
        series: forLang('series', lang),
      }
    },
    list() {
      const catalog = readCatalog()
      const summarize = (kind, pick) => catalog[kind].map((item) => pick(item))
      return {
        cards: summarize('cards', (item) => ({
          lang: item._lang,
          id: item.id,
          name: item.name,
          localId: item.localId,
          category: item.category,
          setId: item.set?.id || '',
          setName: item.set?.name || '',
          upstream: Boolean(item._meta?.upstream),
        })),
        sets: summarize('sets', (item) => ({
          lang: item._lang,
          id: item.id,
          name: item.name,
          serieId: item.serie?.id || '',
          serieName: item.serie?.name || '',
          upstream: Boolean(item._meta?.upstream),
        })),
        series: summarize('series', (item) => ({
          lang: item._lang,
          id: item.id,
          name: item.name,
          upstream: Boolean(item._meta?.upstream),
        })),
        problems: catalog.problems,
      }
    },
    get(kind, lang, id) {
      assertKind(kind)
      const found = readCatalog()[kind].find(
        (item) => item._lang === lang && item.id.toLowerCase() === id.toLowerCase(),
      )
      if (!found) return null
      const copy = { ...found }
      delete copy._lang
      return copy
    },
    put(kind, lang, id, body) {
      assertKind(kind)
      if (!isLanguage(lang)) throw new Error('unknown language')
      if (!isSafeId(id)) throw new Error('invalid id')
      const file = filePath(root, kind, lang, id)
      const json = `${JSON.stringify(body, null, 2)}\n`
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(temp, json)
      fs.renameSync(temp, file)
      invalidate()
    },
    remove(kind, lang, id) {
      assertKind(kind)
      if (!isLanguage(lang) || !isSafeId(id)) return false
      const file = filePath(root, kind, lang, id)
      if (!fs.existsSync(file)) return false
      fs.unlinkSync(file)
      invalidate()
      return true
    },
    exportDocument() {
      const catalog = readCatalog()
      const publish = (item) => {
        const copy = JSON.parse(JSON.stringify(item))
        const lang = copy._lang
        delete copy._meta
        delete copy._lang
        return { lang, ...copy }
      }
      const byLangThenId = (left, right) => left.lang.localeCompare(right.lang) || String(left.id).localeCompare(String(right.id))
      return {
        cards: catalog.cards.map(publish).sort(byLangThenId),
        sets: catalog.sets.map(publish).sort(byLangThenId),
        series: catalog.series.map(publish).sort(byLangThenId),
      }
    },
  }
}

function assertKind(kind) {
  if (!KINDS[kind]) throw new Error('unknown catalog kind')
}

function filePath(root, kind, lang, id) {
  const file = path.resolve(root, kind, lang, `${id.toLowerCase()}.json`)
  const allowed = path.resolve(root, kind, lang)
  if (!file.startsWith(`${allowed}${path.sep}`)) throw new Error('invalid path')
  return file
}

export function validateCard(card) {
  const errors = []
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return ['card must be a JSON object']
  }
  if (!isSafeId(String(card.id || ''))) {
    errors.push('id is required and may contain letters, numbers, dots, underscores, hyphens, %, and !')
  }
  if (!isSafeLocalId(String(card.localId ?? ''))) {
    errors.push('localId is required and may contain letters, numbers, dots, underscores, hyphens, %, and !')
  }
  if (!card.name || typeof card.name !== 'string') errors.push('name is required')
  if (!['Pokemon', 'Energy', 'Trainer'].includes(card.category)) {
    errors.push('category must be Pokemon, Energy, or Trainer')
  }
  if (!card.set || !isSafeId(String(card.set.id || '')) || !card.set.name) {
    errors.push('set.id and set.name are required')
  }
  if (!card.variants || typeof card.variants !== 'object' || Array.isArray(card.variants)) {
    errors.push('variants object is required')
  }
  return errors
}

export function validateSet(set) {
  const errors = []
  if (!set || typeof set !== 'object' || Array.isArray(set)) return ['set must be a JSON object']
  if (!isSafeId(String(set.id || ''))) errors.push('id is required')
  if (!set.name || typeof set.name !== 'string') errors.push('name is required')
  if (set.serie && (!isSafeId(String(set.serie.id || '')) || !set.serie.name)) {
    errors.push('serie.id and serie.name are both required when serie is set')
  }
  return errors
}

export function validateSerie(serie) {
  const errors = []
  if (!serie || typeof serie !== 'object' || Array.isArray(serie)) return ['series must be a JSON object']
  if (!isSafeId(String(serie.id || ''))) errors.push('id is required')
  if (!serie.name || typeof serie.name !== 'string') errors.push('name is required')
  return errors
}
