export function createUpstream(baseUrl, { ttlMs = 300000, maxEntries = 32, timeoutMs = 60000 } = {}) {
  const base = baseUrl.replace(/\/$/, '')
  const cache = new Map()

  async function request(pathname, search = '', { cacheable = true } = {}) {
    const path = `${pathname}${search}`
    const key = `GET ${path}`
    const cached = cache.get(key)
    if (cacheable && cached && cached.expires > Date.now()) {
      cache.delete(key)
      cache.set(key, cached)
      return cached.value
    }

    const response = await fetch(`${base}${path}`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    const contentType = response.headers.get('content-type') || ''
    const text = await response.text()
    let json = null
    if (contentType.includes('json') || text.startsWith('{') || text.startsWith('[')) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    const value = {
      status: response.status,
      contentType,
      text,
      json,
      headers: Object.fromEntries(response.headers.entries()),
    }
    if (cacheable && response.status === 200 && json != null && text.length < 20_000_000) {
      cache.set(key, { expires: Date.now() + ttlMs, value })
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value
        cache.delete(oldest)
      }
    }
    return value
  }

  return {
    request,
    async ping() {
      try {
        const response = await fetch(`${base}/ping`, { signal: AbortSignal.timeout(3000) })
        return response.ok
      } catch {
        return false
      }
    },
  }
}
