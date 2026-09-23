// Languages accepted by the TCGdex server (server/src/util.ts).
export const LANGUAGES = [
  'en',
  'fr',
  'es',
  'es-mx',
  'it',
  'pt',
  'pt-br',
  'pt-pt',
  'de',
  'nl',
  'pl',
  'ru',
  'ja',
  'ko',
  'zh-tw',
  'id',
  'th',
  'zh-cn',
]

const LANGUAGE_SET = new Set(LANGUAGES)

export function isLanguage(value) {
  return LANGUAGE_SET.has(value)
}
