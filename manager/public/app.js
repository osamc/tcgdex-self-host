const app = document.querySelector('#app')
const LANGUAGES = ['en', 'fr', 'es', 'es-mx', 'it', 'pt', 'pt-br', 'pt-pt', 'de', 'nl', 'pl', 'ru', 'ja', 'ko', 'zh-tw', 'id', 'th', 'zh-cn']

const state = {
  token: sessionStorage.getItem('tcgdex-token') || '',
  tab: 'dashboard',
  metrics: null,
  catalog: { cards: [], sets: [], series: [], problems: [] },
  editing: null,
  error: '',
  origin: localStorage.getItem('tcgdex-origin') || location.origin,
  timer: null,
}

boot()

function boot() {
  state.timer = setInterval(() => {
    if (state.token && state.tab === 'dashboard' && !state.editing) refresh().catch(() => {})
  }, 5000)
  if (!state.token) return renderLogin()
  render()
  refresh().catch((error) => {
    state.error = error.message
    render()
  })
}

async function refresh() {
  const [metrics, catalog] = await Promise.all([
    api('/manage/api/metrics'),
    api('/manage/api/catalog'),
  ])
  state.metrics = metrics
  state.catalog = catalog
  if (!state.editing) render()
}

async function api(path, options = {}) {
  const headers = { authorization: `Bearer ${state.token}`, ...(options.headers || {}) }
  if (options.body && !(options.body instanceof Blob) && typeof options.body !== 'string') {
    headers['content-type'] = 'application/json'
    options.body = JSON.stringify(options.body)
  }
  const response = await fetch(path, { ...options, headers })
  if (response.status === 401) {
    sessionStorage.removeItem('tcgdex-token')
    state.token = ''
    renderLogin('That token was rejected.')
    throw new Error('unauthorized')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = data.details ? `: ${data.details.join(', ')}` : ''
    throw new Error((data.error || data.title || response.statusText) + detail)
  }
  return data
}

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
  app.querySelector('#login').addEventListener('submit', async (event) => {
    event.preventDefault()
    state.token = app.querySelector('#token').value.trim()
    sessionStorage.setItem('tcgdex-token', state.token)
    try {
      await refresh()
      render()
    } catch (error) {
      if (error.message !== 'unauthorized') renderLogin(error.message)
    }
  })
}

function render() {
  if (!state.token) return renderLogin()
  if (state.editing) return renderEditor()
  app.innerHTML = `
    <div class="shell">
      <aside class="nav">
        <h1>TCGdex</h1>
        <p>Self-hosted catalog</p>
        ${navButton('dashboard', 'Dashboard')}
        ${navButton('cards', 'Cards')}
        ${navButton('sets', 'Sets')}
        ${navButton('series', 'Series')}
        <button type="button" id="lock">Lock</button>
      </aside>
      <main id="main"></main>
    </div>`
  app.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tab = button.dataset.tab
      state.error = ''
      render()
    })
  })
  app.querySelector('#lock').addEventListener('click', () => {
    sessionStorage.removeItem('tcgdex-token')
    state.token = ''
    renderLogin()
  })
  const main = app.querySelector('#main')
  if (state.tab === 'dashboard') main.innerHTML = dashboardHtml()
  else main.innerHTML = catalogHtml(state.tab)
  main.querySelector('[data-new]')?.addEventListener('click', () => openEditor(state.tab, blank(state.tab)))
  main.querySelector('[data-import]')?.addEventListener('click', () => openImport(state.tab))
  main.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => loadRecord(state.tab, button.dataset.lang, button.dataset.edit))
  })
  main.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', () => removeRecord(state.tab, button.dataset.lang, button.dataset.delete))
  })
}

function navButton(id, label) {
  return `<button type="button" data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${label}</button>`
}

function dashboardHtml() {
  const metrics = state.metrics
  if (!metrics) return '<p>Loading traffic…</p>'
  const max = Math.max(1, ...metrics.minutes.map((minute) => minute.count))
  const bars = metrics.minutes.map((minute) => {
    const height = Math.max(2, Math.round((minute.count / max) * 100))
    return `<i title="${minute.t} · ${minute.count} requests" style="height:${height}%"></i>`
  }).join('')
  const windowCell = (label, stats) => `
    <article class="stat"><span>${label}</span><b>${stats.count}</b>
      <span>${stats.errors} errors · avg ${stats.avgMs} ms · p95 ${stats.p95Ms} ms</span></article>`
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
        <p class="muted">Requests proxied to this host, including ones answered from the custom catalog.</p>
      </div>
      <span class="pill ${metrics.upstream === 'up' ? 'up' : 'down'}">Upstream ${metrics.upstream}</span>
    </div>
    <section class="stats">
      ${windowCell('Last minute', metrics.windows['1m'])}
      ${windowCell('Last 15 minutes', metrics.windows['15m'])}
      ${windowCell('Last 24 hours', metrics.windows['24h'])}
      <article class="stat"><span>Catalog</span><b>${state.catalog.cards.length}</b><span>${state.catalog.sets.length} sets · ${state.catalog.series.length} series</span></article>
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

function catalogHtml(kind) {
  const rows = state.catalog[kind] || []
  const problems = (state.catalog.problems || []).filter((problem) => problem.file.startsWith(kind))
  const body = rows.length
    ? rows.map((row) => `<tr>
        <td>${escapeHtml(row.lang)}</td>
        <td>${escapeHtml(row.id)}</td>
        <td>${escapeHtml(row.name || '')}</td>
        <td>${escapeHtml(kind === 'cards' ? row.setName : kind === 'sets' ? row.serieName : '')}</td>
        <td><span class="pill ${row.upstream ? 'override' : 'custom'}">${row.upstream ? 'override' : 'custom'}</span></td>
        <td>
          <button type="button" data-edit="${escapeAttr(row.id)}" data-lang="${escapeAttr(row.lang)}">Edit</button>
          <button type="button" class="danger" data-delete="${escapeAttr(row.id)}" data-lang="${escapeAttr(row.lang)}">Delete</button>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="6">No ${kind} yet. Create one, import an upstream record to override it, or copy files into the data directory.</td></tr>`
  const banner = problems.length
    ? `<div class="banner">${problems.map((problem) => `${escapeHtml(problem.file)}: ${escapeHtml(problem.message)}`).join('<br>')}</div>`
    : ''
  return `
    <div class="top">
      <div>
        <h2>${title(kind)}</h2>
        <p class="muted">Same id as an upstream record replaces that record. A new id is added beside the official catalog.</p>
      </div>
      <div class="row-actions">
        <button type="button" data-import>Import upstream</button>
        <button class="primary" type="button" data-new>New</button>
      </div>
    </div>
    ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}
    ${banner}
    <section class="panel">
      <table>
        <thead><tr><th>Lang</th><th>Id</th><th>Name</th><th>${kind === 'cards' ? 'Set' : kind === 'sets' ? 'Series' : ''}</th><th>Kind</th><th></th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </section>`
}

function renderEditor() {
  const draft = state.editing
  app.innerHTML = `
    <main>
      <div class="top">
        <div>
          <h2>${draft.existing ? 'Edit' : 'New'} ${draft.kind.replace(/s$/, '')}</h2>
          <p class="muted">The JSON is what gets stored. The form edits the common fields and keeps the rest of the object.</p>
        </div>
        <div class="row-actions">
          <button type="button" id="cancel">Back</button>
          <button class="primary" type="button" id="save">Save</button>
        </div>
      </div>
      <p class="error" id="form-error">${escapeHtml(state.error)}</p>
      <div class="editor">
        <div class="fields" id="fields"></div>
        <label class="wide">JSON
          <textarea id="json" spellcheck="false"></textarea>
        </label>
      </div>
    </main>`
  const json = app.querySelector('#json')
  json.value = JSON.stringify(draft.record, null, 2)
  drawFields()
  json.addEventListener('change', () => {
    try {
      draft.record = JSON.parse(json.value)
      state.error = ''
      drawFields()
    } catch (error) {
      state.error = error.message
      app.querySelector('#form-error').textContent = error.message
    }
  })
  app.querySelector('#cancel').addEventListener('click', () => {
    state.editing = null
    state.tab = draft.kind
    state.error = ''
    render()
  })
  app.querySelector('#save').addEventListener('click', saveDraft)
}

function drawFields() {
  const draft = state.editing
  const record = draft.record
  const fields = app.querySelector('#fields')
  const lang = draft.lang || 'en'
  if (draft.kind === 'cards') {
    fields.innerHTML = `
      ${langField(lang)}
      ${textField('id', 'Id', record.id || '')}
      ${textField('localId', 'Local id', record.localId ?? '')}
      ${textField('name', 'Name', record.name || '')}
      <label>Category
        <select data-field="category">
          ${['Pokemon', 'Energy', 'Trainer'].map((value) => `<option ${record.category === value ? 'selected' : ''}>${value}</option>`).join('')}
        </select>
      </label>
      ${textField('set.id', 'Set id', record.set?.id || '')}
      ${textField('set.name', 'Set name', record.set?.name || '')}
      ${textField('image', 'Image URL', record.image || '', true)}
      ${textField('hp', 'HP', record.hp ?? '')}
      ${textField('types', 'Types (comma separated)', (record.types || []).join(', '))}
      ${textField('rarity', 'Rarity', record.rarity || '')}
      ${textField('illustrator', 'Illustrator', record.illustrator || '')}
      <label class="wide">Description
        <input data-field="description" value="${escapeAttr(record.description || '')}">
      </label>
      <div class="checks wide">
        ${['normal', 'reverse', 'holo', 'firstEdition', 'wPromo'].map((name) => `
          <label class="row"><input type="checkbox" data-variant="${name}" ${record.variants?.[name] ? 'checked' : ''}> ${name}</label>`).join('')}
      </div>
      <label class="wide">Card image file
        <input id="image-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      </label>
      <label class="wide">Public base URL used when an uploaded image is inserted
        <input id="origin" value="${escapeAttr(state.origin)}">
      </label>`
  } else if (draft.kind === 'sets') {
    fields.innerHTML = `
      ${langField(lang)}
      ${textField('id', 'Id', record.id || '')}
      ${textField('name', 'Name', record.name || '')}
      ${textField('serie.id', 'Series id', record.serie?.id || '')}
      ${textField('serie.name', 'Series name', record.serie?.name || '')}
      ${textField('releaseDate', 'Release date', record.releaseDate || '')}
      ${textField('logo', 'Logo URL', record.logo || '', true)}
      ${textField('symbol', 'Symbol URL', record.symbol || '', true)}
      ${textField('cardCount.official', 'Official card count', record.cardCount?.official ?? '')}`
  } else {
    fields.innerHTML = `
      ${langField(lang)}
      ${textField('id', 'Id', record.id || '')}
      ${textField('name', 'Name', record.name || '')}
      ${textField('logo', 'Logo URL', record.logo || '', true)}`
  }
  fields.querySelectorAll('[data-field]').forEach((input) => {
    input.addEventListener('input', applyField)
    input.addEventListener('change', applyField)
  })
  fields.querySelectorAll('[data-variant]').forEach((input) => input.addEventListener('change', applyField))
  fields.querySelector('#image-file')?.addEventListener('change', uploadImage)
  fields.querySelector('#origin')?.addEventListener('change', (event) => {
    state.origin = event.target.value.replace(/\/$/, '')
    localStorage.setItem('tcgdex-origin', state.origin)
  })
}

function applyField() {
  const draft = state.editing
  const record = draft.record
  const value = (name) => app.querySelector(`[data-field="${name}"]`)?.value ?? ''
  draft.lang = value('lang') || draft.lang
  if (draft.kind === 'cards') {
    record.id = value('id').trim()
    record.localId = value('localId').trim()
    record.name = value('name')
    record.category = value('category')
    record.set = { ...(record.set || {}), id: value('set.id').trim(), name: value('set.name') }
    record.image = value('image').trim()
    record.hp = value('hp') === '' ? undefined : Number(value('hp'))
    record.types = value('types').split(',').map((part) => part.trim()).filter(Boolean)
    record.rarity = value('rarity')
    record.illustrator = value('illustrator')
    record.description = value('description')
    record.variants = record.variants || {}
    app.querySelectorAll('[data-variant]').forEach((box) => {
      record.variants[box.dataset.variant] = box.checked
    })
  } else if (draft.kind === 'sets') {
    record.id = value('id').trim()
    record.name = value('name')
    record.serie = { id: value('serie.id').trim(), name: value('serie.name') }
    record.releaseDate = value('releaseDate')
    record.logo = value('logo').trim()
    record.symbol = value('symbol').trim()
    const official = value('cardCount.official')
    record.cardCount = { ...(record.cardCount || {}) }
    if (official === '') delete record.cardCount.official
    else record.cardCount.official = Number(official)
  } else {
    record.id = value('id').trim()
    record.name = value('name')
    record.logo = value('logo').trim()
  }
  app.querySelector('#json').value = JSON.stringify(record, null, 2)
}

async function uploadImage(event) {
  const file = event.target.files?.[0]
  if (!file) return
  const name = file.name.toLowerCase().replace(/[^a-z0-9._-]/g, '')
  try {
    const saved = await api(`/manage/api/images/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    })
    const input = app.querySelector('[data-field="image"]')
    if (input) {
      input.value = `${state.origin}${saved.path}`
      applyField()
    }
  } catch (error) {
    state.error = error.message
    app.querySelector('#form-error').textContent = error.message
  }
}

async function saveDraft() {
  const draft = state.editing
  try {
    draft.record = JSON.parse(app.querySelector('#json').value)
  } catch (error) {
    state.error = error.message
    app.querySelector('#form-error').textContent = error.message
    return
  }
  const lang = app.querySelector('[data-field="lang"]').value
  const id = draft.record.id
  try {
    await api(`/manage/api/${draft.kind}/${encodeURIComponent(lang)}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: draft.record,
    })
    state.editing = null
    state.tab = draft.kind
    state.error = ''
    await refresh()
    render()
  } catch (error) {
    state.error = error.message
    const slot = app.querySelector('#form-error')
    if (slot) slot.textContent = error.message
  }
}

async function loadRecord(kind, lang, id) {
  try {
    const record = await api(`/manage/api/${kind}/${encodeURIComponent(lang)}/${encodeURIComponent(id)}`)
    openEditor(kind, record, lang, true)
  } catch (error) {
    state.error = error.message
    render()
  }
}

function openEditor(kind, record, lang = 'en', existing = false) {
  state.editing = { kind, record, lang: lang || 'en', existing }
  state.error = ''
  renderEditor()
}

function openImport(kind) {
  const lang = prompt('Language code', 'en')
  if (!lang) return
  const id = prompt(kind === 'cards' ? 'Upstream card id, for example swsh3-136' : 'Upstream id')
  if (!id) return
  api('/manage/api/import', { method: 'POST', body: { kind, lang: lang.trim(), id: id.trim() } })
    .then((result) => openEditor(kind, result.record, result.lang, false))
    .catch((error) => {
      state.error = error.message
      render()
    })
}

async function removeRecord(kind, lang, id) {
  if (!confirm(`Delete ${lang}/${id}?`)) return
  try {
    await api(`/manage/api/${kind}/${encodeURIComponent(lang)}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await refresh()
    render()
  } catch (error) {
    state.error = error.message
    render()
  }
}

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

function title(kind) {
  if (kind === 'cards') return 'Cards'
  if (kind === 'sets') return 'Sets'
  return 'Series'
}

function langField(selected) {
  return `<label>Language
    <select data-field="lang">${LANGUAGES.map((lang) => `<option ${lang === selected ? 'selected' : ''}>${lang}</option>`).join('')}</select>
  </label>`
}

function textField(name, label, value, wide = false) {
  return `<label class="${wide ? 'wide' : ''}">${label}<input data-field="${name}" value="${escapeAttr(value)}"></label>`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function escapeAttr(value) {
  return escapeHtml(value)
}
