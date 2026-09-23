import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { publicAssetPath, publicAssetUrl, resolveImageFile, safeImageRelPath } from '../src/images.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('upload names accept a flat file or a quality variant', () => {
  assert.equal(safeImageRelPath('Demo-001.PNG'), 'demo-001.png')
  assert.equal(safeImageRelPath('demo-001/low.webp'), 'demo-001/low.webp')
  assert.equal(safeImageRelPath('../secret.png'), null)
  assert.equal(safeImageRelPath('demo-001/medium.webp'), null)
})

test('public asset paths drop the file extension so clients can append /high.webp', () => {
  assert.equal(publicAssetPath('demo-001.png'), '/assets/demo-001')
  assert.equal(publicAssetPath('demo-001/low.webp'), '/assets/demo-001')
  assert.equal(publicAssetUrl('https://cards.example/assets/demo-001.png'), 'https://cards.example/assets/demo-001')
  assert.equal(publicAssetUrl('/assets/demo-001.webp'), '/assets/demo-001')
  assert.equal(publicAssetUrl('https://assets.tcgdex.net/en/swsh/swsh3/136'), 'https://assets.tcgdex.net/en/swsh/swsh3/136')
  assert.equal(publicAssetUrl('https://cdn.example/cards/demo-001.png'), 'https://cdn.example/cards/demo-001.png')
})

test('quality suffixes resolve to the uploaded file, with an optional low-res override', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgdex-images-'))
  try {
    const images = path.join(dataDir, 'images')
    fs.mkdirSync(images, { recursive: true })
    fs.writeFileSync(path.join(images, 'demo-001.png'), PNG)

    const high = resolveImageFile(dataDir, '/assets/demo-001/high.webp')
    const low = resolveImageFile(dataDir, '/assets/demo-001/low.webp')
    const legacy = resolveImageFile(dataDir, '/assets/demo-001.png/high.webp')
    const base = resolveImageFile(dataDir, '/assets/demo-001')
    assert.equal(path.basename(high), 'demo-001.png')
    assert.equal(low, high)
    assert.equal(legacy, high)
    assert.equal(base, high)

    fs.mkdirSync(path.join(images, 'demo-001'))
    fs.writeFileSync(path.join(images, 'demo-001', 'low.webp'), PNG)
    const preview = resolveImageFile(dataDir, '/assets/demo-001/low.webp')
    assert.equal(path.basename(preview), 'low.webp')
    assert.equal(path.basename(resolveImageFile(dataDir, '/assets/demo-001/high.png')), 'demo-001.png')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
