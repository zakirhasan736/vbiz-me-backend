import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bodyFromPastedText, plainTextToRichHtml, preferFullPastedBodies } from '../services/ai/preferFullPastedBodies'
import { buildTabFillSystemPrompt, parseTabFillBodyMode } from '../services/assistantPolicy'

describe('preferFullPastedBodies', () => {
  it('keeps every paragraph when the model returns a short blog summary', () => {
    const pasted = `Selling Your Home Is About Strategy, Not Just Putting It on the Market
Selling a home successfully requires more than taking a few pictures, choosing a price, and waiting for offers.

Pricing is one of the most important decisions a seller makes.

My role is to help sellers understand the full picture.`
    const payload = preferFullPastedBodies('blogs', pasted, {
      blogs: [
        {
          title: 'Selling Your Home Is About Strategy, Not Just Putting It on the Market',
          description:
            'Selling a home successfully requires thoughtful pricing, strong presentation, and careful evaluation of offer terms.',
          category: 'News',
        },
      ],
    })
    const description = String((payload.blogs as Array<{ description: string }>)[0]?.description || '')
    assert.match(description, /more than taking a few pictures/)
    assert.match(description, /Pricing is one of the most important/)
    assert.match(description, /My role is to help sellers/)
    assert.match(description, /<p>/)
  })

  it('wraps plain service descriptions as HTML paragraphs', () => {
    const payload = preferFullPastedBodies('services', '', {
      services: [{ title: 'Staging', description: 'First paragraph.\n\nSecond paragraph.', type: 'Other' }],
    })
    assert.equal(
      (payload.services as Array<{ description: string }>)[0]?.description,
      '<p>First paragraph.</p><p>Second paragraph.</p>'
    )
  })

  it('drops the title line from the pasted body', () => {
    assert.equal(
      bodyFromPastedText('Hello World\nBody line one\nBody line two', 'Hello World'),
      'Body line one\nBody line two'
    )
  })

  it('builds rich HTML from plain paragraphs', () => {
    assert.equal(plainTextToRichHtml('A\n\nB'), '<p>A</p><p>B</p>')
  })

  it('puts a pasted quote in the review and the later name on the reviewer', () => {
    const quote =
      'I had no idea how much stress I was carrying until I finally started getting a clearer picture of my business finances. Gigi has a way of making complicated things feel manageable.'
    const payload = preferFullPastedBodies('reviews', `${quote}\n— Michelle R.`, {
      reviews: [{ author: quote, text: '— Michelle R.', rating: 5 }],
    })
    const row = (payload.reviews as Array<{ author: string; text: string }>)[0]
    assert.equal(row?.author, 'Michelle R.')
    assert.match(String(row?.text), /no idea how much stress/)
    assert.doesNotMatch(String(row?.text), /Michelle R/)
  })

  it('keeps a review that is already name then quote', () => {
    const quote =
      'I had no idea how much stress I was carrying until I finally started getting a clearer picture of my business finances.'
    const payload = preferFullPastedBodies('reviews', '', {
      reviews: [{ author: 'Michelle R.', text: quote, rating: 5 }],
    })
    const row = (payload.reviews as Array<{ author: string; text: string }>)[0]
    assert.equal(row?.author, 'Michelle R.')
    assert.match(String(row?.text), /no idea how much stress/)
  })

  it('puts a short service name in the title when the write-up was pasted first', () => {
    const writeup =
      'Create a professional interactive card that brings contact information, services, videos, and booking together in one place for every client meeting.'
    const payload = preferFullPastedBodies('services', '', {
      services: [{ title: writeup, description: 'Digital Business Card Design', type: 'Other' }],
    })
    const row = (payload.services as Array<{ title: string; description: string }>)[0]
    assert.equal(row?.title, 'Digital Business Card Design')
    assert.match(String(row?.description), /interactive card/)
  })

  it('puts the question in the question field when the answer was pasted first', () => {
    const answer =
      'Yes, the card is fully editable and you can update it anytime through your account without reprinting anything for your team.'
    const payload = preferFullPastedBodies('faqs', '', {
      faqs: [{ question: answer, answer: 'Can I update my vCard anytime?' }],
    })
    const row = (payload.faqs as Array<{ question: string; answer: string }>)[0]
    assert.equal(row?.question, 'Can I update my vCard anytime?')
    assert.match(String(row?.answer), /fully editable/)
  })
})

describe('buildTabFillSystemPrompt full-body rules', () => {
  it('defaults body mode to as_written and keeps the complete article body', () => {
    assert.equal(parseTabFillBodyMode(undefined), 'as_written')
    assert.equal(parseTabFillBodyMode('summarize'), 'summarize')
    const prompt = buildTabFillSystemPrompt('blogs')
    assert.match(prompt, /COMPLETE article body/)
    assert.match(prompt, /Body mode: as_written/)
    assert.doesNotMatch(prompt, /Keep real titles and summaries/)
  })

  it('tells services and faqs fill to keep full wording', () => {
    assert.match(buildTabFillSystemPrompt('services'), /COMPLETE service write-up/)
    assert.match(buildTabFillSystemPrompt('faqs'), /COMPLETE answer/)
    assert.match(buildTabFillSystemPrompt('reviews'), /COMPLETE quote/)
  })

  it('summarize mode asks for a polished short blog body', () => {
    const prompt = buildTabFillSystemPrompt('blogs', 'summarize')
    assert.match(prompt, /Body mode: summarize/)
    assert.match(prompt, /polished HTML summary/)
    assert.doesNotMatch(prompt, /COMPLETE article body/)
  })
})
