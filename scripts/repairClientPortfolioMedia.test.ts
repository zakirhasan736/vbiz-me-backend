import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertMutationAllowed,
  existingS3Plan,
  isValidDestination,
  LegacyMediaRow,
  matchEntityAttachments,
  parseRepairArgs,
  pickClientPrimary,
  pickPortfolioRoles,
} from './repairClientPortfolioMedia.helpers'

const legacy = (overrides: Partial<LegacyMediaRow>): LegacyMediaRow => ({
  id: 1,
  attachmentable_id: 900,
  attachmentable_type: 'App\\Models\\Service',
  attachment_type_id: null,
  doc_name: 'image.jpg',
  created_at: '2020-01-01',
  ...overrides,
})

test('numeric mapping uses entity legacy id, never attachment legacy id', () => {
  const matches = matchEntityAttachments({
    kind: 'Service',
    entityId: 'client-cuid',
    legacyEntityId: 900,
    laravelRows: [legacy({ id: 77, attachmentable_id: 900 })],
    attachments: [
      {
        id: 'wrong',
        legacyId: 321,
        attachableType: 'App\\Models\\Service',
        attachableId: '321',
      },
      {
        id: 'right',
        legacyId: null,
        attachableType: 'App\\Models\\Service',
        attachableId: '900',
      },
    ],
  })
  assert.deepEqual(
    matches.map((row) => row.id),
    ['right']
  )
})

test('Laravel attachment legacyId recovers wrong current type and id', () => {
  const matches = matchEntityAttachments({
    kind: 'Service',
    entityId: 'client-cuid',
    legacyEntityId: 900,
    laravelRows: [legacy({ id: 77, attachmentable_id: 900 })],
    attachments: [
      {
        id: 'recover-me',
        legacyId: 77,
        attachableType: 'App\\Models\\Portfolio',
        attachableId: 'completely-wrong',
      },
    ],
  })
  assert.equal(matches[0]?.id, 'recover-me')
})

test('S3 URL without publicId derives key and never uploads', () => {
  const plan = existingS3Plan('https://cdn.example.com/vbizme/clients/abc/photo.jpg', null, (url) =>
    url.startsWith('https://cdn.example.com/')
  )
  assert.deepEqual(plan, {
    shouldUpload: false,
    url: 'https://cdn.example.com/vbizme/clients/abc/photo.jpg',
    publicId: 'vbizme/clients/abc/photo.jpg',
  })
})

test('Client primary selection prefers type 7 over earlier type 6', () => {
  const selected = pickClientPrimary([
    legacy({ id: 1, attachment_type_id: 6, doc_name: 'service.jpg' }),
    legacy({ id: 2, attachment_type_id: 7, doc_name: 'featured.jpg' }),
  ])
  assert.equal(selected?.id, 2)
})

test('Portfolio fallback skips non-images and keeps legacy ordering', () => {
  const roles = pickPortfolioRoles([
    legacy({ id: 1, attachmentable_type: 'App\\Models\\Portfolio', doc_name: 'intro.mp4' }),
    legacy({ id: 4, attachmentable_type: 'App\\Models\\Portfolio', doc_name: 'later.jpg' }),
    legacy({ id: 2, attachmentable_type: 'App\\Models\\Portfolio', doc_name: 'manual.pdf' }),
    legacy({ id: 3, attachmentable_type: 'App\\Models\\Portfolio', doc_name: 'first.png' }),
  ])
  assert.equal(roles.featured?.id, 3)
  assert.deepEqual(
    roles.ordered.map((row) => row.id),
    [1, 2, 3, 4]
  )
  assert.deepEqual(
    roles.others.map((row) => row.id),
    [1, 2, 4]
  )
})

test('filename-only values are not valid destinations', () => {
  assert.equal(isValidDestination('photo.jpg'), false)
  assert.equal(isValidDestination('/uploads/photo.jpg'), false)
  assert.equal(isValidDestination('https://cdn.example.com/photo.jpg'), true)
})

test('scope defaults global and slug is only explicit', () => {
  assert.deepEqual(parseRepairArgs([], 'true'), { dryRun: true, slug: '' })
  assert.deepEqual(parseRepairArgs(['--slug=one-card'], 'true'), { dryRun: true, slug: 'one-card' })
  assert.deepEqual(parseRepairArgs(['--slug=one-card', '--all'], 'true'), { dryRun: true, slug: '' })
})

test('dry-run mutation guard blocks writes', () => {
  assert.throws(() => assertMutationAllowed(true, 'test update'), /DRY_RUN mutation blocked/)
  assert.doesNotThrow(() => assertMutationAllowed(false, 'test update'))
})
