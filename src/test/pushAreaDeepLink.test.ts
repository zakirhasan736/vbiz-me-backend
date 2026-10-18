import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildPublicCardPathWithTab,
  encodePublicCardTabHash,
  pushAreaForCollection,
  pushAreaForPostType,
  pushAreaForProfileFields,
  renderPushAreaBody,
} from '../utils/pushAreaDeepLink'

describe('push area deep links', () => {
  it('encodes stable tab hashes for share and push URLs', () => {
    assert.equal(encodePublicCardTabHash('services'), '#services')
    assert.equal(encodePublicCardTabHash('#Gallery'), '#gallery')
    assert.equal(buildPublicCardPathWithTab('wd-card', 'services'), '/vCard/wd-card#services')
  })

  it('names collection updates with the tab area', () => {
    const services = pushAreaForCollection('services')
    assert.equal(services?.tabId, 'services')
    assert.match(renderPushAreaBody(services!.bodyTemplate, 'WD'), /WD updated or added services/)
    assert.equal(pushAreaForCollection('portfolios')?.tabId, 'gallery')
  })

  it('names profile picture vs contact vs theme specifically', () => {
    assert.equal(
      pushAreaForProfileFields({ themeTouched: false, contactTouched: false, avatarTouched: true }).title,
      'Profile picture updated'
    )
    assert.equal(
      pushAreaForProfileFields({ themeTouched: false, contactTouched: true, avatarTouched: false }).tabId,
      'profile'
    )
    assert.equal(
      pushAreaForProfileFields({ themeTouched: true, contactTouched: false, avatarTouched: false }).tabId,
      'home'
    )
  })

  it('maps post types to tab hashes when possible', () => {
    const blog = pushAreaForPostType('Blog')
    assert.ok(blog)
    assert.equal(blog.tabId, 'blog')
    assert.match(blog.bodyTemplate, /Blog/)
  })
})
