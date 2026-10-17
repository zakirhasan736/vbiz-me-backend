import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractBrandColorEvidence,
  formatBrandColorResearchBlock,
  themeRecommendationFromWebsite,
} from '../brandColorEngine'
import { masterBusinessProfileSchema } from '../businessProfile.schema'
import { contrastRatio, parseCssColor } from '../cssColorParse'
import {
  extractThemeRecommendationFromBrandResearchBlock,
  mergeThemeRecommendations,
  resolveProfileThemeRecommendation,
} from '../themeFromDocuments'
import { themeConfigFromRecommendation } from '../themeFromRecommendation'

describe('cssColorParse', () => {
  it('parses hex, rgb, hsl, named, var fallback, oklch, and color-mix', () => {
    assert.equal(parseCssColor('#0F766E')?.hex, '#0f766e')
    assert.equal(parseCssColor('#0f7')?.hex, '#00ff77')
    assert.equal(parseCssColor('rgb(30, 144, 255)')?.hex, '#1e90ff')
    assert.equal(parseCssColor('rgb(30 144 255 / 80%)')?.hex, '#1e90ff')
    assert.equal(parseCssColor('rgb(30 144 255 / 80%)')?.alpha, 0.8)
    const hslBlue = parseCssColor('hsl(210, 100%, 56%)')?.hex
    assert.ok(hslBlue)
    assert.match(hslBlue!, /^#[0-9a-f]{6}$/)
    // Dodger-blue family (rounding differs slightly by conversion path).
    assert.ok(/^#1[ef]8[ef]ff$/.test(hslBlue!))
    assert.equal(parseCssColor('navy')?.hex, '#000080')
    assert.equal(parseCssColor('var(--missing, #112233)')?.hex, '#112233')
    assert.equal(parseCssColor('var(--brand)', { '--brand': '#abcdef' })?.hex, '#abcdef')
    assert.ok(parseCssColor('oklch(0.7 0.15 220)')?.hex)
    assert.equal(parseCssColor('color-mix(in srgb, #000000 50%, #ffffff)')?.hex, '#808080')
    assert.equal(parseCssColor('transparent'), null)
  })
})

describe('brandColorEngine website themes', () => {
  const sampleHtml = `
<!doctype html>
<html>
<head>
  <meta name="theme-color" content="#0F766E" />
  <style>
    :root {
      --primary-color: #0F766E;
      --brand-accent: hsl(350 80% 55%);
      --header-bg: rgb(15, 44, 77);
    }
    .btn-primary, a.cta {
      background-color: var(--primary-color);
      color: #ffffff;
    }
    header.nav { background: var(--header-bg); }
    .highlight { color: var(--brand-accent); }
  </style>
</head>
<body>
  <header class="nav"><a class="cta" style="background:#0F766E">Book now</a></header>
  <svg><path fill="#0F766E" /></svg>
</body>
</html>`

  it('extracts CSS variables, CTA, and theme-color evidence', () => {
    const evidence = extractBrandColorEvidence(sampleHtml)
    assert.ok(evidence.some((e) => e.hex === '#0f766e' && e.usage === 'brand_token'))
    assert.ok(evidence.some((e) => e.usage === 'primary_cta' || e.usage === 'brand_token'))
    assert.ok(evidence.some((e) => e.sourceType === 'html_attribute'))
  })

  it('builds light+dark Primary/Secondary/Accent with usable contrast', () => {
    const result = themeRecommendationFromWebsite(sampleHtml)
    assert.ok(result)
    const { recommendation } = result
    assert.equal(recommendation.source, 'website')
    assert.match(recommendation.light.primary, /^#[0-9a-f]{6}$/)
    assert.match(recommendation.light.secondary, /^#[0-9a-f]{6}$/)
    assert.match(recommendation.light.accent, /^#[0-9a-f]{6}$/)
    assert.match(recommendation.dark.primary, /^#[0-9a-f]{6}$/)
    // Primary text on light page
    assert.ok(contrastRatio(recommendation.light.primary, '#ffffff') >= 3)
    // Secondary (button text) on Primary fill
    assert.ok(contrastRatio(recommendation.light.secondary, recommendation.light.primary) >= 2.5)
    const theme = themeConfigFromRecommendation(recommendation)
    assert.ok(theme)
    const colors = theme!.colors as {
      light: { primary: string; secondary: string; accent: string }
      dark: { primary: string; secondary: string; accent: string }
    }
    assert.equal(colors.light.primary, recommendation.light.primary)
    assert.equal(colors.dark.accent, recommendation.dark.accent)
  })

  it('brand research block parses back into website themeRecommendation', () => {
    const result = themeRecommendationFromWebsite(sampleHtml)
    assert.ok(result)
    const block = formatBrandColorResearchBlock(result.recommendation, result.evidence)
    const parsed = extractThemeRecommendationFromBrandResearchBlock(block)
    assert.equal(parsed?.source, 'website')
    assert.equal(parsed?.light.primary, result.recommendation.light.primary)
    assert.equal(parsed?.dark.secondary, result.recommendation.dark.secondary)
  })

  it('document colors still win over website when both present', () => {
    const website = themeRecommendationFromWebsite(sampleHtml)?.recommendation
    assert.ok(website)
    const profile = masterBusinessProfileSchema.parse({
      businessName: 'Acme',
      themeRecommendation: {
        light: { primary: '', secondary: '', accent: '' },
        dark: { primary: '', secondary: '', accent: '' },
        source: 'suggestion',
        notes: '',
      },
    })
    const docText = `Light theme
Primary: #123456
Secondary: #234567
Accent: #345678
Dark theme
Primary: #abcdef
Secondary: #bcdef0
Accent: #cdef01

${formatBrandColorResearchBlock(website, [])}`
    const next = resolveProfileThemeRecommendation(profile, docText, website)
    assert.equal(next.themeRecommendation?.source, 'document')
    assert.equal(next.themeRecommendation?.light.primary, '#123456')
    const websiteOnly = resolveProfileThemeRecommendation(profile, formatBrandColorResearchBlock(website, []), website)
    assert.equal(websiteOnly.themeRecommendation?.source, 'website')
    assert.equal(websiteOnly.themeRecommendation?.light.primary, website.light.primary)
  })

  it('merge prefers filled document roles without wiping website accents', () => {
    const merged = mergeThemeRecommendations(
      {
        light: { primary: '#111111', secondary: '', accent: '' },
        dark: { primary: '#222222', secondary: '', accent: '' },
        source: 'document',
        notes: 'doc',
      },
      {
        light: { primary: '#aaaaaa', secondary: '#bbbbbb', accent: '#cccccc' },
        dark: { primary: '#dddddd', secondary: '#eeeeee', accent: '#abcdef' },
        source: 'website',
        notes: 'web',
      }
    )
    assert.equal(merged?.light.primary, '#111111')
    assert.equal(merged?.light.secondary, '#bbbbbb')
    assert.equal(merged?.light.accent, '#cccccc')
  })
})
