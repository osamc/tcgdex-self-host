const PREFIXES = new Set([
  'like',
  'not',
  'notlike',
  'eq',
  'neq',
  'gte',
  'gt',
  'lt',
  'lte',
  'null',
  'notnull',
])

/**
 * Parse a TCGdex list query.
 * Operators follow https://tcgdex.dev/rest/filtering-sorting-pagination
 * @param {URLSearchParams} searchParams
 */
export function parseQuery(searchParams) {
  const filters = {}
  let page = null
  let limit = null
  let sort = null

  const sortField = searchParams.get('sort:field')
  if (sortField) {
    const order = String(searchParams.get('sort:order') || 'ASC').toUpperCase()
    sort = { field: sortField, order: order === 'DESC' ? 'DESC' : 'ASC' }
  }

  for (const [key, value] of searchParams) {
    if (key === 'pagination:page') {
      page = Number.parseInt(value, 10)
      continue
    }
    if (key === 'pagination:itemsPerPage') {
      limit = Number.parseInt(value, 10)
      continue
    }
    if (key === 'sort:field' || key === 'sort:order') continue
    const parsed = parseParam(value)
    filters[key] = filters[key] ? { $and: [filters[key], parsed] } : parsed
  }

  return {
    filters,
    sort,
    page: Number.isFinite(page) ? page : null,
    limit: Number.isFinite(limit) ? limit : null,
  }
}

export function withoutPagination(url) {
  const copy = new URL(url)
  copy.searchParams.delete('pagination:page')
  copy.searchParams.delete('pagination:itemsPerPage')
  return copy
}

function parseParam(value) {
  let filter = 'like'
  let compared = value
  const colon = value.indexOf(':')
  if (colon >= 2) {
    const prefix = value.slice(0, colon)
    if (PREFIXES.has(prefix)) {
      filter = prefix
      compared = value.slice(colon + 1)
    }
  }

  const process = (item) => {
    switch (filter) {
      case 'not':
      case 'notlike':
        return { $not: { $inc: item } }
      case 'eq':
        return { $eq: item }
      case 'neq':
        return { $not: item }
      case 'gte':
        return { $gte: item }
      case 'gt':
        return { $gt: item }
      case 'lt':
        return { $lt: item }
      case 'lte':
        return { $lte: item }
      case 'null':
        return null
      case 'notnull':
        return { $not: null }
      default:
        return { $inc: item }
    }
  }

  if (/^\d+\.?\d*$/.test(compared)) {
    return process(Number.parseFloat(compared))
  }

  const parts = compared.includes('|') ? compared.split('|') : compared.split(',')
  if (parts.length === 1) return process(parts[0])
  return { $or: parts.map((part) => process(part)) }
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown>} filters
 * @param {Record<string, (item: any) => unknown[]>} [aliases]
 */
export function matches(item, filters, aliases = {}) {
  for (const [key, expected] of Object.entries(filters)) {
    if (aliases[key]) {
      const values = aliases[key](item).filter((value) => value != null)
      if (!matchAny(expected, values)) return false
      continue
    }
    const actual = key.includes('.') ? getPath(item, key) : item?.[key]
    if (!fieldMatches(expected, actual)) return false
  }
  return true
}

function matchAny(expected, values) {
  if (values.length === 0) return fieldMatches(expected, undefined)
  if (isNegative(expected)) return values.every((value) => fieldMatches(expected, value))
  return values.some((value) => fieldMatches(expected, value))
}

function isNegative(expected) {
  return Boolean(expected && typeof expected === 'object' && '$not' in expected)
}

function fieldMatches(expected, actual) {
  if (Array.isArray(actual)) return actual.some((value) => fieldMatches(expected, value))
  if (actual && typeof actual === 'object') {
    return Object.values(actual).some((value) => {
      if (value && typeof value === 'object') return false
      return fieldMatches(expected, value)
    })
  }
  return matchValue(expected, actual)
}

function matchValue(expected, actual) {
  if (expected === null) return actual == null
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return strictEqual(actual, expected)
  }
  if ('$or' in expected) return expected.$or.some((part) => matchValue(part, actual))
  if ('$and' in expected) return expected.$and.every((part) => matchValue(part, actual))
  if ('$not' in expected) {
    if (expected.$not && typeof expected.$not === 'object' && '$inc' in expected.$not) {
      return !containsLike(actual, expected.$not.$inc)
    }
    if (expected.$not === null) return actual != null
    return !strictEqual(actual, expected.$not)
  }
  if ('$eq' in expected) return strictEqual(actual, expected.$eq)
  if ('$inc' in expected) return containsLike(actual, expected.$inc)
  if ('$gte' in expected) return compareNum(actual, expected.$gte) >= 0
  if ('$gt' in expected) return compareNum(actual, expected.$gt) > 0
  if ('$lte' in expected) return compareNum(actual, expected.$lte) <= 0
  if ('$lt' in expected) return compareNum(actual, expected.$lt) < 0
  return false
}

function strictEqual(actual, expected) {
  if (actual == null) return expected == null
  if (typeof expected === 'number') {
    const parsed = typeof actual === 'number' ? actual : Number.parseFloat(actual)
    return parsed === expected
  }
  return String(actual).toLowerCase() === String(expected).toLowerCase()
}

function containsLike(actual, expected) {
  if (actual == null) return false
  const haystack = String(actual).toLowerCase()
  let needle = String(expected).toLowerCase()
  const startWild = needle.startsWith('*')
  const endWild = needle.endsWith('*') && needle.length > 1
  if (startWild) needle = needle.slice(1)
  if (endWild) needle = needle.slice(0, -1)
  if (startWild && endWild) return haystack.includes(needle)
  if (startWild) return haystack.endsWith(needle)
  if (endWild) return haystack.startsWith(needle)
  return haystack.includes(needle)
}

function compareNum(actual, expected) {
  const value = typeof actual === 'number' ? actual : Number.parseFloat(actual)
  const target = typeof expected === 'number' ? expected : Number.parseFloat(expected)
  if (!Number.isFinite(value) || !Number.isFinite(target)) return Number.NaN
  return value - target
}

function getPath(obj, path) {
  return path.split('.').reduce((current, key) => (current == null ? undefined : current[key]), obj)
}

export function sortItems(items, sort) {
  if (!sort?.field) return items
  const direction = sort.order === 'DESC' ? -1 : 1
  return [...items].sort((a, b) => direction * compareSort(a?.[sort.field], b?.[sort.field]))
}

function compareSort(a, b) {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  const left = tryParse(a)
  const right = tryParse(b)
  if (left != null && right != null) return left - right
  return String(a).localeCompare(String(b))
}

function tryParse(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10)
  return null
}

export function paginate(items, page, limit) {
  if (page == null && limit == null) return items
  const size = limit == null ? 100 : limit
  if (!Number.isFinite(size) || size < 1) return items
  const current = page == null ? 1 : Math.max(page, 1)
  const start = size * (current - 1)
  return items.slice(start, start + size)
}

const BETTER_SORTER = (a, b) => {
  const left = Number.parseInt(a, 10)
  const right = Number.parseInt(b, 10)
  if (!Number.isNaN(left) && !Number.isNaN(right) && String(left) === String(a) && String(right) === String(b)) {
    return left - right
  }
  return String(a) >= String(b) ? 1 : -1
}

export function uniqueSorted(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    if (value == null || value === '') continue
    const key = typeof value === 'number' ? `n:${value}` : `s:${String(value).toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out.sort(BETTER_SORTER)
}
