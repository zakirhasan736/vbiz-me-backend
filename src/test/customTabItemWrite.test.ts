import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveCustomTabItemWrite } from '../utils/customTabItemWrite'

const cardId = 'cmuwlh3m70040a6kcyng1eosi'

describe('resolveCustomTabItemWrite', () => {
  it('updates a row this card already saved', () => {
    assert.deepEqual(
      resolveCustomTabItemWrite({
        requestedId: 'custom_item_1',
        existingProfileId: cardId,
        cardProfileId: cardId,
        alreadyUsed: false,
      }),
      { mode: 'update', id: 'custom_item_1' }
    )
  })

  it('creates a first-time editor id', () => {
    assert.deepEqual(
      resolveCustomTabItemWrite({
        requestedId: 'custom_item_new',
        existingProfileId: null,
        cardProfileId: cardId,
        alreadyUsed: false,
      }),
      { mode: 'create', id: 'custom_item_new' }
    )
  })

  it('creates without an id when the payload has none, repeats one, or the id belongs to another card', () => {
    assert.deepEqual(
      resolveCustomTabItemWrite({
        requestedId: '  ',
        existingProfileId: null,
        cardProfileId: cardId,
        alreadyUsed: false,
      }),
      { mode: 'create' }
    )
    assert.deepEqual(
      resolveCustomTabItemWrite({
        requestedId: 'custom_item_1',
        existingProfileId: cardId,
        cardProfileId: cardId,
        alreadyUsed: true,
      }),
      { mode: 'create' }
    )
    assert.deepEqual(
      resolveCustomTabItemWrite({
        requestedId: 'custom_item_other',
        existingProfileId: 'other-card',
        cardProfileId: cardId,
        alreadyUsed: false,
      }),
      { mode: 'create' }
    )
  })
})
