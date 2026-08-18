import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertMutationAllowed,
  authoritativeCandidates,
  clearUnprovenImage,
  existingS3Plan,
  extractReviewUrl,
  isAbsoluteDestination,
  isExactCurrentAttachment,
  isExactServiceType,
  isImageAttachment,
  LaravelAttachment,
  parseRepairArgs,
  ReviewAttachment,
  selectPrimaryImage,
} from './repairReviewMedia.helpers'

const pg = (overrides: Partial<ReviewAttachment> = {}): ReviewAttachment => ({
  id: 'attachment',
  legacyId: null,
  attachableType: 'App\\Models\\Service',
  attachableId: '956',
  docName: 'review.jpg',
  url: null,
  publicId: null,
  resourceType: 'image',
  mimeType: 'image/jpeg',
  extension: 'jpg',
  bytes: 100,
  createdAt: new Date('2020-01-01'),
  attachmentType: { legacyId: 6 },
  ...overrides,
})

const laravel = (overrides: Partial<LaravelAttachment> = {}): LaravelAttachment => ({
  id: 70,
  attachmentable_id: 956,
  attachmentable_type: 'App\\Models\\Service',
  attachment_type_id: 6,
  doc_name: 'review.jpg',
  created_at: '2020-01-01',
  ...overrides,
})

test('current PG mapping requires exact numeric legacy service id, not Attachment.legacyId', () => {
  assert.equal(isExactCurrentAttachment(pg({ attachableId: '956', legacyId: 999 }), 956), true)
  assert.equal(isExactCurrentAttachment(pg({ attachableId: '999', legacyId: 956 }), 956), false)
  assert.deepEqual(authoritativeCandidates([pg({ attachableId: '999', legacyId: 956 })], [], 956), [])
})

test('Laravel proof permits reuse by attachment legacy id only for that exact Service', () => {
  const reused = pg({ attachableType: 'App\\Models\\Post', attachableId: 'bad', legacyId: 70 })
  assert.equal(authoritativeCandidates([reused], [laravel()], 956)[0]?.pg?.id, reused.id)
  assert.deepEqual(authoritativeCandidates([reused], [laravel({ attachmentable_id: 1081 })], 956), [])
})

test('Service type normalization is exact and rejects other model names', () => {
  assert.equal(isExactServiceType('App\\\\Models\\\\Service'), true)
  assert.equal(isExactServiceType('App\\Models\\Service'), true)
  assert.equal(isExactServiceType('Service'), false)
  assert.equal(isExactServiceType('App\\Models\\Review'), false)
})

test('primary image is type 7, then 6, then first legacy-ordered image', () => {
  const candidates = authoritativeCandidates(
    [],
    [
      laravel({ id: 3, attachment_type_id: null, doc_name: 'first.png' }),
      laravel({ id: 1, attachment_type_id: 6, doc_name: 'service.jpg' }),
      laravel({ id: 2, attachment_type_id: 7, doc_name: 'featured.jpg' }),
    ],
    956
  )
  assert.equal(selectPrimaryImage(candidates)?.legacyAttachmentId, 2)
  assert.equal(selectPrimaryImage(candidates.filter((row) => row.typeId !== 7))?.legacyAttachmentId, 1)
})

test('non-image attachments cannot become review images', () => {
  assert.equal(isImageAttachment({ docName: 'review.pdf', resourceType: 'raw' }), false)
  assert.equal(isImageAttachment({ docName: 'review.mp4', resourceType: 'video' }), false)
  assert.deepEqual(authoritativeCandidates([], [laravel({ doc_name: 'review.pdf' })], 956), [])
})

test('existing S3 URL without publicId derives key and avoids upload', () => {
  assert.deepEqual(
    existingS3Plan('https://cdn.example.com/vbizme/reviews/r1/photo.jpg', null, (url) =>
      url.startsWith('https://cdn.example.com/')
    ),
    {
      shouldUpload: false,
      url: 'https://cdn.example.com/vbizme/reviews/r1/photo.jpg',
      publicId: 'vbizme/reviews/r1/photo.jpg',
    }
  )
})

test('review URL extraction honors explicit key priority and nested JSON', () => {
  assert.equal(
    extractReviewUrl({
      url: 'https://lower.example/page',
      meta: JSON.stringify({ google_review_url: 'https://g.page/r/real/review' }),
      review_url: 'https://priority.example/review',
    }),
    'https://priority.example/review'
  )
  assert.equal(
    extractReviewUrl({ meta: { deeply: [{ google_review_url: 'https://g.page/r/nested/review' }] } }),
    'https://g.page/r/nested/review'
  )
  assert.equal(
    extractReviewUrl({ reviewUrl: 'https://reviews.example.com/write' }),
    'https://reviews.example.com/write'
  )
})

test('review URL extraction rejects unsafe, media, and generic Google URLs', () => {
  assert.equal(
    extractReviewUrl({
      review_url: 'javascript:alert(1)',
      google_review_url: 'https://google.com/search?q=reviews',
      external_url: 'https://cdn.example.com/review.jpg',
    }),
    null
  )
  assert.equal(extractReviewUrl({ review_url: 'https://google.com/' }), null)
  assert.equal(extractReviewUrl({ review_url: 'https://google.de/search?q=reviews' }), null)
})

test('global dry-run defaults and mutation guard are safe', () => {
  assert.deepEqual(parseRepairArgs([], 'true'), { dryRun: true, slug: '' })
  assert.deepEqual(parseRepairArgs([], 'false'), { dryRun: true, slug: '' })
  assert.deepEqual(parseRepairArgs(['--slug=test', '--all'], 'true'), { dryRun: true, slug: '' })
  assert.deepEqual(parseRepairArgs(['--apply'], 'true'), { dryRun: false, slug: '' })
  assert.throws(() => assertMutationAllowed(true, 'write'), /DRY_RUN/)
})

test('filename-only destinations are forbidden', () => {
  assert.equal(isAbsoluteDestination('photo.jpg'), false)
  assert.equal(isAbsoluteDestination('/storage/photo.jpg'), false)
  assert.equal(isAbsoluteDestination('https://cdn.example.com/photo.jpg'), true)
})

test('unproven review images are cleared instead of preserved as shared fallbacks', () => {
  assert.equal(clearUnprovenImage('https://cdn.example.com/shared-review.jpg'), null)
  assert.equal(clearUnprovenImage('legacy-file.jpg'), null)
  assert.equal(clearUnprovenImage(''), undefined)
  assert.equal(clearUnprovenImage(null), undefined)
})
