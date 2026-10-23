import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { splitDocumentChunks } from '../services/ai/documentRead.service'

describe('splitDocumentChunks', () => {
  it('returns a single chunk for short text', () => {
    assert.deepEqual(splitDocumentChunks('hello world', 100, 10), ['hello world'])
  })

  it('covers the full document with overlapping chunks including the ending', () => {
    const text = 'A'.repeat(1000) + 'CONTACT_END'
    const chunks = splitDocumentChunks(text, 400, 40)
    assert.ok(chunks.length >= 3)
    assert.equal(chunks[0].startsWith('A'), true)
    assert.ok(chunks[chunks.length - 1].includes('CONTACT_END'))
    const joinedApprox = chunks.join('')
    assert.ok(joinedApprox.includes('CONTACT_END'))
  })
})
