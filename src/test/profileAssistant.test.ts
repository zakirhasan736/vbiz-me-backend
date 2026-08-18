import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  assertPublicAssistantGate,
  boundKnowledgeContext,
  buildTabFillSystemPrompt,
  parseAssistantEnabled,
  parseSupportedTabScope,
  publicLiveTokenShape,
} from '../services/assistantPolicy'
import { needsServerOcr, ocrWithFallback } from '../services/documentOcr.service'

test('assistant enabled parsing supports legacy checkbox values', () => {
  for (const value of [true, 1, '1', 'TRUE', 'yes', 'on', 'enabled']) {
    assert.equal(parseAssistantEnabled(value), true)
  }
  for (const value of [false, 0, '0', 'false', '', null, undefined]) {
    assert.equal(parseAssistantEnabled(value), false)
  }
})

test('public assistant token gate requires public readability and either enabled source', () => {
  assert.doesNotThrow(() => assertPublicAssistantGate(true, true, false))
  assert.doesNotThrow(() => assertPublicAssistantGate(true, false, '1'))
  assert.throws(() => assertPublicAssistantGate(true, false, '0'), { statusCode: 404 })
  assert.throws(() => assertPublicAssistantGate(false, true, true), { statusCode: 404 })
})

test('knowledge context is deterministic, bounded, and isolated by profile', () => {
  const rows = [
    { id: 'b', profileId: 'profile-a', label: 'Zulu', tabScope: null, extractedText: 'Z'.repeat(50) },
    { id: 'a', profileId: 'profile-a', label: 'Alpha', tabScope: 'services', extractedText: 'Alpha facts' },
    { id: 'x', profileId: 'profile-b', label: 'Secret', tabScope: null, extractedText: 'OTHER CARD SECRET' },
  ]
  const first = boundKnowledgeContext('profile-a', rows, 70)
  const second = boundKnowledgeContext('profile-a', [...rows].reverse(), 70)
  assert.equal(first, second)
  assert.ok(first.length <= 70)
  assert.equal(first.includes('OTHER CARD SECRET'), false)
})

test('tab fill accepts exact supported scopes and rejects aliases', () => {
  assert.equal(parseSupportedTabScope('services'), 'services')
  assert.throws(() => parseSupportedTabScope('service'), { statusCode: 400 })
  assert.throws(() => parseSupportedTabScope('unknown-tab'), { statusCode: 400 })
})

test('tab fill prompt constrains output to one section', () => {
  const prompt = buildTabFillSystemPrompt('services')
  assert.match(prompt, /exactly one public vCard section: "services"/)
  assert.match(prompt, /"services":/)
  assert.doesNotMatch(prompt, /"reviews":/)
  assert.match(prompt, /Do not return keys.*other section/)
})

test('OCR-needed files cannot be treated as native extraction success', () => {
  assert.equal(needsServerOcr({ extractionMethod: 'ocr_needed' }), true)
  assert.equal(needsServerOcr({ extractionMethod: 'ocr' }), true)
  assert.equal(needsServerOcr({ extractionMethod: 'native' }), false)
})

test('OCR uses primary model then Terra fallback', async () => {
  const models: string[] = []
  const text = await ocrWithFallback(
    async (model) => {
      models.push(model)
      if (model === 'gpt-4o') throw new Error('primary failed')
      return `ready from ${model}`
    },
    'gpt-4o',
    'gpt-4.1'
  )
  assert.deepEqual(models, ['gpt-4o', 'gpt-4.1'])
  assert.equal(text, 'ready from gpt-4.1')
})

test('Gemini public response includes only short-lived token metadata', () => {
  const response = publicLiveTokenShape({
    token: { name: 'ephemeral-token' },
    model: 'gemini-3.1-flash-live-preview',
    expiresAt: '2026-08-18T18:30:00.000Z',
    newSessionExpiresAt: '2026-08-18T18:01:00.000Z',
  })
  assert.equal(response.token, 'ephemeral-token')
  assert.equal('apiKey' in response, false)
  assert.equal('GEMINI_API_KEY' in response, false)
})

test('existing card creation and fill-section route contracts remain separate', async () => {
  const routeSource = await readFile(new URL('../router/cardAgent.route.ts', import.meta.url), 'utf8')
  assert.match(routeSource, /router\.post\(\s*['"]\/fill-section['"]/)
  assert.match(routeSource, /router\.post\(\s*['"]\/jobs['"]/)
  assert.match(routeSource, /cardJobService\.startCardJob/)
  assert.doesNotMatch(routeSource, /profileAssistant|assistantTabFill|geminiLive/)
})
