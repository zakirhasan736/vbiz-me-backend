import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { themeConfigFromRecommendation } from '../services/ai/themeFromRecommendation'

describe('themeConfigFromRecommendation', () => {
  it('maps light and dark brand HEX into themeConfig colors', () => {
    const theme = themeConfigFromRecommendation({
      light: { primary: '#0f766e', secondary: '#0f2c4d', accent: '#f43f5e' },
      dark: { primary: '#2dd4bf', secondary: '#e2e8f0', accent: '#fb7185' },
      source: 'website',
      notes: 'From site CSS',
    })
    assert.ok(theme)
    const colors = theme.colors as {
      light: { primary: string; secondary: string; accent: string }
      dark: { primary: string; secondary: string; accent: string }
    }
    assert.equal(colors.light.primary, '#0f766e')
    // Secondary may be contrast-adjusted when used as text on primary fills.
    assert.match(colors.light.secondary, /^#[0-9a-f]{6}$/)
    assert.equal(colors.light.accent, '#f43f5e')
    assert.equal(colors.dark.primary, '#2dd4bf')
    assert.equal(colors.dark.accent, '#fb7185')
    assert.equal((theme.aiThemeMeta as { source: string }).source, 'website')
  })

  it('returns null when no valid HEX colors are present', () => {
    assert.equal(
      themeConfigFromRecommendation({
        light: { primary: '', secondary: '', accent: '' },
        dark: { primary: 'navy', secondary: '', accent: '' },
        source: 'suggestion',
        notes: '',
      }),
      null
    )
  })
})
