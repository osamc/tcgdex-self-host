const app = document.querySelector('#app')
const LANGUAGES = ['en', 'fr', 'es', 'es-mx', 'it', 'pt', 'pt-br', 'pt-pt', 'de', 'nl', 'pl', 'ru', 'ja', 'ko', 'zh-tw', 'id', 'th', 'zh-cn']
const KINDS = ['cards', 'sets', 'series']
const SEARCH_LIMIT = 240

const state = {
  token: read(sessionStorage, 'tcgdex-token') || '',
  lang: LANGUAGES.includes(read(localStorage, 'tcgdex-lang')) ? read(localStorage, 'tcgdex-lang') : 'en',
  origin: read(localStorage, 'tcgdex-origin') || location.origin,
  metrics: null,
  catalog: { cards: [], sets: [], series: [], problems: [] },
  editing: null,
  returnTo: '',
  suppressHash: false,
  renderId: 0,
}
const browseCache = new Map()

window.addEventListener('hashchange', onHashChange)
window.addEventListener('beforeunload', (event) => {
  if (isDirty()) event.preventDefault()
})
document.addEventListener('keydown', (event) => {
  if (state.editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    saveDraft()
  }
})
// Set logos are requested as .webp first; fall back to the stored URL, then hide.
document.addEventListener('error', (event) => {
  const img = event.target
  if (!(img instanceof HTMLImageElement)) return
  if (img.dataset.fallback) {
    const next = img.dataset.fallback
    delete img.dataset.fallback
    img.src = next
  } else {
    img.classList.add('broken')
  }
}, true)

setInterval(() => {
  if (state.token && route().view === 'dashboard' && !state.editing) {
    refresh().then(() => {
      const main = app.querySelector('#main')
      if (main && route().view === 'dashboard') main.innerHTML = dashboardHtml()
    }).catch(() => {})
  }
}, 5000)

boot()

async function boot() {
  if (!state.token) return renderLogin()
  try {
    await refresh()
  } catch (error) {
    if (error.message === 'unauthorized') return
    state.bootError = error.message
  }
  onRoute()
}

// ---------------------------------------------------------------- routing

function route() {
  const raw = location.hash.replace(/^#\/?/, '')
  const [pathPart, queryPart = ''] = raw.split('?')
  const parts = pathPart.split('/').filter(Boolean).map(safeDecode)
  return { view: parts[0] || 'dashboard', parts: parts.slice(1), query: new URLSearchParams(queryPart), hash: `#/${raw}` }
}

function isEditorView(view) {
  return view === 'edit' || view === 'new'
}

function go(hash) {
  if (location.hash === hash) onRoute()
  else location.hash = hash
}

function onHashChange(event) {
  if (state.suppressHash) {
    state.suppressHash = false
    return
  }
  const next = route()
  if (state.editing && next.hash !== state.editing.hash && isDirty() && !confirm('Discard unsaved changes?')) {
    state.suppressHash = true
    location.hash = state.editing.hash
    return
  }
  if (isEditorView(next.view)) {
    const previous = event.oldURL ? new URL(event.oldURL).hash || '#/dashboard' : ''
    if (previous && !isEditorView(previous.replace(/^#\/?/, '').split('/')[0])) state.returnTo = previous
  }
  onRoute()
}

function onRoute() {
  if (!state.token) return renderLogin()
  const r = route()
  const id = ++state.renderId
  if (isEditorView(r.view)) return openEditorRoute(r, id)
  state.editing = null
  const main = renderShell(r.view === 'browse' ? 'browse' : r.view)
  if (r.view === 'dashboard') {
    main.innerHTML = dashboardHtml()
  } else if (r.view === 'browse') {
    const lang = LANGUAGES.includes(r.parts[0]) ? r.parts[0] : state.lang
    if (lang !== state.lang) setLang(lang)
    if (r.parts[1]) renderSet(main, lang, r.parts[1], id)
    else renderBrowse(main, lang, r.query.get('q') || '', id)
  } else if (KINDS.includes(r.view)) {
    renderCatalog(main, r.view)
  } else {
    go('#/dashboard')
  }
}

function stale(id) {
  return id !== state.renderId
}

// ---------------------------------------------------------------- api

async function refresh() {
  const [metrics, catalog] = await Promise.all([api('/manage/api/metrics'), api('/manage/api/catalog')])
  state.metrics = metrics
  state.catalog = catalog
}

async function refreshCatalog() {
  state.catalog = await api('/manage/api/catalog')
}

async function api(path, options = {}) {
  const headers = { authorization: `Bearer ${state.token}`, ...(options.headers || {}) }
  if (options.body && !(options.body instanceof Blob) && typeof options.body !== 'string') {
    headers['content-type'] = 'application/json'
    options.body = JSON.stringify(options.body)
  }
  const response = await fetch(path, { ...options, headers })
  if (response.status === 401) {
    write(sessionStorage, 'tcgdex-token', null)
    state.token = ''
    renderLogin('That token was rejected.')
    throw new Error('unauthorized')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = data.details ? `: ${data.details.join(', ')}` : ''
    const error = new Error((data.error || data.title || response.statusText) + detail)
    error.status = response.status
    throw error
  }
  return data
}

async function browse(path) {
  if (browseCache.has(path)) return browseCache.get(path)
  const pending = api(`/manage/api/browse/${path}`)
  browseCache.set(path, pending)
  pending.catch(() => browseCache.delete(path))
  return pending
}

// ---------------------------------------------------------------- shell

function renderLogin(message = '') {
  app.innerHTML = `
    <form class="panel login" id="login">
      <h1>TCGdex manager</h1>
      <p class="muted">Enter the management token from the server environment. The card API stays available without it.</p>
      <label>Management token
        <input id="token" type="password" autocomplete="current-password" required>
      </label>
      <p class="error">${escapeHtml(message)}</p>
      <button class="primary" type="submit">Unlock</button>
    </form>`
  app.querySelector('#token').focus()
  app.querySelector('#login').addEventListener('submit', async (event) => {
    event.preventDefault()
    state.token = app.querySelector('#token').value.trim()
    write(sessionStorage, 'tcgdex-token', state.token)
    try {
      await refresh()
      onRoute()
    } catch (error) {
      if (error.message !== 'unauthorized') renderLogin(error.message)
    }
  })
}

function renderShell(active) {
  const counts = {
    cards: state.catalog.cards.length,
    sets: state.catalog.sets.length,
    series: state.catalog.series.length,
  }
  app.innerHTML = `
    <div class="shell">
      <aside class="nav">
        <h1>TCGdex</h1>
        <p>Self-hosted catalog</p>
        ${navLink('dashboard', 'Dashboard', active)}
        ${navLink('browse', 'Browse sets', active, `#/browse/${state.lang}`)}
        <h4>Local records</h4>
        ${navLink('cards', 'Cards', active, '#/cards', counts.cards)}
        ${navLink('sets', 'Sets', active, '#/sets', counts.sets)}
        ${navLink('series', 'Series', active, '#/series', counts.series)}
        <button type="button" id="lock">Lock</button>
      </aside>
      <main id="main"></main>
    </div>`
  app.querySelector('#lock').addEventListener('click', () => {
    if (isDirty() && !confirm('Discard unsaved changes?')) return
    state.editing = null
    write(sessionStorage, 'tcgdex-token', null)
    state.token = ''
    renderLogin()
  })
  return app.querySelector('#main')
}

function navLink(id, label, active, href = `#/${id}`, count) {
  const badge = count ? `<span class="count">${count}</span>` : ''
  return `<a href="${href}" class="navlink ${active === id ? 'active' : ''}">${label}${badge}</a>`
}

function flash(message, kind = 'ok') {
  let toast = document.querySelector('#toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'toast'
    toast.setAttribute('role', 'status')
    document.body.append(toast)
  }
  toast.textContent = message
  toast.className = `toast ${kind}`
  toast.hidden = false
  clearTimeout(flash.timer)
  flash.timer = setTimeout(() => { toast.hidden = true }, 3500)
}

function errorBox(message) {
  return `<p class="error">${escapeHtml(message)}</p>`
}

// ---------------------------------------------------------------- dashboard

function dashboardHtml() {
  const metrics = state.metrics
  if (!metrics) return state.bootError ? errorBox(state.bootError) : '<p>Loading traffic…</p>'
  const max = Math.max(1, ...metrics.minutes.map((minute) => minute.count))
  const bars = metrics.minutes.map((minute) => {
    const height = Math.max(2, Math.round((minute.count / max) * 100))
    return `<i title="${minute.t} · ${minute.count} requests" style="height:${height}%"></i>`
  }).join('')
  const windowCell = (label, stats) => `
    <article class="stat"><span>${label}</span><b>${stats.count}</b>
      <span class="detail">${stats.errors} errors · avg ${stats.avgMs} ms · p95 ${stats.p95Ms} ms</span></article>`
  const paths = metrics.paths.length
    ? metrics.paths.map((row) => `<tr><td>${escapeHtml(row.path)}</td><td>${row.count}</td></tr>`).join('')
    : '<tr><td colspan="2">No API traffic recorded yet.</td></tr>'
  const recent = metrics.recent.length
    ? metrics.recent.map((row) => `<tr>
        <td>${escapeHtml(row.at.slice(11, 19))}</td>
        <td>${escapeHtml(row.method)}</td>
        <td>${escapeHtml(row.path)}</td>
        <td><span class="pill ${row.status >= 400 ? 'err' : ''}">${row.status}</span></td>
        <td>${row.ms}</td>
        <td>${escapeHtml(row.source)}</td>
      </tr>`).join('')
    : '<tr><td colspan="6">Requests appear here as clients call the API.</td></tr>'
  return `
    <div class="top">
      <div>
        <h2>Traffic</h2>
        <p class="muted">Requests proxied to this host, including ones answered from the custom catalog. Browsing in this manager is not counted.</p>
      </div>
      <span class="pill ${metrics.upstream === 'up' ? 'up' : 'down'}">Upstream ${metrics.upstream}</span>
    </div>
    <section class="stats">
      ${windowCell('Last minute', metrics.windows['1m'])}
      ${windowCell('Last 15 minutes', metrics.windows['15m'])}
      ${windowCell('Last 24 hours', metrics.windows['24h'])}
      <article class="stat"><span>Local catalog</span><b>${state.catalog.cards.length}</b><span class="detail">cards · ${state.catalog.sets.length} sets · ${state.catalog.series.length} series</span></article>
    </section>
    <section class="panel">
      <h3>Requests per minute</h3>
      <div class="bars">${bars}</div>
    </section>
    <section class="panel">
      <h3>Paths in the last 24 hours</h3>
      <table><thead><tr><th>Path</th><th>Count</th></tr></thead><tbody>${paths}</tbody></table>
    </section>
    <section class="panel">
      <h3>Recent requests</h3>
      <table><thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>ms</th><th>Source</th></tr></thead><tbody>${recent}</tbody></table>
    </section>`
}

// ---------------------------------------------------------------- browse

async function renderBrowse(main, lang, q, id) {
  main.innerHTML = `
    <div class="top">
      <div>
        <h2>Browse sets</h2>
        <p class="muted">The catalog as clients see it, with your overrides merged in. Open a set and click any card to override it.</p>
      </div>
      <label class="inline">Language ${langSelect(lang, 'browse-lang')}</label>
    </div>
    <div class="toolbar">
      <input id="set-filter" type="search" placeholder="Filter sets by name or id" autocomplete="off">
      <form id="card-search" class="search">
        <input id="card-query" type="search" placeholder="Find cards by name, e.g. Pikachu" value="${escapeAttr(q)}">
        <button type="submit">Search cards</button>
      </form>
    </div>
    <div id="card-results"></div>
    <div id="sets"><p class="muted">Loading sets…</p></div>`
  main.querySelector('#browse-lang').addEventListener('change', (event) => {
    setLang(event.target.value)
    go(`#/browse/${event.target.value}${q ? `?q=${encodeURIComponent(q)}` : ''}`)
  })
  main.querySelector('#card-search').addEventListener('submit', (event) => {
    event.preventDefault()
    const value = main.querySelector('#card-query').value.trim()
    go(`#/browse/${lang}${value ? `?q=${encodeURIComponent(value)}` : ''}`)
  })
  bindFilter(main.querySelector('#set-filter'), main, '#sets [data-search]')

  if (q) {
    const slot = main.querySelector('#card-results')
    slot.innerHTML = '<p class="muted">Searching…</p>'
    browse(`${lang}/cards?name=${encodeURIComponent(q)}`).then((cards) => {
      if (stale(id)) return
      const shown = cards.slice(0, SEARCH_LIMIT)
      slot.innerHTML = `
        <section class="panel">
          <h3>Cards matching “${escapeHtml(q)}” · ${cards.length}${cards.length > shown.length ? ` (showing ${shown.length})` : ''}</h3>
          ${shown.length ? `<div class="card-grid">${shown.map((card) => cardTile(card, lang)).join('')}</div>` : '<p class="muted">No cards found.</p>'}
        </section>`
    }).catch((error) => {
      if (!stale(id)) slot.innerHTML = errorBox(error.message)
    })
  }

  try {
    const sets = await browse(`${lang}/sets`)
    if (stale(id)) return
    const ordered = [...sets].reverse()
    main.querySelector('#sets').innerHTML = ordered.length
      ? `<div class="set-grid">${ordered.map((set) => setTile(set, lang)).join('')}</div>`
      : '<p class="muted">No sets in this language.</p>'
    const filter = main.querySelector('#set-filter')
    if (filter.value) filter.dispatchEvent(new Event('input'))
  } catch (error) {
    if (!stale(id)) main.querySelector('#sets').innerHTML = errorBox(error.message)
  }
}

function setTile(set, lang) {
  const total = set.cardCount?.total ?? set.cardCount?.official
  return `
    <a class="tile set-tile" href="#/browse/${lang}/${encodeURIComponent(set.id)}" data-search="${escapeAttr(`${set.name} ${set.id}`.toLowerCase())}">
      <span class="logo">${set.logo ? logoImg(set.logo, set.name) : `<span class="placeholder">${escapeHtml(set.name || set.id)}</span>`}</span>
      <span class="tile-name">${escapeHtml(set.name || set.id)}</span>
      <span class="tile-meta">${escapeHtml(set.id)}${total != null ? ` · ${total} cards` : ''} ${localPill(set._local)}</span>
    </a>`
}

async function renderSet(main, lang, setId, id) {
  main.innerHTML = `<p class="crumbs"><a href="#/browse/${lang}">Browse</a> / ${escapeHtml(setId)}</p><p class="muted">Loading set…</p>`
  let set
  try {
    set = await browse(`${lang}/sets/${encodeURIComponent(setId)}`)
  } catch (error) {
    if (!stale(id)) main.innerHTML += errorBox(error.status === 404 ? `There is no set "${setId}" in ${lang}.` : error.message)
    return
  }
  if (stale(id)) return
  const cards = set.cards || []
  const localCount = cards.filter((card) => card._local).length
  const count = set.cardCount || {}
  main.innerHTML = `
    <p class="crumbs"><a href="#/browse/${lang}">Browse</a> / ${escapeHtml(set.name || set.id)}</p>
    <div class="top set-head">
      <div class="set-title">
        ${set.logo ? `<span class="logo">${logoImg(set.logo, set.name)}</span>` : ''}
        <div>
          <h2>${escapeHtml(set.name || set.id)} ${localPill(set._local)}</h2>
          <p class="muted">${[
            set.id,
            set.serie?.name,
            set.releaseDate,
            count.official != null ? `${count.official} official / ${count.total ?? cards.length} total` : `${cards.length} cards`,
            localCount ? `${localCount} local` : '',
          ].filter(Boolean).map(escapeHtml).join(' · ')}</p>
        </div>
      </div>
      <div class="row-actions">
        <a class="button" href="#/edit/sets/${lang}/${encodeURIComponent(set.id)}">${set._local ? 'Edit set details' : 'Override set details'}</a>
        <a class="button primary" href="#/new/cards?lang=${lang}&set=${encodeURIComponent(set.id)}">Add card</a>
      </div>
    </div>
    <div class="toolbar">
      <input id="card-filter" type="search" placeholder="Filter by name or number" autocomplete="off">
      <label class="row"><input type="checkbox" id="local-only"> Local only</label>
      <span class="muted">Click a card to override it. Overridden cards are marked.</span>
    </div>
    ${cards.length ? `<div class="card-grid" id="cards">${cards.map((card) => cardTile(card, lang)).join('')}</div>` : '<p class="muted">This set has no cards yet.</p>'}`
  const filter = main.querySelector('#card-filter')
  const localOnly = main.querySelector('#local-only')
  const apply = () => {
    const needle = filter.value.trim().toLowerCase()
    main.querySelectorAll('#cards [data-search]').forEach((tile) => {
      tile.hidden = (needle && !tile.dataset.search.includes(needle)) || (localOnly.checked && !tile.dataset.local)
    })
  }
  filter.addEventListener('input', apply)
  localOnly.addEventListener('change', apply)
}

function cardTile(card, lang) {
  const img = card.image
    ? `<img loading="lazy" src="${escapeAttr(`${card.image}/low.webp`)}" alt="${escapeAttr(card.name || card.id)}">`
    : ''
  const action = card._local === 'override' ? 'Edit override' : card._local === 'custom' ? 'Edit card' : 'Override'
  return `
    <a class="tile card-tile ${card._local ? 'is-local' : ''}" href="#/edit/cards/${lang}/${encodeURIComponent(card.id)}"
       title="${escapeAttr(`${action}: ${card.name} (${card.id})`)}"
       data-search="${escapeAttr(`${card.name} ${card.localId} ${card.id}`.toLowerCase())}" ${card._local ? 'data-local="1"' : ''}>
      <span class="art">${img}<span class="placeholder">${escapeHtml(card.name || card.id)}</span>${card._local ? `<span class="corner">${localPill(card._local)}</span>` : ''}</span>
      <span class="tile-name">${escapeHtml(card.name || '')}</span>
      <span class="tile-meta">#${escapeHtml(card.localId ?? '')} · ${escapeHtml(card.id)}</span>
      <span class="tile-action">${action}</span>
    </a>`
}

function logoImg(url, alt) {
  const webp = /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(url) ? url : `${url}.webp`
  return `<img loading="lazy" src="${escapeAttr(webp)}" ${webp !== url ? `data-fallback="${escapeAttr(url)}"` : ''} alt="${escapeAttr(alt || '')}">`
}

function localPill(local) {
  if (!local) return ''
  return `<span class="pill ${local}">${local}</span>`
}

// ---------------------------------------------------------------- local catalog

function renderCatalog(main, kind) {
  const rows = state.catalog[kind] || []
  const problems = (state.catalog.problems || []).filter((problem) => problem.file.replace(/\\/g, '/').startsWith(`${kind}/`))
  const extraHead = kind === 'cards' ? 'Set' : kind === 'sets' ? 'Series' : ''
  const body = rows.length
    ? rows.map((row) => {
        const editHref = `#/edit/${kind}/${row.lang}/${encodeURIComponent(row.id)}`
        const extra = kind === 'cards'
          ? (row.setId ? `<a href="#/browse/${row.lang}/${encodeURIComponent(row.setId)}">${escapeHtml(row.setName || row.setId)}</a>` : '')
          : kind === 'sets' ? escapeHtml(row.serieName || '') : ''
        const search = `${row.lang} ${row.id} ${row.name || ''} ${row.setName || ''} ${row.serieName || ''}`.toLowerCase()
        return `<tr data-search="${escapeAttr(search)}" data-lang="${escapeAttr(row.lang)}">
          <td>${escapeHtml(row.lang)}</td>
          <td><a href="${editHref}">${escapeHtml(row.id)}</a></td>
          <td>${escapeHtml(row.name || '')}</td>
          ${extraHead ? `<td>${extra}</td>` : ''}
          <td>${localPill(row.upstream ? 'override' : 'custom')}</td>
          <td class="actions">
            <a class="button" href="${editHref}">Edit</a>
            <button type="button" class="danger" data-delete="${escapeAttr(row.id)}" data-lang="${escapeAttr(row.lang)}" data-upstream="${row.upstream ? '1' : ''}">${row.upstream ? 'Revert' : 'Delete'}</button>
          </td>
        </tr>`
      }).join('')
    : `<tr><td colspan="6">No local ${kind} yet. ${kind === 'cards' ? 'Open a set under Browse sets and click a card to override it, or create a new one.' : 'Create one, or open an official id above to override it.'}</td></tr>`
  const banner = problems.length
    ? `<div class="banner">${problems.map((problem) => `${escapeHtml(problem.file)}: ${escapeHtml(problem.message)}`).join('<br>')}</div>`
    : ''
  const langs = [...new Set(rows.map((row) => row.lang))]
  main.innerHTML = `
    <div class="top">
      <div>
        <h2>Local ${kind}</h2>
        <p class="muted">Files in the data directory. An id that exists upstream replaces that record (override). A new id is added beside the official catalog (custom).</p>
      </div>
      <a class="button primary" href="#/new/${kind}?lang=${state.lang}">New ${singular(kind)}</a>
    </div>
    <form class="panel open-form" id="open-form">
      <label class="inline">Language ${langSelect(state.lang, 'open-lang')}</label>
      <label class="grow">Open by id
        <input id="open-id" placeholder="${kind === 'cards' ? 'swsh3-136' : kind === 'sets' ? 'swsh3' : 'swsh'}" required autocomplete="off">
      </label>
      <button type="submit">Open</button>
      <p class="muted">Opens the local record if there is one, otherwise loads the official record so you can override it.</p>
    </form>
    ${banner}
    <section class="panel">
      ${rows.length ? `<div class="toolbar">
        <input id="row-filter" type="search" placeholder="Filter ${kind}" autocomplete="off">
        ${langs.length > 1 ? `<select id="row-lang"><option value="">All languages</option>${langs.map((lang) => `<option>${escapeHtml(lang)}</option>`).join('')}</select>` : ''}
      </div>` : ''}
      <table>
        <thead><tr><th>Lang</th><th>Id</th><th>Name</th>${extraHead ? `<th>${extraHead}</th>` : ''}<th>Kind</th><th></th></tr></thead>
        <tbody id="rows">${body}</tbody>
      </table>
    </section>`
  main.querySelector('#open-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const lang = main.querySelector('#open-lang').value
    const value = main.querySelector('#open-id').value.trim()
    if (value) go(`#/edit/${kind}/${lang}/${encodeURIComponent(value)}`)
  })
  main.querySelector('#open-lang').addEventListener('change', (event) => setLang(event.target.value))
  const filter = main.querySelector('#row-filter')
  const langFilter = main.querySelector('#row-lang')
  const apply = () => {
    const needle = (filter?.value || '').trim().toLowerCase()
    const lang = langFilter?.value || ''
    main.querySelectorAll('#rows [data-search]').forEach((row) => {
      row.hidden = (needle && !row.dataset.search.includes(needle)) || (lang && row.dataset.lang !== lang)
    })
  }
  filter?.addEventListener('input', apply)
  langFilter?.addEventListener('change', apply)
  main.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const ok = await removeRecord(kind, button.dataset.lang, button.dataset.delete, Boolean(button.dataset.upstream))
      if (ok) renderCatalog(renderShell(kind), kind)
    })
  })
}

async function removeRecord(kind, lang, id, upstream) {
  const message = upstream
    ? `Revert ${lang}/${id} to the official record? Your override file is deleted.`
    : `Delete the custom ${singular(kind)} ${lang}/${id}? This cannot be undone.`
  if (!confirm(message)) return false
  try {
    await api(`/manage/api/${kind}/${encodeURIComponent(lang)}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    browseCache.clear()
    await refreshCatalog()
    flash(upstream ? `${id} now serves the official record` : `Deleted ${id}`)
    return true
  } catch (error) {
    flash(error.message, 'err')
    return false
  }
}

// ---------------------------------------------------------------- editor

async function openEditorRoute(r, id) {
  const kind = r.parts[0]
  if (!KINDS.includes(kind)) return go('#/dashboard')
  if (state.editing && state.editing.hash === r.hash) return renderEditor()
  state.editing = null
  const main = renderShell(kind)
  main.innerHTML = '<p class="muted">Loading…</p>'
  try {
    const draft = r.view === 'edit'
      ? await loadDraft(kind, r.parts[1], r.parts[2])
      : await newDraft(kind, r.query)
    if (stale(id)) return
    draft.hash = r.hash
    draft.original = stable(draft.record)
    state.editing = draft
    renderEditor()
  } catch (error) {
    if (stale(id)) return
    main.innerHTML = `
      <p class="crumbs"><a href="${escapeAttr(state.returnTo || `#/${kind}`)}">← Back</a></p>
      ${errorBox(error.status === 404 ? `No local or official ${singular(kind)} "${r.parts[2] || ''}" in ${r.parts[1] || ''}.` : error.message)}`
  }
}

async function loadDraft(kind, lang, id) {
  if (!LANGUAGES.includes(lang) || !id) throw Object.assign(new Error('unknown language or id'), { status: 400 })
  try {
    const local = await api(`/manage/api/${kind}/${encodeURIComponent(lang)}/${encodeURIComponent(id)}`)
    const meta = local._meta || {}
    delete local._meta
    return { kind, lang, id: local.id, record: local, existing: true, local: meta.upstream ? 'override' : 'custom', meta }
  } catch (error) {
    if (error.status !== 404) throw error
  }
  const result = await api('/manage/api/import', { method: 'POST', body: { kind, lang, id } })
  return { kind, lang, id: result.record.id, record: result.record, existing: false, local: null, upstream: clone(result.record) }
}

async function newDraft(kind, query) {
  const lang = LANGUAGES.includes(query.get('lang')) ? query.get('lang') : state.lang
  const record = blank(kind)
  const setId = query.get('set')
  if (kind === 'cards' && setId) {
    const set = await browse(`${lang}/sets/${encodeURIComponent(setId)}`).catch(() => null)
    record.set = { id: setId, name: set?.name || '' }
    record.localId = nextLocalId(set?.cards || [])
    record.id = `${setId}-${record.localId}`
  }
  return { kind, lang, id: '', record, existing: false, local: null }
}

function nextLocalId(cards) {
  const numbers = cards.map((card) => String(card.localId ?? '')).filter((value) => /^\d+$/.test(value))
  if (!numbers.length) return String(cards.length + 1)
  const width = Math.max(...numbers.map((value) => value.length))
  const next = Math.max(...numbers.map(Number)) + 1
  return String(next).padStart(width, '0')
}

function editorTitle(draft) {
  const noun = singular(draft.kind)
  const label = draft.record.name ? `${draft.record.name}` : ''
  if (draft.local === 'override') return `Edit override · ${label || draft.id}`
  if (draft.local === 'custom') return `Edit custom ${noun} · ${label || draft.id}`
  if (draft.upstream) return `Override ${noun} · ${label || draft.id}`
  return `New ${noun}`
}

function editorSubtitle(draft) {
  if (draft.local === 'override') return `Replaces the official ${singular(draft.kind)} ${draft.lang}/${draft.id}${draft.meta?.savedAt ? ` · saved ${new Date(draft.meta.savedAt).toLocaleString()}` : ''}.`
  if (draft.local === 'custom') return `Added beside the official catalog${draft.meta?.savedAt ? ` · saved ${new Date(draft.meta.savedAt).toLocaleString()}` : ''}.`
  if (draft.upstream) return 'Loaded from the official catalog. Change what you need and save to serve your version instead.'
  return 'A new id is added beside the official catalog. Using an official id overrides that record.'
}

function renderEditor() {
  const draft = state.editing
  const main = app.querySelector('#main') || renderShell(draft.kind)
  const back = state.returnTo || `#/${draft.kind}`
  const canCompare = Boolean(draft.upstream || draft.local === 'override')
  main.innerHTML = `
    <p class="crumbs"><a href="${escapeAttr(back)}" id="back">← Back</a></p>
    <div class="top">
      <div>
        <h2 id="editor-title">${escapeHtml(editorTitle(draft))}</h2>
        <p class="muted">${escapeHtml(editorSubtitle(draft))}</p>
      </div>
      <div class="row-actions">
        ${canCompare ? '<button type="button" id="compare">Compare with official</button>' : ''}
        ${draft.existing ? `<button type="button" class="danger" id="remove">${draft.local === 'override' ? 'Revert to official' : 'Delete'}</button>` : ''}
        <button class="primary" type="button" id="save" title="Ctrl+S">Save</button>
      </div>
    </div>
    <p class="error" id="form-error"></p>
    <div class="editor ${draft.kind}">
      <div class="preview" id="preview"></div>
      <div class="fields" id="fields"></div>
      <div class="json-col">
        <section class="panel diff" id="diff" hidden></section>
        <label>JSON (stored as-is; the form edits common fields and keeps everything else)
          <textarea id="json" spellcheck="false"></textarea>
        </label>
      </div>
    </div>`
  const json = main.querySelector('#json')
  json.value = JSON.stringify(draft.record, null, 2)
  drawFields()
  updatePreview()
  if (draft.showDiff) drawDiff()
  json.addEventListener('change', () => {
    try {
      draft.record = JSON.parse(json.value)
      setError('')
      drawFields()
      updatePreview()
      if (draft.showDiff) drawDiff()
    } catch (error) {
      setError(`JSON: ${error.message}`)
    }
  })
  main.querySelector('#back').addEventListener('click', (event) => {
    event.preventDefault()
    if (isDirty() && !confirm('Discard unsaved changes?')) return
    closeEditor()
  })
  main.querySelector('#save').addEventListener('click', saveDraft)
  main.querySelector('#compare')?.addEventListener('click', toggleDiff)
  main.querySelector('#remove')?.addEventListener('click', async () => {
    const ok = await removeRecord(draft.kind, draft.lang, draft.id, draft.local === 'override')
    if (ok) closeEditor()
  })
}

function closeEditor() {
  const draft = state.editing
  state.editing = null
  go(state.returnTo || `#/${draft?.kind || 'dashboard'}`)
}

function setError(message) {
  const slot = app.querySelector('#form-error')
  if (slot) slot.textContent = message
}

function drawFields() {
  const draft = state.editing
  const record = draft.record
  const fields = app.querySelector('#fields')
  if (draft.kind === 'cards') {
    fields.innerHTML = `
      ${langField(draft.lang)}
      ${textField('id', 'Id', record.id || '')}
      ${textField('localId', 'Local id', record.localId ?? '')}
      ${textField('name', 'Name', record.name || '')}
      <label>Category
        <select data-field="category">
          ${['Pokemon', 'Energy', 'Trainer'].map((value) => `<option ${record.category === value ? 'selected' : ''}>${value}</option>`).join('')}
        </select>
      </label>
      ${textField('rarity', 'Rarity', record.rarity || '')}
      ${textField('set.id', 'Set id', record.set?.id || '')}
      ${textField('set.name', 'Set name', record.set?.name || '')}
      ${textField('hp', 'HP', record.hp ?? '')}
      ${textField('types', 'Types (comma separated)', (record.types || []).join(', '))}
      ${textField('stage', 'Stage', record.stage || '')}
      ${textField('regulationMark', 'Regulation mark', record.regulationMark || '')}
      ${textField('illustrator', 'Illustrator', record.illustrator || '', true)}
      <label class="wide">Description
        <textarea class="short" data-field="description">${escapeHtml(record.description || '')}</textarea>
      </label>
      <div class="checks wide">
        ${['normal', 'reverse', 'holo', 'firstEdition', 'wPromo'].map((name) => `
          <label class="row"><input type="checkbox" data-variant="${name}" ${record.variants?.[name] ? 'checked' : ''}> ${name}</label>`).join('')}
      </div>
      ${textField('image', 'Image base URL (clients append /high.webp or /low.webp)', record.image || '', true)}
      <fieldset class="wide uploads">
        <legend>Upload artwork</legend>
        <label>Card image (high and low)
          <input id="image-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
        </label>
        <label>Optional low-res image
          <input id="image-file-low" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
        </label>
        <label class="wide">Public base URL written into the image field
          <input id="origin" value="${escapeAttr(state.origin)}">
        </label>
        <p class="muted wide">Stored as <code>/assets/&lt;card id&gt;</code>. One file serves both qualities unless you also upload a low-res image. You can also drop an image onto the preview.</p>
      </fieldset>`
  } else if (draft.kind === 'sets') {
    fields.innerHTML = `
      ${langField(draft.lang)}
      ${textField('id', 'Id', record.id || '')}
      ${textField('name', 'Name', record.name || '', true)}
      ${textField('serie.id', 'Series id', record.serie?.id || '')}
      ${textField('serie.name', 'Series name', record.serie?.name || '')}
      ${textField('releaseDate', 'Release date', record.releaseDate || '')}
      ${textField('cardCount.official', 'Official card count', record.cardCount?.official ?? '')}
      ${textField('logo', 'Logo URL', record.logo || '', true)}
      ${textField('symbol', 'Symbol URL', record.symbol || '', true)}`
  } else {
    fields.innerHTML = `
      ${langField(draft.lang)}
      ${textField('id', 'Id', record.id || '')}
      ${textField('name', 'Name', record.name || '', true)}
      ${textField('logo', 'Logo URL', record.logo || '', true)}`
  }
  fields.querySelectorAll('[data-field]').forEach((input) => {
    input.addEventListener('input', applyField)
    input.addEventListener('change', applyField)
  })
  fields.querySelectorAll('[data-variant]').forEach((input) => input.addEventListener('change', applyField))
  fields.querySelector('#image-file')?.addEventListener('change', (event) => uploadImage(event.target.files?.[0], 'high', event.target))
  fields.querySelector('#image-file-low')?.addEventListener('change', (event) => uploadImage(event.target.files?.[0], 'low', event.target))
  fields.querySelector('#origin')?.addEventListener('change', (event) => {
    state.origin = event.target.value.trim().replace(/\/$/, '')
    write(localStorage, 'tcgdex-origin', state.origin)
  })
}

function applyField() {
  const draft = state.editing
  const record = draft.record
  const value = (name) => app.querySelector(`[data-field="${name}"]`)?.value ?? ''
  draft.lang = value('lang') || draft.lang
  record.id = value('id').trim()
  record.name = value('name')
  if (draft.kind === 'cards') {
    record.localId = value('localId').trim()
    record.category = value('category')
    record.set = { ...(record.set || {}), id: value('set.id').trim(), name: value('set.name') }
    setOrDelete(record, 'image', value('image').trim())
    const hp = value('hp').trim()
    setOrDelete(record, 'hp', hp === '' || Number.isNaN(Number(hp)) ? '' : Number(hp))
    const types = value('types').split(',').map((part) => part.trim()).filter(Boolean)
    if (types.length) record.types = types
    else delete record.types
    setOrDelete(record, 'stage', value('stage').trim())
    setOrDelete(record, 'regulationMark', value('regulationMark').trim())
    setOrDelete(record, 'rarity', value('rarity'))
    setOrDelete(record, 'illustrator', value('illustrator'))
    setOrDelete(record, 'description', value('description'))
    record.variants = record.variants || {}
    app.querySelectorAll('[data-variant]').forEach((box) => {
      record.variants[box.dataset.variant] = box.checked
    })
  } else if (draft.kind === 'sets') {
    const serieId = value('serie.id').trim()
    const serieName = value('serie.name')
    if (serieId || serieName) record.serie = { ...(record.serie || {}), id: serieId, name: serieName }
    else delete record.serie
    setOrDelete(record, 'releaseDate', value('releaseDate').trim())
    setOrDelete(record, 'logo', value('logo').trim())
    setOrDelete(record, 'symbol', value('symbol').trim())
    const official = value('cardCount.official').trim()
    record.cardCount = { ...(record.cardCount || {}) }
    if (official === '' || Number.isNaN(Number(official))) delete record.cardCount.official
    else record.cardCount.official = Number(official)
  } else {
    setOrDelete(record, 'logo', value('logo').trim())
  }
  app.querySelector('#json').value = JSON.stringify(record, null, 2)
  app.querySelector('#editor-title').textContent = editorTitle(draft)
  updatePreview()
  if (draft.showDiff) drawDiff()
}

function setOrDelete(record, key, value) {
  if (value === '' || value == null) delete record[key]
  else record[key] = value
}

function updatePreview() {
  const draft = state.editing
  const slot = app.querySelector('#preview')
  if (!slot) return
  const bust = draft.imageVersion ? `?v=${draft.imageVersion}` : ''
  if (draft.kind === 'cards') {
    const src = draft.record.image ? `${draft.record.image}/high.webp${bust}` : ''
    slot.innerHTML = `
      <div class="drop" id="drop" title="Drop an image here to upload it">
        ${src ? `<img src="${escapeAttr(src)}" alt="">` : ''}
        <span class="placeholder">${src ? 'Image not found' : 'No image yet. Drop a file here or use the upload field.'}</span>
      </div>
      ${draft.upstream?.image && draft.upstream.image !== draft.record.image ? `
        <p class="muted">Official artwork</p>
        <div class="drop small"><img src="${escapeAttr(`${draft.upstream.image}/low.webp`)}" alt=""><span class="placeholder">No official image</span></div>` : ''}`
    bindDrop(slot.querySelector('#drop'))
  } else {
    const images = [['Logo', draft.record.logo], ['Symbol', draft.record.symbol]].filter(([, url]) => url)
    slot.innerHTML = images.length
      ? images.map(([label, url]) => `<p class="muted">${label}</p><div class="drop logo-box">${logoImg(url, label)}<span class="placeholder">Not found</span></div>`).join('')
      : '<p class="muted">No logo set.</p>'
  }
}

function bindDrop(zone) {
  if (!zone) return
  zone.addEventListener('dragover', (event) => {
    event.preventDefault()
    zone.classList.add('over')
  })
  zone.addEventListener('dragleave', () => zone.classList.remove('over'))
  zone.addEventListener('drop', (event) => {
    event.preventDefault()
    zone.classList.remove('over')
    const file = event.dataTransfer?.files?.[0]
    if (file) uploadImage(file, 'high')
  })
}

async function uploadImage(file, quality = 'high', input = null) {
  if (!file) return
  const sanitized = file.name.toLowerCase().replace(/[^a-z0-9._-]/g, '')
  const extMatch = sanitized.match(/\.(png|jpe?g|webp|gif)$/)
  if (!extMatch) return setError('Image must be png, jpg, jpeg, webp, or gif.')
  const stem = imageStem()
  if (!stem) return setError('Set the card id before uploading an image.')
  const name = quality === 'low' ? `${stem}/low${extMatch[0]}` : `${stem}${extMatch[0]}`
  try {
    const saved = await api(`/manage/api/images/${name.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    })
    const field = app.querySelector('[data-field="image"]')
    if (field && saved.path) {
      field.value = `${state.origin}${saved.path}`
      state.editing.imageVersion = Date.now()
      applyField()
    }
    if (input) input.value = ''
    setError('')
    flash(quality === 'low' ? 'Low-res image uploaded' : 'Image uploaded. Save the card to use it.')
  } catch (error) {
    setError(error.message)
  }
}

function imageStem() {
  const id = (app.querySelector('[data-field="id"]')?.value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')
  if (id) return id
  const image = app.querySelector('[data-field="image"]')?.value || ''
  const match = image.match(/\/assets\/([^/?#]+?)(?:\.(?:png|jpe?g|webp|gif))?$/i)
  return match ? match[1].toLowerCase() : ''
}

async function toggleDiff() {
  const draft = state.editing
  draft.showDiff = !draft.showDiff
  if (draft.showDiff && !draft.upstream) {
    try {
      const result = await api('/manage/api/import', { method: 'POST', body: { kind: draft.kind, lang: draft.lang, id: draft.id } })
      draft.upstream = result.record
      updatePreview()
    } catch (error) {
      draft.showDiff = false
      setError(error.status === 404 ? 'The official catalog no longer has this record.' : error.message)
      return
    }
  }
  drawDiff()
}

function drawDiff() {
  const draft = state.editing
  const panel = app.querySelector('#diff')
  const button = app.querySelector('#compare')
  if (button) button.classList.toggle('active', Boolean(draft.showDiff))
  if (!panel) return
  panel.hidden = !draft.showDiff
  if (!draft.showDiff || !draft.upstream) return
  const ignore = new Set(['_meta', 'updated'])
  const keys = [...new Set([...Object.keys(draft.upstream), ...Object.keys(draft.record)])].filter((key) => !ignore.has(key))
  const changed = keys.filter((key) => stable(draft.upstream[key]) !== stable(draft.record[key]))
  panel.innerHTML = `
    <h3>Changes from the official ${singular(draft.kind)} · ${changed.length}</h3>
    ${changed.length ? `<table class="diff-table">
      <thead><tr><th>Field</th><th>Official</th><th>Yours</th><th></th></tr></thead>
      <tbody>${changed.map((key) => `<tr>
        <td>${escapeHtml(key)}</td>
        <td><code>${escapeHtml(short(draft.upstream[key]))}</code></td>
        <td><code>${escapeHtml(short(draft.record[key]))}</code></td>
        <td><button type="button" data-reset="${escapeAttr(key)}" title="Use the official value">Reset</button></td>
      </tr>`).join('')}</tbody>
    </table>` : '<p class="muted">Identical to the official record.</p>'}`
  panel.querySelectorAll('[data-reset]').forEach((resetButton) => {
    resetButton.addEventListener('click', () => {
      const key = resetButton.dataset.reset
      if (key in draft.upstream) draft.record[key] = clone(draft.upstream[key])
      else delete draft.record[key]
      app.querySelector('#json').value = JSON.stringify(draft.record, null, 2)
      drawFields()
      updatePreview()
      drawDiff()
    })
  })
}

async function saveDraft() {
  const draft = state.editing
  if (!draft) return
  const button = app.querySelector('#save')
  let record
  try {
    record = JSON.parse(app.querySelector('#json').value)
  } catch (error) {
    return setError(`JSON: ${error.message}`)
  }
  draft.record = record
  const lang = app.querySelector('[data-field="lang"]')?.value || draft.lang
  const id = String(record.id || '').trim()
  if (!id) return setError('Id is required.')
  if (draft.existing && (id.toLowerCase() !== draft.id.toLowerCase() || lang !== draft.lang)
      && !confirm(`This saves a new record at ${lang}/${id}. The original ${draft.lang}/${draft.id} is kept. Continue?`)) {
    return
  }
  if (!draft.existing && state.catalog[draft.kind].some((row) => row.lang === lang && row.id.toLowerCase() === id.toLowerCase())
      && !confirm(`A local ${singular(draft.kind)} ${lang}/${id} already exists. Replace it?`)) {
    return
  }
  if (button) button.disabled = true
  try {
    const saved = await api(`/manage/api/${draft.kind}/${encodeURIComponent(lang)}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: record,
    })
    browseCache.clear()
    await refreshCatalog().catch(() => {})
    const message = saved._meta?.upstream ? `Override saved: ${lang}/${saved.id}` : `Saved custom ${singular(draft.kind)} ${lang}/${saved.id}`
    closeEditor()
    flash(message)
  } catch (error) {
    setError(error.message)
    if (button) button.disabled = false
  }
}

function isDirty() {
  const draft = state.editing
  if (!draft) return false
  const json = app.querySelector('#json')
  if (json) {
    try {
      return stable(JSON.parse(json.value)) !== draft.original
    } catch {
      return true
    }
  }
  return stable(draft.record) !== draft.original
}

// ---------------------------------------------------------------- helpers

function blank(kind) {
  if (kind === 'cards') {
    return {
      id: '',
      localId: '',
      name: '',
      category: 'Pokemon',
      set: { id: '', name: '' },
      variants: { normal: true, reverse: false, holo: false, firstEdition: false, wPromo: false },
      types: ['Colorless'],
      stage: 'Basic',
      legal: { standard: false, expanded: false },
    }
  }
  if (kind === 'sets') return { id: '', name: '', serie: { id: '', name: '' }, cardCount: { official: 1 } }
  return { id: '', name: '' }
}

function singular(kind) {
  if (kind === 'cards') return 'card'
  if (kind === 'sets') return 'set'
  return 'series'
}

function setLang(lang) {
  state.lang = lang
  write(localStorage, 'tcgdex-lang', lang)
}

function bindFilter(input, root, selector) {
  input.addEventListener('input', () => {
    const needle = input.value.trim().toLowerCase()
    root.querySelectorAll(selector).forEach((node) => {
      node.hidden = Boolean(needle) && !node.dataset.search.includes(needle)
    })
  })
}

function langSelect(selected, id) {
  return `<select id="${id}">${LANGUAGES.map((lang) => `<option ${lang === selected ? 'selected' : ''}>${lang}</option>`).join('')}</select>`
}

function langField(selected) {
  return `<label>Language
    <select data-field="lang">${LANGUAGES.map((lang) => `<option ${lang === selected ? 'selected' : ''}>${lang}</option>`).join('')}</select>
  </label>`
}

function textField(name, label, value, wide = false) {
  return `<label class="${wide ? 'wide' : ''}">${label}<input data-field="${name}" value="${escapeAttr(value)}"></label>`
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

function short(value) {
  if (value === undefined) return '(not set)'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function read(storage, key) {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function write(storage, key, value) {
  try {
    if (value == null) storage.removeItem(key)
    else storage.setItem(key, value)
  } catch {
    // Storage can be unavailable in private windows; the UI still works for this tab.
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function escapeAttr(value) {
  return escapeHtml(value)
}
