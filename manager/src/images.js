import fs from 'node:fs'
import path from 'node:path'

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
export const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
export const QUALITIES = ['high', 'low']

const STEM_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/
const EXT_SET = new Set(IMAGE_EXTENSIONS)

export function extensionOf(name) {
  const ext = path.extname(String(name || '').toLowerCase())
  return EXT_SET.has(ext) ? ext : ''
}

export function stemOf(name) {
  const lower = String(name || '').toLowerCase()
  const ext = extensionOf(lower)
  const stem = ext ? lower.slice(0, -ext.length) : lower
  return STEM_RE.test(stem) ? stem : null
}

/**
 * Sanitize an upload path: `card.png` or `card/low.webp`.
 */
export function safeImageRelPath(name) {
  const lower = String(name || '').toLowerCase().replace(/\\/g, '/')
  if (!lower || lower.includes('..') || lower.startsWith('/')) return null
  const parts = lower.split('/').filter(Boolean)
  if (parts.length === 1) {
    return extensionOf(parts[0]) && stemOf(parts[0]) ? parts[0] : null
  }
  if (parts.length === 2) {
    if (!STEM_RE.test(parts[0])) return null
    const ext = extensionOf(parts[1])
    const quality = ext ? parts[1].slice(0, -ext.length) : ''
    if (!QUALITIES.includes(quality) || !ext) return null
    return `${parts[0]}/${parts[1]}`
  }
  return null
}

export function publicAssetPath(rel) {
  const parts = String(rel || '').toLowerCase().replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length === 2) return `/assets/${parts[0]}`
  const stem = stemOf(parts[0] || '')
  return stem ? `/assets/${stem}` : null
}

/**
 * Official TCGdex clients append /high.webp to the image field.
 * Strip a file extension from local /assets/ URLs so they match that shape.
 */
export function publicAssetUrl(value) {
  if (!value || typeof value !== 'string') return value
  try {
    const absolute = /^https?:\/\//i.test(value)
    const url = absolute ? new URL(value) : new URL(value, 'http://tcgdex.invalid')
    const match = url.pathname.match(/^\/assets\/([^/]+)$/i)
    if (!match) return value
    const file = match[1]
    const stem = stemOf(file)
    if (!stem || !extensionOf(file)) return value
    url.pathname = `/assets/${stem}`
    return absolute ? url.href : `${url.pathname}${url.search}`
  } catch {
    return value
  }
}

export function parseAssetRequest(pathname) {
  const raw = String(pathname || '')
  if (!raw.startsWith('/assets')) return null
  const rest = raw.slice('/assets'.length).replace(/^\/+/, '')
  if (!rest || rest.includes('..')) return null
  const parts = rest.split('/').filter(Boolean).map((part) => part.toLowerCase())
  if (parts.length === 1) {
    const stem = stemOf(parts[0])
    if (!stem) return null
    return { stem, requested: parts[0], quality: null, ext: extensionOf(parts[0]) }
  }
  if (parts.length === 2) {
    const ext = extensionOf(parts[1])
    const quality = ext ? parts[1].slice(0, -ext.length) : ''
    if (!QUALITIES.includes(quality) || !ext) return null
    const stem = stemOf(parts[0])
    if (!stem) return null
    return { stem, requested: parts[0], quality, ext }
  }
  return null
}

export function resolveImageFile(dataDir, pathname) {
  const parsed = parseAssetRequest(pathname)
  if (!parsed) return null
  const root = path.resolve(dataDir, 'images')
  for (const file of candidateFiles(root, parsed)) {
    if (!file.startsWith(root + path.sep)) continue
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
    } catch {
      // Ignore unreadable candidates and keep looking.
    }
  }
  return null
}

function candidateFiles(root, parsed) {
  const out = []
  const add = (...segments) => out.push(path.join(root, ...segments))
  if (parsed.quality) {
    add(parsed.stem, `${parsed.quality}${parsed.ext}`)
    for (const ext of IMAGE_EXTENSIONS) add(parsed.stem, `${parsed.quality}${ext}`)
    if (parsed.quality === 'low') {
      add(parsed.stem, `high${parsed.ext}`)
      for (const ext of IMAGE_EXTENSIONS) add(parsed.stem, `high${ext}`)
    }
  }
  if (parsed.requested !== parsed.stem) add(parsed.requested)
  for (const ext of IMAGE_EXTENSIONS) add(`${parsed.stem}${ext}`)
  for (const quality of QUALITIES) {
    for (const ext of IMAGE_EXTENSIONS) add(parsed.stem, `${quality}${ext}`)
  }
  return out
}
