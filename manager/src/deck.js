import { DeckParser } from 'pokemon-tcg-deck-parser'

const MAX_CHARS = 50_000

/**
 * Parse a deck list with pokemon-tcg-deck-parser and resolve cards through
 * this server, so overridden and custom images are the ones the library returns.
 */
export async function parseDeckList(text, { lang, endpoint }) {
  const source = String(text || '')
  if (!source.trim()) {
    throw Object.assign(new Error('paste a deck list first'), { status: 400 })
  }
  if (source.length > MAX_CHARS) {
    throw Object.assign(new Error('deck list is too long'), { status: 400 })
  }
  const parser = new DeckParser({
    lang,
    endpoint,
    cacheTTL: 0,
    hydrate: 'resume',
  })
  const deck = await parser.parseAndResolve(source)
  return {
    format: deck.format,
    totalCards: deck.totalCards,
    declaredTotal: deck.declaredTotal ?? null,
    warnings: (deck.warnings || []).map((warning) => ({
      line: warning.line ?? null,
      message: warning.message,
    })),
    cards: deck.cards.map(cardView),
  }
}

function cardView(card) {
  const image = typeof card.card?.image === 'string' ? card.card.image : ''
  return {
    quantity: card.quantity,
    name: card.name,
    setCode: card.setCode || '',
    number: card.number || '',
    category: card.category,
    tcgdexId: card.tcgdexId || '',
    localId: card.card?.localId || '',
    image,
    resolved: Boolean(card.card),
    unresolvedReason: card.unresolvedReason || '',
  }
}

export function localApiEndpoint(req) {
  const port = req.socket?.localPort
  if (!port) throw Object.assign(new Error('server address is not available'), { status: 500 })
  return `http://127.0.0.1:${port}/v2`
}
