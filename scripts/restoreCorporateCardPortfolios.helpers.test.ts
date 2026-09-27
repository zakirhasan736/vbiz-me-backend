import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractPortfolioItemsFromSnapshot,
  isPortfolioGalleryAttachment,
  missingPortfolioItems,
} from './restoreCorporateCardPortfolios.helpers'

describe('extractPortfolioItemsFromSnapshot', () => {
  it('reads featuredImage and imageUrl from a portfolios snapshot', () => {
    const items = extractPortfolioItemsFromSnapshot({
      kind: 'collection',
      collectionKind: 'portfolios',
      items: [
        { title: 'Office', featuredImage: 'https://cdn.example.com/a.jpg' },
        { title: 'Show', imageUrl: 'https://cdn.example.com/b.jpg' },
      ],
    })
    assert.equal(items.length, 2)
    assert.equal(items[0]?.featuredImage, 'https://cdn.example.com/a.jpg')
    assert.equal(items[1]?.featuredImage, 'https://cdn.example.com/b.jpg')
  })
})

describe('isPortfolioGalleryAttachment', () => {
  it('keeps portfolio gallery files and skips profile portraits', () => {
    assert.equal(isPortfolioGalleryAttachment('Portfolio Gallery', 'Profile'), true)
    assert.equal(isPortfolioGalleryAttachment('Gallery', 'Gallery'), true)
    assert.equal(isPortfolioGalleryAttachment('Profile Picture', 'Profile'), false)
    assert.equal(isPortfolioGalleryAttachment('Intro vCard Video', 'Profile'), false)
  })
})

describe('missingPortfolioItems', () => {
  it('adds only URLs that are not already on the card', () => {
    const missing = missingPortfolioItems(
      ['https://cdn.example.com/keep.jpg?v=1'],
      [
        {
          title: '',
          description: '',
          url: '',
          featuredImage: 'https://cdn.example.com/keep.jpg',
          status: '1',
          source: 'history',
        },
        {
          title: 'Lost',
          description: '',
          url: '',
          featuredImage: 'https://cdn.example.com/lost.jpg',
          status: '1',
          source: 'attachment',
        },
      ]
    )
    assert.equal(missing.length, 1)
    assert.equal(missing[0]?.featuredImage, 'https://cdn.example.com/lost.jpg')
  })
})
