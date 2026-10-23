import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isSectionScopedInstruction, mergeSectionIntoDraft } from '../services/ai/sectionPatch.service'

describe('sectionPatch', () => {
  it('merges About without wiping unrelated personal fields', () => {
    const merged = mergeSectionIntoDraft(
      {
        personal: {
          fullName: 'Jane Doe',
          email: 'jane@example.com',
          dob: '1990-01-01',
          about: 'Old about',
        },
        services: [{ title: 'Keep Me', description: 'A' }],
      },
      'personal',
      {
        personal: {
          about: 'I help buyers find homes with clear guidance and local expertise across the market.',
        },
      }
    )
    const personal = merged.personal as Record<string, string>
    assert.equal(personal.email, 'jane@example.com')
    assert.equal(personal.dob, '1990-01-01')
    assert.match(personal.about, /^I help/)
    assert.equal((merged.services as unknown[]).length, 1)
  })

  it('replaces only services array', () => {
    const merged = mergeSectionIntoDraft(
      {
        personal: { about: 'Keep' },
        services: [{ title: 'Old' }],
        faqs: [{ question: 'Q?', answer: 'A' }],
      },
      'services',
      {
        services: [{ title: '🏠 New', description: 'Benefit copy.' }],
      }
    )
    assert.equal((merged.services as Array<{ title: string }>)[0].title, '🏠 New')
    assert.equal((merged.faqs as unknown[]).length, 1)
    assert.equal((merged.personal as { about: string }).about, 'Keep')
  })

  it('detects section-scoped instructions', () => {
    assert.equal(isSectionScopedInstruction('Shorten my About Me by one-third.'), true)
    assert.equal(isSectionScopedInstruction('Rewrite the entire card from scratch'), false)
  })
})
