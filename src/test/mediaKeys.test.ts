import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { splitMediaKey } from '../utils/duplicateCardMedia'
import { extractMediaKeys, replaceMediaKeys } from '../utils/mediaKeys'

const BASE = 'https://aws-s3-vbizme-vcard.s3.us-east-2.amazonaws.com'

describe('media key extraction', () => {
  it('finds keys in plain URLs, rich-text HTML and JSON snapshots', () => {
    const html = `<p>Hi</p><img src="${BASE}/vbizme/1793285518140-ML1.jpg"><img src='${BASE}/vbizme/1793285535889-ML2.jpg?v=2'>`
    const snapshot = {
      kind: 'collection',
      items: [
        { title: 'Medicare', imageUrl: `${BASE}/vbizme/1793269336295-ML4.jpg` },
        { title: 'Video', imageUrl: `${BASE}/vbizme/1793269336300-intro%20clip.mp4` },
      ],
      description: html,
    }
    assert.deepEqual([...extractMediaKeys(snapshot, BASE)].sort(), [
      'vbizme/1793269336295-ML4.jpg',
      'vbizme/1793269336300-intro clip.mp4',
      'vbizme/1793285518140-ML1.jpg',
      'vbizme/1793285535889-ML2.jpg',
    ])
  })

  it('ignores foreign hosts and YouTube links', () => {
    const keys = extractMediaKeys(
      'https://youtube.com/watch?v=x https://example.com/vbizme/1-a.jpg https://app.vbizme.com/storage/a.png',
      BASE
    )
    assert.equal(keys.size, 0)
  })

  it('handles trailing slash on the base URL', () => {
    assert.deepEqual([...extractMediaKeys(`${BASE}/vbizme/1-a.png`, `${BASE}/`)], ['vbizme/1-a.png'])
  })
})

describe('media key rewrite (duplicate copy)', () => {
  it('rewrites whole keys only, everywhere they appear', () => {
    const map = new Map([['vbizme/1-a.jpg', 'vbizme/2-a.jpg']])
    const input = `{"u":"${BASE}/vbizme/1-a.jpg","v":"${BASE}/vbizme/1-a.jpg.webp","h":"<img src=\\"${BASE}/vbizme/1-a.jpg\\">"}`
    const out = replaceMediaKeys(input, map, BASE)
    assert.equal(out.split('vbizme/2-a.jpg"').length - 1, 1)
    assert.ok(out.includes(`${BASE}/vbizme/1-a.jpg.webp`), 'longer key must not be rewritten')
    assert.ok(out.includes(`src=\\"${BASE}/vbizme/2-a.jpg\\"`), 'HTML inside JSON is rewritten')
    assert.ok(!out.includes(`${BASE}/vbizme/1-a.jpg"`))
  })

  it('leaves text untouched when nothing matches', () => {
    const text = `${BASE}/vbizme/9-z.jpg`
    assert.equal(replaceMediaKeys(text, new Map([['vbizme/1-a.jpg', 'vbizme/2-a.jpg']]), BASE), text)
  })

  it('splits keys into folder + original filename for the copy', () => {
    assert.deepEqual(splitMediaKey('vbizme/1793285518140-ML1.jpg'), { folder: 'vbizme', filename: 'ML1.jpg' })
    assert.deepEqual(splitMediaKey('legacy.png'), { folder: '', filename: 'legacy.png' })
  })
})

describe('API never deletes card media', () => {
  it('has no DeleteObject / destroy path in request code', () => {
    for (const file of ['src/utils/s3.ts', 'src/router/media.route.ts', 'src/services/profile.service.ts']) {
      const source = readFileSync(file, 'utf8')
      assert.ok(!/DeleteObject(s)?Command/.test(source), `${file} must not import DeleteObjectCommand`)
      assert.ok(!/s3Utils\.destroy|destroyS3IfUnreferenced/.test(source), `${file} must not delete S3 media`)
    }
  })
})
