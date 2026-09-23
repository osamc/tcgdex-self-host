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
  const groups = []
  if (parsed.quality === 'low') {
    groups.push(qualityFiles(root, parsed.stem, 'low'))
    groups.push(qualityFiles(root, parsed.stem, 'high'))
    groups.push(flatFiles(root, parsed.stem, parsed.requested))
  } else if (parsed.quality === 'high') {
    groups.push(qualityFiles(root, parsed.stem, 'high'))
    groups.push(flatFiles(root, parsed.stem, parsed.requested))
    groups.push(qualityFiles(root, parsed.stem, 'low'))
  } else {
    groups.push(flatFiles(root, parsed.stem, parsed.requested))
    groups.push(qualityFiles(root, parsed.stem, 'high'))
    groups.push(qualityFiles(root, parsed.stem, 'low'))
  }
  for (const group of groups) {
    const hit = newestExisting(root, group)
    if (hit) return hit
  }
  return null
}

/**
 * Write an upload and drop earlier files for the same card/quality
 * so a new png/webp actually replaces the previous image.
 */
export function writeImageFile(dataDir, rel, bytes) {
  const safe = safeImageRelPath(rel)
  if (!safe) return null
  const root = path.resolve(dataDir, 'images')
  const parts = safe.split('/')
  if (parts.length === 2) {
    const [stem, file] = parts
    const quality = path.basename(file, path.extname(file))
    for (const ext of IMAGE_EXTENSIONS) removeUnder(root, stem, `${quality}${ext}`)
  } else {
    const stem = stemOf(parts[0])
    for (const ext of IMAGE_EXTENSIONS) {
      removeUnder(root, `${stem}${ext}`)
      removeUnder(root, stem, `high${ext}`)
    }
  }
  const dest = path.join(root, safe)
  if (!dest.startsWith(root + path.sep)) return null
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, bytes)
  return dest
}

function qualityFiles(root, stem, quality) {
  return IMAGE_EXTENSIONS.map((ext) => path.join(root, stem, `${quality}${ext}`))
}

function flatFiles(root, stem, requested) {
  const files = IMAGE_EXTENSIONS.map((ext) => path.join(root, `${stem}${ext}`))
  if (requested && requested !== stem) files.unshift(path.join(root, requested))
  return files
}

function newestExisting(root, files) {
  let best = null
  let bestTime = -1
  for (const file of files) {
    if (!file.startsWith(root + path.sep)) continue
    try {
      if (!fs.existsSync(file)) continue
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      if (stat.mtimeMs >= bestTime) {
        best = file
        bestTime = stat.mtimeMs
      }
    } catch {
      // Ignore unreadable candidates and keep looking.
    }
  }
  return best
}

function removeUnder(root, ...segments) {
  const file = path.resolve(root, ...segments)
  if (!file.startsWith(root + path.sep)) return
  try {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.unlinkSync(file)
  } catch {
    // A leftover sibling must not block the new upload.
  }
}
