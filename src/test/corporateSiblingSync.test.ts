import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  corporateSiblingProfileWhere,
  isCorporateSiblingSyncRunning,
  isPersonalCollectionKind,
  isSharedSettingKey,
  remapSharedSettingIds,
  shouldFanOutCollection,
  storageToPrismaModel,
  takeMatchingCustomTab,
} from '../utils/corporateSiblingSync'

describe('isSharedSettingKey', () => {
  it('keeps shared tab settings and rejects personal / SEO / identity keys', () => {
    assert.equal(isSharedSettingKey('tab_section_meta_json'), true)
    assert.equal(isSharedSettingKey('tab_label_overrides_json'), true)
    assert.equal(isSharedSettingKey('custom_tabs_json'), true)
    assert.equal(isSharedSettingKey('display_settings_json'), true)
    assert.equal(isSharedSettingKey('about_me_title'), true)
    assert.equal(isSharedSettingKey('profile_media_url'), false)
    assert.equal(isSharedSettingKey('background_media_url'), false)
    assert.equal(isSharedSettingKey('extra_fields_json'), false)
    assert.equal(isSharedSettingKey('my_info_json'), false)
    assert.equal(isSharedSettingKey('seo_meta_title'), false)
    assert.equal(isSharedSettingKey('seo_image_url'), false)
    assert.equal(isSharedSettingKey('duplicated_from'), false)
    assert.equal(isSharedSettingKey(''), false)
  })
})

describe('collection fan-out rules', () => {
  it('syncs shared list tabs and skips personal identity collections', () => {
    assert.equal(shouldFanOutCollection('services'), true)
    assert.equal(shouldFanOutCollection('reviews'), true)
    assert.equal(shouldFanOutCollection('portfolios'), true)
    assert.equal(shouldFanOutCollection('education'), true)
    assert.equal(shouldFanOutCollection('skillTags'), true)
    assert.equal(shouldFanOutCollection('socialLinks'), false)
    assert.equal(shouldFanOutCollection('addresses'), false)
    assert.equal(isPersonalCollectionKind('socialLinks'), true)
    assert.equal(isPersonalCollectionKind('services'), false)
  })
})

describe('storageToPrismaModel', () => {
  it('maps direct-tab storage names onto Prisma delegates', () => {
    assert.equal(storageToPrismaModel('faq'), 'faq')
    assert.equal(storageToPrismaModel('about_me'), 'aboutMe')
    assert.equal(storageToPrismaModel('why_choose_us'), 'whyChooseUs')
    assert.equal(storageToPrismaModel('mission_statement'), 'missionStatement')
    assert.equal(storageToPrismaModel('certificate_license'), 'certificateLicense')
  })
})

describe('corporateSiblingProfileWhere', () => {
  it('includes the corporate owner card and every company-linked card', () => {
    assert.deepEqual(corporateSiblingProfileWhere('corp-1'), {
      OR: [{ userId: 'corp-1' }, { companyUserId: 'corp-1' }],
    })
  })
})

describe('takeMatchingCustomTab', () => {
  it('matches by key first, then label, and never consumes a leftover remapped id', () => {
    const unused = [
      { id: 'sib-1', key: 'custom-tab-remapped', label: 'Press' },
      { id: 'sib-2', key: 'custom-tab-other', label: 'Awards' },
    ]
    const press = takeMatchingCustomTab({ key: 'custom-tab-source', label: 'Press' }, unused)
    assert.equal(press?.id, 'sib-1')
    assert.equal(unused.length, 1)
    assert.equal(unused[0]?.label, 'Awards')

    const exact = takeMatchingCustomTab({ key: 'custom-tab-other', label: 'Different' }, [
      { id: 'sib-3', key: 'custom-tab-other', label: 'Awards' },
    ])
    assert.equal(exact?.id, 'sib-3')
  })
})

describe('remapSharedSettingIds', () => {
  it('rewrites custom-tab ids inside shared tab JSON without touching built-in tab ids', () => {
    const remapped = remapSharedSettingIds(
      JSON.stringify({
        'custom-tab-src': { title: 'Press' },
        services: { title: 'Our services' },
      }),
      new Map([['custom-tab-src', 'custom-tab-sib']])
    )
    const parsed = JSON.parse(remapped) as Record<string, { title: string }>
    assert.equal(parsed['custom-tab-sib']?.title, 'Press')
    assert.equal(parsed.services?.title, 'Our services')
    assert.equal(parsed['custom-tab-src'], undefined)
  })
})

describe('isCorporateSiblingSyncRunning', () => {
  it('is idle outside a fan-out so a single card is a no-op later', () => {
    assert.equal(isCorporateSiblingSyncRunning(), false)
  })
})
