import fs from 'node:fs'
import path from 'node:path'

const RECENT_LIMIT = 1000
const RETENTION_MS = 24 * 60 * 60 * 1000

export function createMetrics(dir) {
  const file = path.join(dir, 'metrics.json')
  const recent = []
  const minutes = new Map()

  load(file, minutes)

  let timer = null
  function schedulePersist() {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      persist(file, minutes)
    }, 5000)
    timer.unref?.()
  }

  function record(event) {
    const now = Date.now()
    recent.push({
      at: new Date(now).toISOString(),
      method: event.method,
      path: event.path,
      template: event.template,
      status: event.status,
      ms: event.ms,
      source: event.source || 'upstream',
    })
    if (recent.length > RECENT_LIMIT) recent.shift()

    const key = new Date(now).toISOString().slice(0, 16)
    const bucket = minutes.get(key) || { count: 0, errors: 0, latencySum: 0, statuses: {}, paths: {} }
    bucket.count += 1
    bucket.latencySum += event.ms
    if (event.status >= 400) bucket.errors += 1
    const statusKey = String(event.status)
    bucket.statuses[statusKey] = (bucket.statuses[statusKey] || 0) + 1
    const pathKey = `${event.method} ${event.template}`
    bucket.paths[pathKey] = (bucket.paths[pathKey] || 0) + 1
    minutes.set(key, bucket)
    prune(minutes, now)
    schedulePersist()
  }

  function snapshot() {
    const now = Date.now()
    prune(minutes, now)
    const minuteSeries = []
    const cursor = new Date(now)
    cursor.setUTCSeconds(0, 0)
    for (let offset = 59; offset >= 0; offset -= 1) {
      const stamp = new Date(cursor.getTime() - offset * 60000)
      const key = stamp.toISOString().slice(0, 16)
      const bucket = minutes.get(key)
      minuteSeries.push({
        t: key,
        count: bucket?.count || 0,
        errors: bucket?.errors || 0,
        avgMs: bucket?.count ? Math.round(bucket.latencySum / bucket.count) : 0,
      })
    }

    return {
      now: new Date(now).toISOString(),
      windows: {
        '1m': windowStats(minutes, recent, now, 60 * 1000),
        '15m': windowStats(minutes, recent, now, 15 * 60 * 1000),
        '24h': windowStats(minutes, recent, now, RETENTION_MS),
      },
      minutes: minuteSeries,
      statuses: collectStatuses(minutes, now, RETENTION_MS),
      paths: collectPaths(minutes, now, RETENTION_MS),
      recent: recent.slice(-40).reverse(),
    }
  }

  return {
    record,
    snapshot,
    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      persist(file, minutes)
    },
  }
}

function windowStats(minutes, recent, now, span) {
  const cutoff = now - span
  let count = 0
  let errors = 0
  let latencySum = 0
  for (const [key, bucket] of minutes) {
    if (bucketTime(key) < cutoff) continue
    count += bucket.count
    errors += bucket.errors
    latencySum += bucket.latencySum
  }
  const samples = recent.filter((event) => Date.parse(event.at) >= cutoff).map((event) => event.ms).sort((a, b) => a - b)
  return {
    count,
    errors,
    avgMs: count ? Math.round(latencySum / count) : 0,
    p95Ms: percentile(samples, 0.95),
  }
}

function collectStatuses(minutes, now, span) {
  const cutoff = now - span
  const statuses = {}
  for (const [key, bucket] of minutes) {
    if (bucketTime(key) < cutoff) continue
    for (const [status, count] of Object.entries(bucket.statuses)) {
      statuses[status] = (statuses[status] || 0) + count
    }
  }
  return statuses
}

function collectPaths(minutes, now, span) {
  const cutoff = now - span
  const paths = new Map()
  for (const [key, bucket] of minutes) {
    if (bucketTime(key) < cutoff) continue
    for (const [name, count] of Object.entries(bucket.paths)) {
      paths.set(name, (paths.get(name) || 0) + count)
    }
  }
  return [...paths.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)
}

function percentile(samples, ratio) {
  if (samples.length === 0) return 0
  const index = Math.min(samples.length - 1, Math.ceil(samples.length * ratio) - 1)
  return samples[Math.max(index, 0)]
}

function bucketTime(key) {
  return Date.parse(`${key}:00.000Z`)
}

function prune(minutes, now) {
  const cutoff = now - RETENTION_MS
  for (const key of minutes.keys()) {
    if (bucketTime(key) < cutoff) minutes.delete(key)
  }
}

function load(file, minutes) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return
    for (const [key, bucket] of Object.entries(parsed)) {
      if (!bucket || typeof bucket.count !== 'number') continue
      minutes.set(key, {
        count: bucket.count,
        errors: bucket.errors || 0,
        latencySum: bucket.latencySum || 0,
        statuses: bucket.statuses || {},
        paths: bucket.paths || {},
      })
    }
    prune(minutes, Date.now())
  } catch {
    // A missing metrics file is the normal first boot.
  }
}

function persist(file, minutes) {
  const data = Object.fromEntries(minutes)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(data))
    fs.renameSync(temp, file)
  } catch {
    // Metrics are best-effort. A read-only data dir should not take down the API.
  }
}

export function templatePath(pathname) {
  const parts = pathname.split('?')[0].split('/').filter(Boolean)
  if (parts[0] !== 'v2') return pathname.split('?')[0] || '/'
  const endpoint = (parts[2] || '').replace(/\.json$/i, '')
  const labels = [parts[0], ':lang', endpoint].filter(Boolean)
  if (parts[3]) labels.push(':id')
  if (parts[4]) labels.push(':subid')
  if (parts.length > 5) labels.push('*')
  return `/${labels.join('/')}`
}
