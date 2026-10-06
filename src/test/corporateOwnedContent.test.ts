import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  corporateContentFingerprint,
  isClientDraftCollectionId,
  parseCorporateOwnedIdsMap,
} from '../utils/corporateOwnedContent'

describe('parseCorporateOwnedIdsMap', () => {
  it('parses model id lists and ignores junk', () => {
    assert.deepEqual(parseCorporateOwnedIdsMap(undefined), {})
    assert.deepEqual(parseCorporateOwnedIdsMap('{'), {})
    assert.deepEqual(parseCorporateOwnedIdsMap(JSON.stringify({ service: ['a', 'a', ''], post: ['p1'], junk: 'x' })), {
      service: ['a'],
      post: ['p1'],
    })
  })
})

describe('isClientDraftCollectionId', () => {
  it('detects editor temp ids vs server ids', () => {
    assert.equal(isClientDraftCollectionId('svc_123'), true)
    assert.equal(isClientDraftCollectionId('rev_abc'), true)
    assert.equal(isClientDraftCollectionId(''), true)
    assert.equal(isClientDraftCollectionId(null), true)
    assert.equal(isClientDraftCollectionId('clxyz0123456789abcdef'), false)
  })
})

describe('corporateContentFingerprint', () => {
  it('builds a stable fingerprint from shared content fields', () => {
    assert.equal(
      corporateContentFingerprint({
        title: ' Lawn Care ',
        description: 'Weekly',
        imageUrl: 'https://cdn.example.com/a.jpg',
      }),
      'lawn care|weekly|https://cdn.example.com/a.jpg'
    )
    assert.equal(
      corporateContentFingerprint({ title: 'Lawn Care', description: 'Weekly' }),
      corporateContentFingerprint({ title: ' lawn care ', description: 'WEEKLY' })
    )
  })
})
