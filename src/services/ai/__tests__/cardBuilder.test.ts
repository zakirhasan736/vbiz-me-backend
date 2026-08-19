import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { slugify } from '../../../middlewares/ownership'
import {
  cardActivationIssueMessage,
  cardCreationIssueMessage,
  collectCardActivationIssues,
  collectCardCreationIssues,
  findCreateContactConflict,
  minCardAgeCutoffDate,
  normalizeCardEmail,
  normalizeCardPhone,
} from '../../../utils/cardActivation'
import { resolveInitialCardLifecycle } from '../../../utils/cardStatus'
import {
  SEO_FIXED_KEYWORDS,
  normalizeSeoKeywords,
  normalizeSeoMetadata,
  normalizeSeoSettings,
} from '../../seoMetadata.service'
import { masterBusinessProfileSchema, type MasterBusinessProfile } from '../businessProfile.schema'
import { buildCompletenessReport } from '../completeness.service'
import { detectSourceConflicts } from '../conflictDetection'
import { profileToBlueprintFacts } from '../contentGenerator.service'
import { classifyWebsitePage, pdfTextLooksScanned, stripWebsiteBoilerplate } from '../extractDocumentText'
import {
  assessComplexity,
  getModelForTier,
  isUnavailableModelError,
  modelCandidatesForTier,
  routeAiTier,
  selectModelForTask,
} from '../modelRouter.service'
import { decideRecommendedTabs } from '../tabDecision.service'
import { filterRealReviews, looksLikeDateOnly, looksLikeEmail, sanitizeBlueprint } from '../validation.service'

function profile(partial: Partial<MasterBusinessProfile>): MasterBusinessProfile {
  return masterBusinessProfileSchema.parse({
    businessName: 'Acme Plumbing',
    industry: 'plumbing',
    phone: '555-0100',
    email: 'hello@acme.test',
    website: 'https://acme.test',
    services: [{ title: 'Emergency Plumbing', description: '24 hour service' }],
    confidence: { overall: 0.93, businessIdentity: 0.9, services: 0.9, contactInformation: 0.9, credentials: 0.5 },
    ...partial,
  })
}

describe('vBiz Me auto card builder', () => {
  it('normalizes card SEO to five required terms plus owner phrases', () => {
    const seo = normalizeSeoMetadata({
      metaTitle: 't'.repeat(100),
      metaDescription: 'd'.repeat(220),
      keywords: ['plumber', 'VBIZME', 'local plumber', 'emergency service', 'service area', 'sixth', 'seventh'],
    })

    assert.equal(seo.metaTitle.length, 70)
    assert.equal(seo.metaDescription.length, 160)
    assert.deepEqual(seo.keywords.slice(0, SEO_FIXED_KEYWORDS.length), [...SEO_FIXED_KEYWORDS])
    assert.equal(seo.keywords.length, SEO_FIXED_KEYWORDS.length + 6)
  })

  it('adds fixed SEO keywords when a partial settings update contains SEO metadata', () => {
    const settings = normalizeSeoSettings({ seo_meta_title: 'Acme Plumbing' })
    assert.deepEqual(JSON.parse(settings.seo_meta_keywords_json), [...SEO_FIXED_KEYWORDS])
    assert.deepEqual(normalizeSeoKeywords(JSON.parse(settings.seo_meta_keywords_json)), [...SEO_FIXED_KEYWORDS])
  })

  it('1. simple local business prefers Luna', () => {
    const complexity = assessComplexity({ sourceCount: 1, pageCount: 3, textLength: 4000 })
    const route = routeAiTier({ confidence: 0.94, complexity: complexity.complexity })
    assert.equal(complexity.complexity, 'normal')
    assert.equal(route.tier, 'luna')
  })

  it('2. website + typed instructions still uses Luna when clear', () => {
    const route = routeAiTier({ confidence: 0.91, complexity: 'normal' })
    assert.equal(route.tier, 'luna')
  })

  it('3. website + PDF native text does not force Terra', () => {
    const complexity = assessComplexity({ sourceCount: 2, pageCount: 4, ocrUsed: false })
    assert.notEqual(complexity.complexity, 'very_complex')
    const route = routeAiTier({ confidence: 0.9, complexity: complexity.complexity })
    assert.equal(route.tier, 'luna')
  })

  it('4. scanned PDF / poor OCR escalates to Terra', () => {
    assert.equal(pdfTextLooksScanned('', 120000), true)
    assert.equal(pdfTextLooksScanned('A'.repeat(4000), 20000), false)
    const route = routeAiTier({ confidence: 0.88, complexity: 'complex', ocrQualityPoor: true })
    assert.equal(route.tier, 'terra')
  })

  it('5. many documents increase complexity', () => {
    const complexity = assessComplexity({ sourceCount: 5, pageCount: 12, textLength: 50000 })
    assert.equal(complexity.complexity, 'complex')
  })

  it('6. conflicting years in business are reported, not guessed', () => {
    const conflicts = detectSourceConflicts({
      websiteText: '10 years of experience serving the city',
      documentTexts: [{ label: 'license.pdf', text: '15 years in business' }],
    })
    assert.equal(conflicts[0]?.field, 'yearsInBusiness')
    assert.equal(conflicts[0]?.values.length, 2)
  })

  it('7. missing contact lowers completeness and recommends adding it', () => {
    const report = buildCompletenessReport({
      profile: profile({ phone: null, email: null, website: null }),
    })
    assert.ok(report.completionScore < 90)
    assert.ok(report.recommended.some((r) => /phone/i.test(r) || /email/i.test(r)))
  })

  it('8. attorney profile gets specialized supported tabs only', () => {
    const tabs = decideRecommendedTabs(
      profile({
        businessName: 'Smith Law',
        industry: 'attorney',
        businessType: 'law firm',
        education: [{ institute: 'Yale', degree: 'JD', fromDate: '', toDate: '', tillNow: false }],
        certifications: ['State Bar'],
      })
    )
    const names = tabs.map((t) => t.name)
    assert.ok(names.includes('Education'))
    assert.ok(names.includes('Certifications/Licenses'))
    assert.ok(names.includes('FAQ'))
    assert.ok(!names.includes('Breakfast'))
    assert.ok(
      tabs.every((t) =>
        [
          'home',
          'about',
          'education',
          'work',
          'skills',
          'services',
          'reviews',
          'blog',
          'profile',
          'gallery',
          'certificates',
          'resume',
          'faq',
          'public-cards',
          'my-info',
        ].includes(t.navId)
      )
    )
  })

  it('9. real testimonials become public reviews', () => {
    const facts = profileToBlueprintFacts(
      profile({
        verifiedReviews: [{ author: 'Pat', text: 'Great work', rating: 5, source: 'website' }],
        suggestedTestimonialTemplates: [
          {
            author: 'Sample Client',
            text: 'DRAFT / SAMPLE loved it',
            rating: 5,
            isSample: true,
            label: 'DRAFT / SAMPLE',
          },
        ],
      }),
      decideRecommendedTabs(profile({}))
    )
    assert.equal(facts.reviews?.length, 1)
    assert.equal(facts.reviews?.[0]?.author, 'Pat')
  })

  it('10. no reviews means empty reviews, samples stay out', () => {
    const real = filterRealReviews([
      { author: 'Sample Client', text: 'DRAFT / SAMPLE', isSample: true, label: 'DRAFT / SAMPLE' },
    ])
    assert.equal(real.length, 0)
    const facts = profileToBlueprintFacts(profile({ verifiedReviews: [], existingTestimonials: [] }), [])
    assert.equal(facts.reviews?.length, 0)
  })

  it('11. partial regeneration keeps other sections (fact mapper is section-scoped)', () => {
    const facts = profileToBlueprintFacts(
      profile({
        services: [
          { title: 'Repair', description: 'A', url: '' },
          { title: 'Install', description: 'B', url: '' },
        ],
      }),
      []
    )
    assert.equal(facts.services?.[1]?.title, 'Install')
  })

  it('12. failed website scrape is a warning, not a hard stop', () => {
    const p = profile({ warnings: ['The website could not be read. Other sources will still be used.'] })
    assert.ok(p.warnings?.[0])
    const report = buildCompletenessReport({ profile: p })
    assert.ok(report.completionScore > 0)
  })

  it('13. unsupported tabs are dropped during validation', () => {
    const { blueprint, issues } = sanitizeBlueprint({
      businessSummary: 'Plumber',
      suggestedSlug: 'acme',
      personal: { fullName: 'Acme', email: 'hello@acme.test', about: 'We fix pipes' },
      enabledTabs: ['Personal', 'Services', 'MadeUpTab'],
      recommendedTabs: [{ tab: 'Services', reason: 'core', priority: 'high' }],
    })
    assert.ok(!blueprint.enabledTabs.includes('MadeUpTab'))
    assert.ok(issues.some((i) => i.code === 'unsupported_tab'))
    assert.equal(looksLikeEmail('hello@acme.test'), true)
    assert.equal(looksLikeEmail('not-an-email'), false)
  })

  it('14. Terra escalation is confidence/complexity based, never random', () => {
    const terra = routeAiTier({ confidence: 0.8, complexity: 'complex' })
    const luna = routeAiTier({ confidence: 0.95, complexity: 'normal' })
    assert.equal(terra.tier, 'terra')
    assert.equal(luna.tier, 'luna')
  })

  it('15. Sol is rare and used for very complex or Terra-failed jobs', () => {
    assert.equal(routeAiTier({ terraFailed: true }).tier, 'sol')
    assert.equal(routeAiTier({ confidence: 0.4, complexity: 'very_complex', conflictingSources: true }).tier, 'sol')
    assert.notEqual(routeAiTier({ confidence: 0.92, complexity: 'normal' }).tier, 'sol')
  })

  it('website page categories and boilerplate stripping', () => {
    assert.equal(classifyWebsitePage('https://ex.com/services', 'Our services'), 'services')
    assert.equal(classifyWebsitePage('https://ex.com/about-us', 'About us'), 'about')
    assert.equal(classifyWebsitePage('https://ex.com/faq', 'FAQ'), 'faq')
    const cleaned = stripWebsiteBoilerplate('Welcome We use cookies Accept all cookies Hello')
    assert.ok(!/accept all cookies/i.test(cleaned))
  })

  it('plumbing company gets trade tabs', () => {
    const tabs = decideRecommendedTabs(profile({ industry: 'plumbing contractor', licenses: ['HIC.123'] }))
    const ids = tabs.map((t) => t.navId)
    assert.ok(ids.includes('services'))
    assert.ok(ids.includes('certificates'))
    assert.ok(ids.includes('faq'))
  })

  it('extraction summary reports scrape vs skipped website without exposing model names', async () => {
    const { summarizeExtraction } = await import('../cardAgent.service')
    const summary = summarizeExtraction({
      userInstructions: '',
      manualText: 'Family plumber',
      website: {
        url: 'https://ex.com',
        pages: [{ url: 'https://ex.com', text: 'Hello', category: 'home' }],
        scrapeFailed: false,
      },
      documents: [],
      ocrResults: [{ id: '1', label: 'card.jpg', extractionMethod: 'ocr', text: 'phone' }],
      extractedText: 'Hello',
      images: [],
      warnings: [],
    })
    assert.equal(summary.steps[0]?.status, 'done')
    assert.equal(summary.steps[1]?.status, 'done')
    assert.ok(summary.steps[1]?.detail?.includes('image'))
    const userFacing = summary.steps.map((s) => `${s.label} ${s.detail || ''}`).join(' ')
    assert.equal(/Luna|Terra|Sol|\bOCR\b/i.test(userFacing), false)
  })

  it('architecture task always routes to Sol internally', () => {
    const route = selectModelForTask({ task: 'CARD_ARCHITECTURE', hasImages: true })
    assert.equal(route.tier, 'sol')
    assert.equal(getModelForTier('sol'), process.env.OPENAI_CARD_MODEL_SOL?.trim() || 'gpt-5.6-sol')
    assert.equal(getModelForTier('terra'), process.env.OPENAI_CARD_MODEL_TERRA?.trim() || 'gpt-5.6-terra')
    assert.equal(getModelForTier('luna'), process.env.OPENAI_CARD_MODEL_LUNA?.trim() || 'gpt-5.6-luna')
    assert.equal(getModelForTier('vision'), process.env.OPENAI_CARD_MODEL_VISION?.trim() || 'gpt-4o')
    const solCandidates = modelCandidatesForTier('sol')
    assert.equal(solCandidates[0], getModelForTier('sol'))
    assert.ok(solCandidates.includes('gpt-4o') || solCandidates.includes('gpt-4.1'))
    assert.equal(
      isUnavailableModelError({ status: 404, code: 'model_not_found', message: 'model does not exist' }),
      true
    )
    assert.equal(isUnavailableModelError({ status: 429, message: 'rate limit' }), false)
  })

  it('vision/images never use Luna for writing', () => {
    const route = selectModelForTask({ task: 'SIMPLE_VOLUME', hasImages: true })
    assert.equal(route.tier, 'vision')
  })

  it('field graph marks found contacts READY and missing FAQ EMPTY', async () => {
    const { buildFieldGraph, nextActionableField } = await import('../fieldGraph.service')
    const { skipField } = await import('../fieldCompletion.service')
    const tabs = decideRecommendedTabs(profile({}))
    const fields = buildFieldGraph({
      profile: profile({}),
      recommendedTabs: tabs,
      selectedNavIds: ['home', 'services', 'faq'],
    })
    const phone = fields.find((f) => f.fieldKey === 'phone')
    const dob = fields.find((f) => f.fieldKey === 'dob')
    const faq = fields.find((f) => f.fieldKey === 'faqs')
    assert.equal(phone?.status, 'READY')
    assert.equal(phone?.required, true)
    assert.equal(dob?.status, 'EMPTY')
    assert.equal(dob?.required, true)
    assert.equal(faq?.status, 'EMPTY')
    assert.equal(faq?.aiGenerationAllowed, true)
    const skipped = skipField(faq!)
    assert.equal(skipped.status, 'SKIPPED')
    assert.equal(skipped.userDecision, true)
    const next = nextActionableField(
      fields.map((f) => (f.id === faq!.id ? skipped : f)),
      ['home', 'services', 'faq']
    )
    assert.equal(next?.fieldKey, 'dob')
    assert.match(next?.prompt || '', /required/i)
    assert.match(next?.prompt || '', /cannot be inferred or generated/i)
  })

  it('asks for missing email then phone then date of birth at creation, and reuses existing card contacts', async () => {
    const { applyExistingCardToProfile, buildFieldGraph, nextActionableField } = await import('../fieldGraph.service')
    const seeded = applyExistingCardToProfile(profile({ email: null, phone: null, dateOfBirth: null }), {
      personal: { email: 'owner@card.test', phone: '8605550100', dob: '1990-05-05', fullName: 'Pat Owner' },
    })
    assert.equal(seeded.email, 'owner@card.test')
    assert.equal(seeded.phone, '8605550100')
    assert.equal(seeded.dateOfBirth, '1990-05-05')
    const missing = buildFieldGraph({
      profile: profile({ email: null, phone: null, dateOfBirth: null, ownerName: 'Pat' }),
      recommendedTabs: decideRecommendedTabs(profile({})),
      selectedNavIds: ['home', 'services'],
    })
    const first = nextActionableField(missing, ['home', 'services'])
    assert.equal(first?.fieldKey, 'email')
    const afterEmail = missing.map((field) =>
      field.fieldKey === 'email' ? { ...field, status: 'READY' as const, currentValue: 'a@b.co' } : field
    )
    assert.equal(nextActionableField(afterEmail, ['home', 'services'])?.fieldKey, 'phone')
  })

  it('does not allow AI to invent reviews or licenses', async () => {
    const { generateFieldCopy } = await import('../fieldCompletion.service')
    await assert.rejects(
      () =>
        generateFieldCopy({
          field: {
            id: 'reviews:reviews',
            tabId: 'reviews',
            sectionId: 'reviews',
            fieldKey: 'reviews',
            fieldLabel: 'Reviews',
            required: false,
            status: 'EMPTY',
            source: 'NONE',
            aiGenerationAllowed: false,
            prompt: 'no',
            special: 'reviews',
          },
          profile: profile({}),
        }),
      /cannot create real customer reviews|cannot invent/i
    )
  })

  it('21. award objects and zero ratings from the model still parse', () => {
    const parsed = masterBusinessProfileSchema.parse({
      businessName: 'Next Creavo',
      awards: [{ title: 'Best Digital Agency', year: 2024 }],
      verifiedReviews: [{ author: 'Alex', text: 'Great work', rating: 0 }],
      suggestedTestimonialTemplates: [
        { author: 'Sample Client', text: 'Loved the launch', rating: 0 },
        { text: 'Would recommend', rating: 0 },
      ],
    })
    assert.equal(parsed.awards[0], 'Best Digital Agency — 2024')
    assert.equal(parsed.verifiedReviews[0]?.rating, undefined)
    assert.equal(parsed.suggestedTestimonialTemplates[0]?.rating, 5)
    assert.equal(parsed.suggestedTestimonialTemplates[1]?.rating, 5)
  })

  it('keeps an explicitly sourced date of birth through the AI blueprint', () => {
    const facts = profileToBlueprintFacts(profile({ dateOfBirth: '1990-07-18' }), [])
    assert.equal(facts.personal?.dob, '1990-07-18')

    const valid = sanitizeBlueprint({
      businessSummary: 'Profile',
      suggestedSlug: 'profile',
      personal: { fullName: 'Profile Owner', dob: '1990-07-18' },
    })
    assert.equal(valid.blueprint.personal.dob, '1990-07-18')
    assert.equal(looksLikeDateOnly('1990-07-18'), true)
  })

  it('drops malformed dates of birth instead of persisting invalid dates', () => {
    const result = sanitizeBlueprint({
      businessSummary: 'Profile',
      suggestedSlug: 'profile',
      personal: { fullName: 'Profile Owner', dob: '1990-02-31' },
    })
    assert.equal(result.blueprint.personal.dob, '')
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.code === 'invalid_date_of_birth' && issue.message === 'Please enter a valid date of birth (YYYY-MM-DD).'
      )
    )
  })

  it('drops underage dates of birth instead of persisting them', () => {
    const now = new Date()
    const underage = new Date(now.getFullYear() - 12, now.getMonth(), now.getDate() + 1)
    const dob = `${underage.getFullYear()}-${String(underage.getMonth() + 1).padStart(2, '0')}-${String(underage.getDate()).padStart(2, '0')}`
    const result = sanitizeBlueprint({
      businessSummary: 'Profile',
      suggestedSlug: 'profile',
      personal: { fullName: 'Profile Owner', dob },
    })
    assert.equal(result.blueprint.personal.dob, '')
    assert.ok(
      result.issues.some(
        (issue) => issue.code === 'underage_date_of_birth' && issue.message === 'You must be at least 12 years old.'
      )
    )
  })

  it('resolves create lifecycle status from the published flags', () => {
    assert.deepEqual(resolveInitialCardLifecycle({ isDraft: false, isPublic: true }), {
      statusName: 'active',
      isDraft: false,
      isPublic: true,
    })
    assert.deepEqual(resolveInitialCardLifecycle({}), {
      statusName: 'draft',
      isDraft: true,
      isPublic: false,
    })
  })

  it('keeps slug candidates normalized before automatic uniqueness suffixing', () => {
    assert.equal(slugify('  Jane Doe & Company  '), 'jane-doe-company')
  })

  it('blocks activation until starred card fields are complete', () => {
    const issues = collectCardActivationIssues({
      slug: 'profile-owner',
      name: 'Profile Owner',
      email: 'owner@example.com',
      dob: '',
      phone: '',
    })
    assert.deepEqual(
      issues.map((issue) => issue.field),
      ['dob']
    )
    assert.match(cardActivationIssueMessage(issues), /date of birth/)
  })

  it('allows activation without a unique email', () => {
    assert.equal(
      collectCardActivationIssues({
        slug: 'profile-owner',
        name: 'Profile Owner',
        email: '',
        dob: '1990-07-18',
        phone: '',
      }).length,
      0
    )
  })

  it('allows activation without a phone number', () => {
    assert.equal(
      collectCardActivationIssues({
        slug: 'profile-owner',
        name: 'Profile Owner',
        email: 'owner@example.com',
        dob: '1990-07-18',
        phone: '',
      }).length,
      0
    )
  })

  it('requires email, phone, and date of birth for every new card, including drafts', () => {
    const missing = collectCardCreationIssues({ email: '', phone: '', dob: '' })
    assert.deepEqual(
      missing.map((issue) => issue.field),
      ['email', 'phone', 'dob']
    )
    assert.equal(cardCreationIssueMessage(missing[0]!), 'Email is required to create a card.')

    const missingPhone = collectCardCreationIssues({
      email: 'owner@example.com',
      phone: '',
      dob: '1990-07-18',
    })
    assert.equal(missingPhone[0]?.field, 'phone')

    const invalid = collectCardCreationIssues({
      email: 'owner@example.com',
      phone: '12025550101',
      dob: '1990-02-31',
    })
    assert.equal(invalid[0]?.reason, 'invalid')
    assert.equal(
      collectCardCreationIssues({
        email: 'owner@example.com',
        phone: '12025550101',
        dob: '1990-07-18',
      }).length,
      0
    )
  })

  it('rejects an invalid phone number when one is provided', () => {
    const issues = collectCardActivationIssues({
      slug: 'profile-owner',
      name: 'Profile Owner',
      email: 'owner@example.com',
      dob: '1990-07-18',
      phone: '123',
    })
    assert.equal(
      issues.some((issue) => issue.field === 'phone' && issue.reason === 'invalid'),
      true
    )
  })

  it('normalizes card email casing and whitespace without imposing card uniqueness', () => {
    assert.equal(normalizeCardEmail('  Owner@Example.COM '), 'owner@example.com')
  })

  it('flags email or phone already used on another card only for create-time matching', () => {
    assert.equal(
      findCreateContactConflict(
        { email: 'Owner@Example.COM', phone: '+1 (202) 555-0101' },
        { email: 'owner@example.com', phone: '999' }
      ),
      'email'
    )
    assert.equal(
      findCreateContactConflict(
        { email: 'new@example.com', phone: '+1 (202) 555-0101' },
        { email: 'owner@example.com', phone: '1 (202) 555-0101' }
      ),
      'phone'
    )
    assert.equal(
      findCreateContactConflict(
        { email: 'new@example.com', phone: '12025550199' },
        { email: 'owner@example.com', phone: '12025550101' }
      ),
      null
    )
  })

  it('normalizes phone formatting only for activation validation', () => {
    assert.equal(normalizeCardPhone('+1 (202) 555-0101'), '12025550101')
    assert.equal(
      collectCardActivationIssues({
        slug: 'profile-owner',
        name: 'Profile Owner',
        email: 'owner@example.com',
        dob: '1990-07-18',
        phone: '+1 (202) 555-0101',
      }).length,
      0
    )
    assert.equal(
      collectCardActivationIssues({
        slug: 'profile-owner',
        name: 'Profile Owner',
        email: 'owner@example.com',
        dob: '1990-07-18T00:00:00.000Z',
        phone: '+1 (202) 555-0101',
      }).some((issue) => issue.field === 'dob' && issue.reason === 'invalid'),
      true
    )
    assert.equal(
      collectCardActivationIssues({
        slug: 'profile-owner',
        name: 'Profile Owner',
        email: 'owner@example.com',
        dob: minCardAgeCutoffDate(),
        phone: '+1 (202) 555-0101',
      }).length,
      0
    )
    const now = new Date()
    const underage = new Date(now.getFullYear() - 12, now.getMonth(), now.getDate() + 1)
    const underageDob = `${underage.getFullYear()}-${String(underage.getMonth() + 1).padStart(2, '0')}-${String(underage.getDate()).padStart(2, '0')}`
    const underageIssues = collectCardActivationIssues({
      slug: 'profile-owner',
      name: 'Profile Owner',
      email: 'owner@example.com',
      dob: underageDob,
      phone: '+1 (202) 555-0101',
    })
    assert.equal(
      underageIssues.some((issue) => issue.field === 'dob' && issue.reason === 'underage'),
      true
    )
    assert.equal(
      cardActivationIssueMessage(underageIssues),
      'Card cannot be activated. You must be at least 12 years old.'
    )
  })
})
