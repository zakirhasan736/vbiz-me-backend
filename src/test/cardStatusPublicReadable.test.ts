import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { publicReadableWhere, publicVisibleWhere } from '../utils/cardStatus'

describe('publicReadableWhere', () => {
  it('requires published flags so Visibility OFF cards 404 on live slug', () => {
    const where = publicReadableWhere()
    assert.equal(where.isPublic, true)
    assert.equal(where.isDraft, false)
    const blocked = (where.NOT as { status?: { name?: { in?: string[] } } })?.status?.name?.in || []
    assert.ok(blocked.includes('inactive'))
    assert.ok(blocked.includes('draft'))
    assert.ok(blocked.includes('paused'))
    assert.ok(blocked.includes('suspended'))
  })

  it('matches directory visibility requirements for published cards', () => {
    const readable = publicReadableWhere()
    const visible = publicVisibleWhere()
    assert.equal(readable.isPublic, visible.isPublic)
    assert.equal(readable.isDraft, visible.isDraft)
  })
})
