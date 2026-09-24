import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Records the deck parser can resolve for the line "2 Unown UFU M".
 * The library keeps that whole line as the card name, then asks the API
 * for name=eq:Unown UFU M. The set code UFU is stored for clients that
 * look the set up directly.
 */
const SEED_FILES = [
  'series/en/unown.json',
  'sets/en/ufu.json',
  'cards/en/ufu-m.json',
  'images/ufu-m.png',
]

export function seedDirectories() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return [
    path.resolve(here, '../seed'),
    path.resolve(here, '../../examples'),
  ]
}

/**
 * Copy preseeded catalog files into the data directory when they are missing.
 * Existing files are left alone so edits in the UI are not overwritten.
 * @returns {string[]} paths that were created
 */
export function seedCatalog(dataDir, directories = seedDirectories()) {
  const root = path.resolve(dataDir)
  const copied = []
  for (const rel of SEED_FILES) {
    const destination = path.resolve(root, rel)
    const allowed = path.resolve(root)
    if (destination !== allowed && !destination.startsWith(`${allowed}${path.sep}`)) continue
    if (fs.existsSync(destination)) continue
    const source = directories.map((dir) => path.resolve(dir, rel)).find((file) => fs.existsSync(file))
    if (!source) continue
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
    copied.push(rel)
  }
  return copied
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')
  const copied = seedCatalog(dataDir)
  if (copied.length) console.log(`seeded ${copied.join(', ')}`)
}
