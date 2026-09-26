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
  deck: {
    lang: 'en',
    text: 'Pokémon: 24\n2 Unown UF M\n',
    result: null,
    error: '',
    busy: false,
  },
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
        ${navButton('deck', 'Deck test')}
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
  else if (state.tab === 'deck') main.innerHTML = deckHtml()
  else main.innerHTML = catalogHtml(state.tab)
  bindDeck(main)
  main.querySelector('[data-new]')?.addEventListener('click', () => openEditor(state.tab, blank(state.tab)))
  main.querySelector('[data-export]')?.addEventListener('click', () => exportCatalog())
  main.querySelector('[data-import]')?.addEventListener('click', () => openImport(state.tab))
  main.querySelector('[data-import-json]')?.addEventListener('click', () => openJsonImport(state.tab))
  if (state.jsonImport) bindJsonImport(main)
  main.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => loadRecord(state.tab, button.dataset.lang, button.dataset.edit))
  })
  main.querySelectorAll('[data-duplicate]').forEach((button) => {
    button.addEventListener('click', () => duplicateRecord(button.dataset.lang, button.dataset.duplicate))
  })
  main.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', () => removeRecord(state.tab, button.dataset.lang, button.dataset.delete))
  })
}

const DECK_SAMPLE = 'Pokémon: 24\n2 Unown UF M\n'

function deckHtml() {
  const deck = state.deck
  const result = deck.result
  const unique = result ? result.cards.length : 0
  const unresolved = result ? result.cards.filter((card) => !card.resolved).length : 0
  const warnings = result?.warnings?.length
    ? `<div class="banner">${result.warnings.map((warning) => escapeHtml(warning.line ? `Line ${warning.line}: ${warning.message}` : warning.message)).join('<br>')}</div>`
    : ''
  const cards = result
    ? (result.cards.length
      ? `<div class="deck-grid">${result.cards.map(deckCardHtml).join('')}</div>`
      : '<p class="muted">That list did not contain any cards.</p>')
    : ''
  return `
    <div class="top">
      <div>
        <h2>Deck test</h2>
        <p class="muted">Paste a PTCGL or Limitless list. pokemon-tcg-deck-parser resolves it against this server, then each card is shown with the image it returned.</p>
      </div>
    </div>
    <form class="panel" id="deck-form">
      <div class="fields">
        ${langField(deck.lang)}
        <div class="row-actions deck-actions">
          <button type="button" id="deck-sample">Load sample</button>
          <button class="primary" type="submit" ${deck.busy ? 'disabled' : ''}>${deck.busy ? 'Parsing…' : 'Parse deck'}</button>
        </div>
      </div>
      <label class="wide">Deck list
        <textarea id="deck-text" class="deck-input" spellcheck="false"></textarea>
      </label>
      <p class="error">${escapeHtml(deck.error || '')}</p>
    </form>
    ${result ? `
      <p class="muted deck-summary">${escapeHtml(result.format)} · ${result.totalCards} cards · ${unique} unique · ${unresolved} unresolved</p>
      ${warnings}
      ${cards}
    ` : ''}`
}

function deckCardHtml(card) {
  const src = cardImageSrc(card.image)
  const meta = card.resolved
    ? [card.tcgdexId, card.localId && `#${card.localId}`, card.setCode, card.number].filter(Boolean).join(' · ')
    : (card.unresolvedReason || 'Not found')
  const art = src
    ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(card.name)}" data-fallback="${escapeAttr(card.image)}">`
    : '<span class="muted">No image</span>'
  return `
    <article class="deck-card ${card.resolved ? '' : 'missing'}">
      <div class="deck-art">
        ${art}
        <b class="qty">${escapeHtml(card.quantity)}</b>
      </div>
      <h3>${escapeHtml(card.name)}</h3>
      <p>${escapeHtml(meta)}</p>
    </article>`
}

function cardImageSrc(image) {
  if (!image) return ''
  const base = String(image).replace(/\/+$/, '')
  if (/\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(base)) return base
  return `${base}/low.webp`
}

function bindDeck(main) {
  const form = main.querySelector('#deck-form')
  if (!form) return
  const text = main.querySelector('#deck-text')
  text.value = state.deck.text
  const remember = () => {
    state.deck.text = text.value
    state.deck.lang = main.querySelector('#deck-form [data-field="lang"]').value
  }
  text.addEventListener('input', remember)
  main.querySelector('#deck-form [data-field="lang"]').addEventListener('change', remember)
  main.querySelector('#deck-sample').addEventListener('click', () => {
    text.value = DECK_SAMPLE
    remember()
  })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    remember()
    state.deck.busy = true
    state.deck.error = ''
    render()
    try {
      state.deck.result = await api('/manage/api/parse-deck', {
        method: 'POST',
        body: { lang: state.deck.lang, text: state.deck.text },
      })
      state.deck.error = ''
    } catch (error) {
      state.deck.error = error.message
    } finally {
      state.deck.busy = false
      render()
    }
  })
  main.querySelectorAll('.deck-art img').forEach((img) => {
    img.addEventListener('error', () => {
      const fallback = img.dataset.fallback
      if (fallback && img.src !== new URL(fallback, location.href).href) {
        img.src = fallback
        return
      }
      img.replaceWith(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Image failed' }))
    })
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
        <p class="muted">Requests proxied to this host, including ones answered from the custom catalog.</p>
      </div>
      <span class="pill ${metrics.upstream === 'up' ? 'up' : 'down'}">Upstream ${metrics.upstream}</span>
    </div>
    <section class="stats">
      ${windowCell('Last minute', metrics.windows['1m'])}
      ${windowCell('Last 15 minutes', metrics.windows['15m'])}
      ${windowCell('Last 24 hours', metrics.windows['24h'])}
      <article class="stat"><span>Catalog</span><b>${state.catalog.cards.length}</b><span class="detail">${state.catalog.sets.length} sets · ${state.catalog.series.length} series</span></article>
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
        <td class="actions">
          <button type="button" data-edit="${escapeAttr(row.id)}" data-lang="${escapeAttr(row.lang)}">Edit</button>
          ${row.upstream && kind === 'cards' ? `<button type="button" data-duplicate="${escapeAttr(row.id)}" data-lang="${escapeAttr(row.lang)}">Duplicate</button>` : ''}
          <button type="button" class="danger" data-delete="${escapeAttr(row.id)}" data-lang="${escapeAttr(row.lang)}">Delete</button>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="6">No ${kind} yet. Create one, import JSON, import an upstream record, or copy files into the data directory.</td></tr>`
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
        <button type="button" data-export title="Download every saved card, set, and series as JSON">Export</button>
        <button type="button" data-import-json>Import JSON</button>
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
    </section>
    ${state.jsonImport ? jsonImportHtml() : ''}`
}

function renderEditor() {
  const draft = state.editing
  app.innerHTML = `
    <main>
      <div class="top">
        <div>
          <h2>${draft.existing ? 'Edit' : 'New'} ${draft.kind.replace(/s$/, '')}</h2>
          <p class="muted">${draft.copiedFrom
            ? `Copy of ${escapeHtml(draft.copiedFrom)}. The id and local id were changed so saving adds a new card.`
            : 'The JSON is what gets stored. The form edits the common fields and keeps the rest of the object.'}</p>
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
      ${textField('image', 'Image URL (base path — clients append /high.webp or /low.webp)', record.image || '', true)}
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
      <label class="wide">Optional low-res image (served at /low.webp)
        <input id="image-file-low" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      </label>
      <p class="upload-status wide" id="image-upload-status" hidden></p>
      <p class="muted wide">Uploads are stored as a TCGdex-style base URL. Clients request <code>/high.webp</code> and <code>/low.webp</code> on that path. One file is used for both unless you add a low-res image. Save the card after uploading.</p>
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
  fields.querySelector('#image-file')?.addEventListener('change', (event) => uploadImage(event, 'high'))
  fields.querySelector('#image-file-low')?.addEventListener('change', (event) => uploadImage(event, 'low'))
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

async function uploadImage(event, quality = 'high') {
  const file = event.target.files?.[0]
  if (!file) return
  const sanitized = file.name.toLowerCase().replace(/[^a-z0-9._%!-]/g, '')
  const extMatch = sanitized.match(/\.(png|jpe?g|webp|gif)$/)
  if (!extMatch) {
    state.error = 'image must be png, jpg, jpeg, webp, or gif'
    app.querySelector('#form-error').textContent = state.error
    return
  }
  const stem = imageStem() || sanitized.slice(0, -extMatch[0].length)
  if (!stem) {
    state.error = 'set the card id before uploading an image'
    app.querySelector('#form-error').textContent = state.error
    return
  }
  const name = quality === 'low' ? `${stem}/low${extMatch[0]}` : `${stem}${extMatch[0]}`
  const status = app.querySelector('#image-upload-status')
  try {
    const saved = await api(`/manage/api/images/${name.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    })
    const input = app.querySelector('[data-field="image"]')
    if (input && saved.path) {
      input.value = `${state.origin}${saved.path}`
      applyField()
    }
    // Clear so the same file can be chosen again; show status so it does not look like a failed upload.
    event.target.value = ''
    state.error = ''
    const slot = app.querySelector('#form-error')
    if (slot) slot.textContent = ''
    if (status) {
      const where = `${state.origin}${saved.path}`
      status.hidden = false
      status.textContent = quality === 'low'
        ? `Low-res image stored. Clients will request ${where}/low.webp. Save the card to keep the image URL.`
        : `Uploaded ${file.name}. Image URL set to ${where}. Save the card to apply the override.`
    }
  } catch (error) {
    state.error = error.message
    app.querySelector('#form-error').textContent = error.message
    if (status) {
      status.textContent = ''
      status.hidden = true
    }
  }
}

function imageStem() {
  const id = (app.querySelector('[data-field="id"]')?.value || '').trim().toLowerCase().replace(/[^a-z0-9._%!-]/g, '')
  if (id) return id
  const image = app.querySelector('[data-field="image"]')?.value || ''
  const match = image.match(/\/assets\/([^/?#]+?)(?:\.(?:png|jpe?g|webp|gif))?$/i)
  return match ? match[1].toLowerCase() : ''
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

function openEditor(kind, record, lang = 'en', existing = false, copiedFrom = '') {
  state.editing = { kind, record, lang: lang || 'en', existing, copiedFrom }
  state.error = ''
  renderEditor()
}

async function exportCatalog() {
  try {
    const bundle = await api('/manage/api/export')
    const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'tcgdex-custom.json'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  } catch (error) {
    state.error = error.message
    render()
  }
}

async function duplicateRecord(lang, id) {
  try {
    const result = await api('/manage/api/duplicate', {
      method: 'POST',
      body: { kind: 'cards', lang, id },
    })
    openEditor(result.kind, result.record, result.lang, false, result.copiedFrom)
  } catch (error) {
    state.error = error.message
    render()
  }
}

function openJsonImport(kind) {
  const preset = kind === 'series' ? 'series' : kind
  state.jsonImport = state.jsonImport || { lang: 'en', kind: preset, text: '', error: '' }
  state.jsonImport.kind = preset
  state.error = ''
  render()
}

function jsonImportHtml() {
  const draft = state.jsonImport
  return `
    <div class="modal">
      <form class="panel" id="json-import">
        <h3>Import JSON</h3>
        <p class="muted">Paste one card, set, or series, or a bundle with <code>cards</code>, <code>sets</code>, and <code>series</code> arrays. An existing id is replaced.</p>
        <div class="fields">
          ${langField(draft.lang || 'en')}
          <label>Kind when it is not obvious
            <select id="json-kind">
              ${[['auto', 'Auto'], ['cards', 'Card'], ['sets', 'Set'], ['series', 'Series']].map(([value, label]) => `<option value="${value}" ${draft.kind === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>
        </div>
        <label class="wide">JSON
          <textarea id="json-body" spellcheck="false" placeholder='{"id":"uf-m","localId":"M","name":"Unown UF M","category":"Pokemon","set":{"id":"uf","name":"Unown UF"},"variants":{"normal":true},"image":"/assets/uf-m"}'></textarea>
        </label>
        <p class="error" id="json-error">${escapeHtml(draft.error || '')}</p>
        <div class="row-actions">
          <button type="button" id="json-cancel">Cancel</button>
          <button class="primary" type="submit">Import</button>
        </div>
      </form>
    </div>`
}

function bindJsonImport(main) {
  const box = main.querySelector('#json-body')
  if (!box) return
  box.value = state.jsonImport.text || ''
  const lang = main.querySelector('#json-import [data-field="lang"]')
  const kind = main.querySelector('#json-kind')
  const remember = () => {
    state.jsonImport.lang = lang.value
    state.jsonImport.kind = kind.value
    state.jsonImport.text = box.value
  }
  lang.addEventListener('change', remember)
  kind.addEventListener('change', remember)
  box.addEventListener('input', remember)
  main.querySelector('#json-cancel').addEventListener('click', () => {
    state.jsonImport = null
    render()
  })
  main.querySelector('#json-import').addEventListener('submit', async (event) => {
    event.preventDefault()
    remember()
    let document
    try {
      document = JSON.parse(box.value)
    } catch (error) {
      state.jsonImport.error = error.message
      render()
      return
    }
    const selectedKind = kind.value === 'auto' ? undefined : kind.value
    try {
      await api('/manage/api/import', {
        method: 'POST',
        body: { lang: lang.value, kind: selectedKind, document },
      })
      state.jsonImport = null
      state.error = ''
      await refresh()
    } catch (error) {
      state.jsonImport.error = error.message
      render()
    }
  })
}

function openImport(kind) {
  const lang = prompt('Language code', 'en')
  if (!lang) return
  const id = prompt(
    kind === 'cards'
      ? 'Upstream card id (exu-M) or set/localId (exu/M)'
      : 'Upstream id',
  )
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
