import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coerceServiceTypes, fillSectionSchemas, type FillSectionId } from '../services/ai/cardBlueprint.schema'
import { normalizeFillPayload, normalizeRating } from '../services/ai/normalizeFillPayload'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper reads arbitrary section payloads
function parse(scope: FillSectionId, raw: unknown): Record<string, any> {
  const normalized = normalizeFillPayload(scope, raw)
  return fillSectionSchemas[scope].parse(scope === 'services' ? coerceServiceTypes(normalized) : normalized)
}

test('reviews: a summary with no rating in the source (null / 0 / "") still fills', () => {
  for (const rating of [null, 0, '', 'N/A', undefined]) {
    const out = parse('reviews', {
      reviews: [{ author: 'Jordan P.', text: 'The shirts felt great.', rating, imageUrl: null, url: null }],
    })
    assert.deepEqual(out.reviews, [
      { author: 'Jordan P.', text: 'The shirts felt great.', rating: 5, imageUrl: '', url: '' },
    ])
  }
})

test('reviews: ratings written as text are read and kept within 1–5', () => {
  assert.equal(normalizeRating('5/5'), 5)
  assert.equal(normalizeRating('4.5 stars'), 5)
  assert.equal(normalizeRating('★★★★'), 4)
  assert.equal(normalizeRating(10), 5)
  assert.equal(normalizeRating('great'), undefined)
  assert.equal(
    parse('reviews', { reviews: [{ author: 'A', text: 'Good', rating: '4 out of 5' }] }).reviews[0].rating,
    4
  )
})

test('reviews: wrong wrapper, single object, bare array and renamed fields are repaired', () => {
  const expected = { author: 'Jordan P.', text: 'Worth keeping.' }
  const shapes: unknown[] = [
    [{ author: 'Jordan P.', text: 'Worth keeping.' }],
    { author: 'Jordan P.', text: 'Worth keeping.' },
    { reviews: { author: 'Jordan P.', text: 'Worth keeping.' } },
    { testimonials: [{ name: 'Jordan P.', quote: 'Worth keeping.' }] },
    { Reviews: [{ reviewer: 'Jordan P.', summary: 'Worth keeping.' }] },
    { data: { reviews: [{ author: 'Jordan P.', text: ['Worth keeping.'] }] } },
    JSON.stringify({ reviews: [{ author: 'Jordan P.', text: 'Worth keeping.' }] }),
  ]
  for (const shape of shapes) {
    const out = parse('reviews', shape)
    assert.equal(out.reviews.length, 1, JSON.stringify(shape))
    assert.equal(out.reviews[0].author, expected.author)
    assert.equal(out.reviews[0].text, expected.text)
  }
})

test('a correct field is never overwritten by an alias', () => {
  const out = parse('reviews', { reviews: [{ author: 'Real', name: 'Other', text: 'Kept', summary: 'Dropped' }] })
  assert.equal(out.reviews[0].author, 'Real')
  assert.equal(out.reviews[0].text, 'Kept')
})

test('every list section tolerates nulls, numbers and missing lists', () => {
  assert.deepEqual(parse('faqs', { faqs: [{ q: 'Hours?', a: 'Nine to five.', imageUrl: null }] }).faqs[0], {
    question: 'Hours?',
    answer: 'Nine to five.',
    imageUrl: '',
    url: '',
  })
  assert.equal(
    parse('blogs', { posts: [{ title: 'News', summary: 'Short.', category: null }] }).blogs[0].category,
    'News'
  )
  assert.equal(
    parse('services', { services: [{ title: 'SEO audit', description: null, type: 'seo' }] }).services[0].type,
    'SEO'
  )
  assert.equal(parse('portfolio', [{ name: 'Site', body: 'Built it.' }]).portfolio[0].description, 'Built it.')
  assert.equal(
    parse('experience', { experience: [{ employer: 'Acme', role: 'Lead', tillNow: 'yes', fromDate: 2019 }] })
      .experience[0].fromDate,
    '2019'
  )
  assert.equal(
    parse('experience', { experience: [{ company: 'Acme', tillNow: 'present' }] }).experience[0].tillNow,
    true
  )
  assert.equal(
    parse('education', { education: [{ school: 'UConn', degree: 'BS', tillNow: null }] }).education[0].institute,
    'UConn'
  )
  for (const scope of [
    'reviews',
    'faqs',
    'blogs',
    'services',
    'portfolio',
    'skills',
    'education',
    'experience',
  ] as const) {
    assert.deepEqual(parse(scope, {})[scope], [])
    assert.deepEqual(parse(scope, { [scope]: null })[scope], [])
  }
})

test('skills accept comma strings, plain string lists and named objects', () => {
  assert.deepEqual(parse('skills', { skills: [{ type: 'Core', skills: 'SEO, Design' }] }).skills, [
    { type: 'Core', skills: ['SEO', 'Design'] },
  ])
  assert.deepEqual(parse('skills', { skills: ['SEO', 'Design'] }).skills, [
    { type: 'General', skills: ['SEO', 'Design'] },
  ])
  assert.deepEqual(parse('skills', { skills: [{ category: 'Core', items: [{ name: 'SEO' }] }] }).skills, [
    { type: 'Core', skills: ['SEO'] },
  ])
})

test('personal: unwrapped fields, nulls and nested social handles are repaired', () => {
  const out = parse('personal', {
    name: 'Ann Lee',
    email: null,
    phone: 8605550100,
    socialHandles: { linkedin: null, instagram: '@ann' },
  })
  assert.equal(out.personal.fullName, 'Ann Lee')
  assert.equal(out.personal.email, '')
  assert.equal(out.personal.phone, '8605550100')
  assert.deepEqual(out.socialHandles, { instagram: '@ann' })
  assert.equal(
    parse('personal', { personal: { fullName: 'Ann', about: ['One.', 'Two.'] } }).personal.about,
    'One.\n\nTwo.'
  )
})

test('well-formed output passes through unchanged', () => {
  const good = { reviews: [{ author: 'A', text: '<p>Good</p>', rating: 4, imageUrl: '', url: 'https://x.test' }] }
  assert.deepEqual(parse('reviews', good), good)
})
