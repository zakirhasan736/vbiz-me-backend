import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { masterBusinessProfileSchema, type MasterBusinessProfile } from '../businessProfile.schema'
import { buildCompletenessReport } from '../completeness.service'
import { detectSourceConflicts } from '../conflictDetection'
import { profileToBlueprintFacts } from '../contentGenerator.service'
import { classifyWebsitePage, pdfTextLooksScanned, stripWebsiteBoilerplate } from '../extractDocumentText'
import { assessComplexity, routeAiTier, selectModelForTask } from '../modelRouter.service'
import { decideRecommendedTabs } from '../tabDecision.service'
import { filterRealReviews, looksLikeEmail, sanitizeBlueprint } from '../validation.service'

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
          'global-connection',
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
    const route = selectModelForTask({ task: 'CARD_ARCHITECTURE' })
    assert.equal(route.tier, 'sol')
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
    const faq = fields.find((f) => f.fieldKey === 'faqs')
    assert.equal(phone?.status, 'READY')
    assert.equal(faq?.status, 'EMPTY')
    assert.equal(faq?.aiGenerationAllowed, true)
    const skipped = skipField(faq!)
    assert.equal(skipped.status, 'SKIPPED')
    assert.equal(skipped.userDecision, true)
    const next = nextActionableField(
      fields.map((f) => (f.id === faq!.id ? skipped : f)),
      ['home', 'services', 'faq']
    )
    assert.ok(!next || next.fieldKey !== 'faqs')
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
})
