import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { masterBusinessProfileSchema } from '../businessProfile.schema'
import {
  extractThemeRecommendationFromText,
  mergeThemeRecommendations,
  resolveProfileThemeRecommendation,
} from '../themeFromDocuments'
import { themeConfigFromRecommendation } from '../themeFromRecommendation'

describe('theme from PDF/text documents', () => {
  it('reads light and dark Primary/Secondary/Accent HEX from brand guideline text', () => {
    const text = `
Brand colors for the card

Light theme
Primary: #0F766E
Secondary: #0F2C4D
Accent: #F43F5E

Dark theme
Primary: #2DD4BF
Secondary: #E2E8F0
Accent: #FB7185
`
    const rec = extractThemeRecommendationFromText(text)
    assert.ok(rec)
    assert.equal(rec?.source, 'document')
    assert.equal(rec?.light.primary, '#0f766e')
    assert.equal(rec?.light.secondary, '#0f2c4d')
    assert.equal(rec?.light.accent, '#f43f5e')
    assert.equal(rec?.dark.primary, '#2dd4bf')
    assert.equal(rec?.dark.secondary, '#e2e8f0')
    assert.equal(rec?.dark.accent, '#fb7185')

    const theme = themeConfigFromRecommendation(rec)
    assert.ok(theme)
    const colors = theme!.colors as {
      light: { primary: string; accent: string }
      dark: { primary: string; accent: string }
    }
    assert.equal(colors.light.primary, '#0f766e')
    assert.equal(colors.dark.primary, '#2dd4bf')
    assert.equal(colors.light.accent, '#f43f5e')
    assert.equal(colors.dark.accent, '#fb7185')
  })

  it('reads prefixed light/dark role keys without section headers', () => {
    const rec = extractThemeRecommendationFromText(
      'light primary #112233 dark primary #aabbcc light secondary #445566 dark secondary #ddeeff light accent #778899 dark accent #990011'
    )
    assert.equal(rec?.light.primary, '#112233')
    assert.equal(rec?.dark.primary, '#aabbcc')
    assert.equal(rec?.light.accent, '#778899')
  })

  it('document colors win empty AI slots and map onto the profile', () => {
    const profile = masterBusinessProfileSchema.parse({
      businessName: 'Acme',
      themeRecommendation: {
        light: { primary: '', secondary: '', accent: '' },
        dark: { primary: '', secondary: '', accent: '' },
        source: 'suggestion',
        notes: '',
      },
    })
    const next = resolveProfileThemeRecommendation(
      profile,
      'Light theme\nPrimary: #123456\nSecondary: #234567\nAccent: #345678\nDark theme\nPrimary: #abcdef\nSecondary: #bcdef0\nAccent: #cdef01'
    )
    assert.equal(next.themeRecommendation?.source, 'document')
    assert.equal(next.themeRecommendation?.light.primary, '#123456')
    assert.equal(next.themeRecommendation?.dark.primary, '#abcdef')
    const merged = mergeThemeRecommendations(next.themeRecommendation, {
      light: { primary: '#ffffff', secondary: '#111111', accent: '#222222' },
      dark: { primary: '#333333', secondary: '#444444', accent: '#555555' },
      source: 'suggestion',
      notes: 'AI',
    })
    assert.equal(merged?.light.primary, '#123456')
  })
})
