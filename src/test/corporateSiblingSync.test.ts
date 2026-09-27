import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cardBelongsToCorporation,
  corporateSiblingProfileWhere,
  isCorporateSiblingSyncRunning,
  isPersonalCollectionKind,
  isPersonalStorage,
  isSharedSettingKey,
  isSparseSharedSettingValue,
  remapSharedSettingIds,
  shouldCopySharedSetting,
  shouldFanOutCollection,
  shouldReplaceSiblingRows,
  storageToPrismaModel,
  takeMatchingCustomTab,
} from '../utils/corporateSiblingSync'

describe('isSharedSettingKey', () => {
  it('shares home media, social extras, SEO, and About Me; keeps identity keys personal', () => {
    assert.equal(isSharedSettingKey('tab_section_meta_json'), true)
    assert.equal(isSharedSettingKey('tab_label_overrides_json'), true)
    assert.equal(isSharedSettingKey('custom_tabs_json'), true)
    assert.equal(isSharedSettingKey('display_settings_json'), true)
    assert.equal(isSharedSettingKey('about_me_title'), true)
    assert.equal(isSharedSettingKey('about_me_featured_media_url'), true)
    assert.equal(isSharedSettingKey('profile_media_url'), true)
    assert.equal(isSharedSettingKey('background_media_url'), true)
    assert.equal(isSharedSettingKey('extra_fields_json'), true)
    assert.equal(isSharedSettingKey('seo_meta_title'), true)
    assert.equal(isSharedSettingKey('seo_image_url'), true)
    assert.equal(isSharedSettingKey('game_ids_json'), true)
    assert.equal(isSharedSettingKey('my_info_json'), false)
    assert.equal(isSharedSettingKey('avatar'), false)
    assert.equal(isSharedSettingKey('avatar_url'), false)
    assert.equal(isSharedSettingKey('duplicated_from'), false)
    assert.equal(isSharedSettingKey(''), false)
  })
})

describe('collection fan-out rules', () => {
  it('syncs shared list tabs including socials and skips personal addresses', () => {
    assert.equal(shouldFanOutCollection('services'), true)
    assert.equal(shouldFanOutCollection('reviews'), true)
    assert.equal(shouldFanOutCollection('portfolios'), true)
    assert.equal(shouldFanOutCollection('education'), true)
    assert.equal(shouldFanOutCollection('skillTags'), true)
    assert.equal(shouldFanOutCollection('socialLinks'), true)
    assert.equal(shouldFanOutCollection('addresses'), false)
    assert.equal(isPersonalCollectionKind('socialLinks'), false)
    assert.equal(isPersonalCollectionKind('addresses'), true)
    assert.equal(isPersonalCollectionKind('services'), false)
    assert.equal(isPersonalStorage('about_me'), false)
    assert.equal(isPersonalStorage('faq'), false)
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

describe('cardBelongsToCorporation', () => {
  it('keeps only cards in that corporation and rejects another company', () => {
    assert.equal(cardBelongsToCorporation('corp-a', { userId: 'corp-a', companyUserId: 'corp-a' }), true)
    assert.equal(cardBelongsToCorporation('corp-a', { userId: 'jacky', companyUserId: 'corp-a' }), true)
    assert.equal(cardBelongsToCorporation('corp-a', { userId: 'corp-a', companyUserId: null }), true)
    assert.equal(cardBelongsToCorporation('corp-a', { userId: 'jacky', companyUserId: 'corp-b' }), false)
    assert.equal(cardBelongsToCorporation('corp-a', { userId: 'corp-b', companyUserId: 'corp-b' }), false)
    assert.equal(
      cardBelongsToCorporation('corp-a', { userId: 'corp-a', companyUserId: 'corp-b' }, new Set(['corp-b'])),
      false
    )
    assert.equal(cardBelongsToCorporation('corp-a', { userId: 'corp-a', companyUserId: 'admin-1' }), true)
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

describe('empty / stale fan-out guards', () => {
  it('treats empty tab-name JSON as sparse so it cannot wipe sibling labels', () => {
    assert.equal(isSparseSharedSettingValue('tab_label_overrides_json', '{}'), true)
    assert.equal(isSparseSharedSettingValue('tab_label_overrides_json', ''), true)
    assert.equal(isSparseSharedSettingValue('custom_tabs_json', '[]'), true)
    assert.equal(isSparseSharedSettingValue('tab_label_overrides_json', '{"services":"Our Services"}'), false)
  })

  it('does not copy empty tab settings unless this card already had a real value', () => {
    assert.equal(
      shouldCopySharedSetting({
        key: 'tab_label_overrides_json',
        sourceValue: '{}',
        sourceHadValueBeforeWrite: false,
      }),
      false
    )
    assert.equal(
      shouldCopySharedSetting({
        key: 'tab_label_overrides_json',
        sourceValue: '{"services":"Services"}',
        sourceHadValueBeforeWrite: false,
      }),
      true
    )
    assert.equal(
      shouldCopySharedSetting({
        key: 'tab_label_overrides_json',
        sourceValue: '{}',
        sourceHadValueBeforeWrite: true,
      }),
      true
    )
  })

  it('does not wipe sibling lists from an empty no-op save', () => {
    assert.equal(shouldReplaceSiblingRows(0, false), false)
    assert.equal(shouldReplaceSiblingRows(3, false), true)
    assert.equal(shouldReplaceSiblingRows(0, true), true)
  })
})
