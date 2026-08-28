import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  blankDuplicatedIdentityFields,
  cloneRecord,
  duplicatedCardOwnership,
  omitCloneKeys,
  remapDuplicatedCardSettings,
  settingsMapFromRows,
  unknownPrismaCreateArgs,
  unknownPrismaSelectFields,
} from '../utils/duplicateCard'

describe('blankDuplicatedIdentityFields', () => {
  it('clears only personal identity fields on a duplicated card', () => {
    const identity = blankDuplicatedIdentityFields()
    assert.equal(identity.name, '')
    assert.equal(identity.lastName, null)
    assert.equal(identity.slug, null)
    assert.equal(identity.dob, null)
    assert.equal(identity.email, '')
    assert.equal(identity.phone, null)
    assert.equal(identity.genderId, null)
    assert.equal('whatsapp' in identity, false)
    assert.equal('countryCode' in identity, false)
    assert.equal('maritalStatusId' in identity, false)
  })

  it('wins over any copied contact values when applied last', () => {
    const copiedContact = {
      skipCreateContactRules: true,
      email: 'owner@example.com',
      phone: '+1 202 555 0101',
    }
    const createInput = {
      ...copiedContact,
      ...blankDuplicatedIdentityFields(),
    }

    assert.equal(createInput.email, '')
    assert.equal(createInput.phone, null)
    assert.equal(createInput.name, '')
    assert.equal(createInput.slug, null)
    assert.equal(createInput.dob, null)
    assert.equal(createInput.lastName, null)
    assert.equal(createInput.skipCreateContactRules, true)
  })
})

describe('duplicatedCardOwnership', () => {
  it('keeps an admin-owned source on the admin portfolio', () => {
    assert.deepEqual(
      duplicatedCardOwnership({ userId: 'admin-1', companyUserId: 'admin-1', createdById: 'admin-1' }, 'admin-1'),
      { userId: 'admin-1', companyUserId: 'admin-1', createdById: 'admin-1' }
    )
  })

  it('assigns a directory duplicate to the source owner, not the logged-in admin', () => {
    assert.deepEqual(
      duplicatedCardOwnership({ userId: 'owner-9', companyUserId: 'corp-2', createdById: 'admin-1' }, 'admin-1'),
      { userId: 'owner-9', companyUserId: 'corp-2', createdById: 'owner-9' }
    )
  })
})

describe('settingsMapFromRows', () => {
  it('keeps empty and non-string setting values so display keys are not dropped', () => {
    assert.deepEqual(
      settingsMapFromRows([
        { key: 'display_settings_json', value: '{"editorNavOrder":["home"]}' },
        { key: 'profile_media_url', value: null },
        { key: 'wallpaper_opacity', value: 40 },
        { key: '', value: 'skip' },
        null,
      ]),
      {
        display_settings_json: '{"editorNavOrder":["home"]}',
        profile_media_url: '',
        wallpaper_opacity: '40',
      }
    )
  })
})

describe('cloneRecord', () => {
  it('drops ids and timestamps while keeping tab content', () => {
    const cloned = cloneRecord({
      id: 'src',
      profileId: 'old',
      title: 'Mission',
      description: 'We help owners.',
      sortOrder: 2,
      createdAt: new Date(),
      metas: { year: '2024' },
    })
    assert.equal(cloned.id, undefined)
    assert.equal(cloned.profileId, undefined)
    assert.equal(cloned.title, 'Mission')
    assert.equal(cloned.description, 'We help owners.')
    assert.deepEqual(cloned.metas, { year: '2024' })
  })

  it('skips nulls so Prisma/DB defaults apply and still copies JSON and dates', () => {
    const publishedAt = new Date('2024-06-01T00:00:00.000Z')
    const cloned = cloneRecord({
      id: 'src',
      profileId: 'old',
      createdAt: new Date(),
      updatedAt: null,
      deletedAt: null,
      status: null,
      sortOrder: null,
      title: 'BBB',
      metas: { year: '2024' },
      tags: ['a'],
      publishedAt,
      legacyPostTypeId: 8,
    })
    assert.equal('status' in cloned, false)
    assert.equal('sortOrder' in cloned, false)
    assert.equal('updatedAt' in cloned, false)
    assert.equal(cloned.title, 'BBB')
    assert.deepEqual(cloned.metas, { year: '2024' })
    assert.deepEqual(cloned.tags, ['a'])
    assert.equal(cloned.publishedAt, publishedAt)
    assert.equal(cloned.legacyPostTypeId, 8)
  })

  it('omits null JSON and still drops relation keys', () => {
    const cloned = cloneRecord({
      id: 'src',
      profile: { id: 'p' },
      customTabId: 'tab-1',
      metas: null,
      title: 'FAQ',
      legacyPostTypeId: 13,
    })
    assert.equal('metas' in cloned, false)
    assert.equal('profile' in cloned, false)
    assert.equal('customTabId' in cloned, false)
    assert.equal(cloned.legacyPostTypeId, 13)
  })

  it('strips unknown Prisma create arguments so duplicate works on older clients', () => {
    const error = new Error(
      'Invalid `prisma.gallery.create()` invocation:\nUnknown argument `legacyPostTypeId`. Available options are marked with ?.'
    )
    assert.deepEqual(unknownPrismaCreateArgs(error), ['legacyPostTypeId'])
    assert.deepEqual(
      omitCloneKeys({ title: 'CBNA RIZZ 1', status: '1', legacyPostTypeId: 4, profileId: 'p1' }, ['legacyPostTypeId']),
      { title: 'CBNA RIZZ 1', status: '1', profileId: 'p1' }
    )
    assert.deepEqual(
      unknownPrismaSelectFields(
        new Error('The column `metas` does not exist in the current database. Unknown field `legacyPostTypeId`.')
      ),
      ['legacyPostTypeId', 'metas']
    )
  })
})

describe('remapDuplicatedCardSettings', () => {
  it('assigns new custom tab ids and rewrites editor nav order', () => {
    const remapped = remapDuplicatedCardSettings(
      {
        custom_tabs_json: JSON.stringify([{ id: 'custom-tab-old', label: 'Press' }]),
        display_settings_json: JSON.stringify({ editorNavOrder: ['home', 'custom-tab-old', 'faq'] }),
      },
      'src-profile'
    )
    const tabs = JSON.parse(remapped.custom_tabs_json) as Array<{ id: string; label: string }>
    const display = JSON.parse(remapped.display_settings_json) as {
      editorNavOrder: string[]
      navOrderCustomized?: boolean
    }
    assert.equal(tabs[0]?.label, 'Press')
    assert.notEqual(tabs[0]?.id, 'custom-tab-old')
    assert.equal(display.editorNavOrder[0], 'home')
    assert.equal(display.editorNavOrder.includes(tabs[0]?.id || ''), true)
    assert.deepEqual(display.editorNavOrder.slice(-2), ['public-cards', 'my-info'])
    assert.equal(display.navOrderCustomized, false)
    assert.equal(remapped.duplicated_from, 'src-profile')
  })

  it('clears personal contact snapshots from copied My Info settings', () => {
    const remapped = remapDuplicatedCardSettings({
      my_info_json: JSON.stringify({
        headline: 'Ready When You Are',
        showCall: true,
        phone: '+1 202 555 0101',
        whatsapp: '+1 202 555 0101',
        email: 'owner@example.com',
      }),
    })
    const myInfo = JSON.parse(remapped.my_info_json) as {
      headline: string
      phone: string
      email: string
      whatsapp: string
    }
    assert.equal(myInfo.headline, 'Ready When You Are')
    assert.equal(myInfo.phone, '')
    assert.equal(myInfo.email, '')
    assert.equal(myInfo.whatsapp, '+1 202 555 0101')
  })
})
