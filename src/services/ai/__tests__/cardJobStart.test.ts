import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import AppError from '../../../error/AppError'
import { computeSourceHash, startCardJob } from '../cardJob.service'
import { normalizeWebsiteUrl } from '../sourceUrl'

describe('existing-card job start contract', () => {
  it('normalizes bare domains and rejects invalid URLs', () => {
    assert.equal(normalizeWebsiteUrl('example.com'), 'https://example.com/')
    assert.equal(normalizeWebsiteUrl('https://www.example.com/path/'), 'https://www.example.com/path/')
    assert.throws(() => normalizeWebsiteUrl('javascript:alert(1)'), AppError)
    try {
      normalizeWebsiteUrl('not a url')
      assert.fail('expected invalid url')
    } catch (error) {
      assert.equal(error instanceof AppError, true)
      assert.equal((error as AppError).code, 'INVALID_URL')
    }
  })

  it('hashes the same sources identically so retry is idempotent', () => {
    const files = [{ name: 'one.pdf', mimeType: 'application/pdf', buffer: Buffer.from('abc') }]
    const a = computeSourceHash({
      websiteUrl: 'https://example.com/',
      businessText: 'hello',
      files,
      profileId: 'card-1',
      builderMode: 'update',
    })
    const b = computeSourceHash({
      websiteUrl: 'https://example.com/',
      businessText: 'hello',
      files,
      profileId: 'card-1',
      builderMode: 'update',
    })
    const c = computeSourceHash({
      websiteUrl: 'https://example.com/',
      businessText: 'hello',
      files,
      profileId: 'card-2',
      builderMode: 'update',
    })
    assert.equal(a, b)
    assert.notEqual(a, c)
  })

  it('requires profileId for builderMode=update', async () => {
    await assert.rejects(
      () =>
        startCardJob({
          websiteUrl: 'https://example.com',
          builderMode: 'update',
          userId: 'user-1',
          requestId: 'req-test-profile',
        }),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true)
        assert.equal((error as AppError).code, 'PROFILE_REQUIRED')
        return true
      }
    )
  })
})
