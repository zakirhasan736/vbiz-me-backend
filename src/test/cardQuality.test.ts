import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CardBlueprint } from '../services/ai/cardBlueprint.schema'
import { assessCardQuality } from '../services/ai/cardQuality.service'

function baseBlueprint(overrides: Partial<CardBlueprint> = {}): CardBlueprint {
  return {
    businessSummary: 'Summary',
    suggestedSlug: 'test-card',
    personal: {
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      dob: '',
      phone: '',
      whatsapp: '',
      designation: 'Realtor',
      company: 'Jane Realty',
      profession: 'Real Estate',
      address: '',
      website: '',
      about: 'We help buyers find homes every day with care and expertise across the region.',
    },
    socialHandles: {},
    education: [],
    experience: [],
    skills: [],
    services: [
      {
        type: 'Other',
        title: 'Home Buying',
        description: 'Short.',
        url: '',
      },
    ],
    portfolio: [],
    reviews: [],
    blogs: [],
    faqs: [{ question: 'Q?', answer: 'A.' }],
    enabledTabs: ['Personal', 'Services'],
    recommendedTabs: [],
    optionalFeatures: {
      aiAssistance: false,
      canva: true,
      seo: true,
      pushNotifications: true,
      emailNotifications: true,
    },
    ...overrides,
  }
}

describe('assessCardQuality', () => {
  it('flags company-voice about for an individual-looking card', () => {
    const { issues } = assessCardQuality({ blueprint: baseBlueprint() })
    assert.ok(issues.some((issue) => issue.code === 'about_not_first_person'))
  })

  it('accepts first-person about', () => {
    const { issues } = assessCardQuality({
      blueprint: baseBlueprint({
        personal: {
          ...baseBlueprint().personal,
          about:
            'I help families buy and sell homes with clear guidance, local expertise, and a calm process from first showing to closing day. Why Choose Us: I put your goals first.',
        },
        services: [
          {
            type: 'Other',
            title: '🏠 Buyer Representation',
            description:
              'I guide you through every step of buying a home — from neighborhood research and showings to offers and negotiations — so you move forward with confidence and clarity.',
            url: '',
          },
        ],
        faqs: [
          { question: '1', answer: 'a' },
          { question: '2', answer: 'a' },
          { question: '3', answer: 'a' },
          { question: '4', answer: 'a' },
          { question: '5', answer: 'a' },
        ],
      }),
    })
    assert.ok(!issues.some((issue) => issue.code === 'about_not_first_person'))
  })
})
