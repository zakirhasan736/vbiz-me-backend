import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  blankDuplicatedIdentityFields,
  cloneRecord,
  omitCloneKeys,
  remapDuplicatedCardSettings,
  unknownPrismaCreateArgs,
} from '../utils/duplicateCard'

describe('blankDuplicatedIdentityFields', () => {
  it('clears personal identity and contact fields on a duplicated card', () => {
    const identity = blankDuplicatedIdentityFields()
    assert.equal(identity.name, '')
    assert.equal(identity.lastName, null)
    assert.equal(identity.slug, null)
    assert.equal(identity.dob, null)
    assert.equal(identity.email, '')
    assert.equal(identity.phone, null)
    assert.equal(identity.whatsapp, null)
    assert.equal(identity.countryCode, null)
    assert.equal(identity.genderId, null)
    assert.equal(identity.maritalStatusId, null)
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
  })
})

describe('remapDuplicatedCardSettings', () => {
  it('assigns new custom tab ids and rewrites editor nav order', () => {
    const remapped = remapDuplicatedCardSettings({
      custom_tabs_json: JSON.stringify([{ id: 'custom-tab-old', label: 'Press' }]),
      display_settings_json: JSON.stringify({ editorNavOrder: ['home', 'custom-tab-old', 'faq'] }),
    })
    const tabs = JSON.parse(remapped.custom_tabs_json) as Array<{ id: string; label: string }>
    const display = JSON.parse(remapped.display_settings_json) as { editorNavOrder: string[] }
    assert.equal(tabs[0]?.label, 'Press')
    assert.notEqual(tabs[0]?.id, 'custom-tab-old')
    assert.equal(display.editorNavOrder[0], 'home')
    assert.equal(display.editorNavOrder[1], tabs[0]?.id)
    assert.equal(display.editorNavOrder[2], 'faq')
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
    const myInfo = JSON.parse(remapped.my_info_json) as { headline: string; phone: string; email: string }
    assert.equal(myInfo.headline, 'Ready When You Are')
    assert.equal(myInfo.phone, '')
    assert.equal(myInfo.email, '')
  })
})
