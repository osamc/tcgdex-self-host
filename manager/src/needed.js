import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isLanguage } from './languages.js'

const NAME_MAX = 200
const SHORT_MAX = 80
const NOTE_MAX = 1000

export function createNeeded(dir) {
  const file = path.join(path.resolve(dir), 'needed.json')

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!parsed || !Array.isArray(parsed.items)) return []
      return parsed.items.filter(isItem).map(normalizeStored)
    } catch {
      return []
    }
  }

  function write(items) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify({ items }, null, 2)}\n`)
    fs.renameSync(temp, file)
  }

  return {
    list() {
      return read().sort(byOpenThenNewest)
    },
    add(input) {
      const items = read()
      const saved = {
        id: randomUUID(),
        lang: cleanLang(input?.lang || 'en'),
        name: cleanName(input?.name, true),
        set: cleanShort(input?.set),
        localId: cleanShort(input?.localId),
        notes: cleanNotes(input?.notes),
        done: false,
        createdAt: new Date().toISOString(),
      }
      items.push(saved)
      write(items)
      return saved
    },
    update(id, input) {
      const items = read()
      const index = items.findIndex((item) => item.id === id)
      if (index < 0) return null
      const next = { ...items[index] }
      if (input?.name !== undefined) next.name = cleanName(input.name, true)
      if (input?.set !== undefined) next.set = cleanShort(input.set)
      if (input?.localId !== undefined) next.localId = cleanShort(input.localId)
      if (input?.notes !== undefined) next.notes = cleanNotes(input.notes)
      if (input?.lang !== undefined) next.lang = cleanLang(input.lang)
      if (input?.done !== undefined) next.done = Boolean(input.done)
      items[index] = next
      write(items)
      return next
    },
    remove(id) {
      const items = read()
      const next = items.filter((item) => item.id !== id)
      if (next.length === items.length) return false
      write(next)
      return true
    },
  }
}

function isItem(item) {
  return Boolean(item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string')
}

function normalizeStored(item) {
  return {
    id: item.id,
    lang: typeof item.lang === 'string' ? item.lang : 'en',
    name: item.name,
    set: typeof item.set === 'string' ? item.set : '',
    localId: typeof item.localId === 'string' ? item.localId : '',
    notes: typeof item.notes === 'string' ? item.notes : '',
    done: Boolean(item.done),
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
  }
}

function byOpenThenNewest(left, right) {
  if (left.done !== right.done) return left.done ? 1 : -1
  return String(right.createdAt).localeCompare(String(left.createdAt))
}

function cleanLang(value) {
  const lang = String(value || '').trim()
  if (!isLanguage(lang)) fail('language is invalid')
  return lang
}

function cleanName(value, required) {
  const name = String(value || '').trim()
  if (required && !name) fail('name is required')
  if (name.length > NAME_MAX) fail('name is too long')
  return name
}

function cleanShort(value) {
  const text = String(value || '').trim()
  if (text.length > SHORT_MAX) fail('set or local id is too long')
  return text
}

function cleanNotes(value) {
  const text = String(value || '').trim()
  if (text.length > NOTE_MAX) fail('notes are too long')
  return text
}

function fail(message) {
  throw Object.assign(new Error(message), { status: 400 })
}
