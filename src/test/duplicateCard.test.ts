import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  blankDuplicatedIdentityFields,
  cloneRecord,
  duplicateContactFields,
  remapDuplicatedCardSettings,
} from '../utils/duplicateCard'

describe('duplicateContactFields', () => {
  it('copies email and leaves date of birth off the duplicated identity', () => {
    assert.deepEqual(duplicateContactFields({ email: 'owner@example.com' }), {
      email: 'owner@example.com',
    })
    assert.equal('dob' in duplicateContactFields({ email: 'owner@example.com' }), false)
  })

  it('allows a duplicated card to reuse the same email', () => {
    const createInput = {
      skipCreateContactRules: true,
      ...duplicateContactFields({ email: 'owner@example.com' }),
      ...blankDuplicatedIdentityFields(),
    }

    assert.equal(createInput.email, 'owner@example.com')
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
})
