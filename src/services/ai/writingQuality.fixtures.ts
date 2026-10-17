/**
 * Deterministic before/after writing examples for quality regression tests.
 * Facts are illustrative fixtures — never copy into unrelated customer cards.
 */

export const REALTOR_BEFORE = {
  about:
    'Jane Doe is a realtor at Jane Realty. She helps clients buy and sell homes. Contact her today for your real estate needs.',
  service: {
    title: 'Buyer Representation',
    description: 'We provide buyer representation services.',
  },
}

export const REALTOR_AFTER = {
  about: `I help families buy and sell homes with clear guidance, local market insight, and a calm process from first showing through closing. My focus is matching you with the right neighborhood and negotiating confidently on your behalf — without pressure or guesswork.

Mission
Help every client make a confident real estate decision with clarity and care.

Why Choose Us
You get attentive communication, practical pricing guidance, and a steady advocate who puts your goals first.

CTA: Schedule a Buyer Consultation`,
  service: {
    title: '🏠 Buyer Representation',
    description:
      'I guide you through every step of buying a home — from neighborhood research and private showings to offer strategy and negotiations — so you move forward with confidence, clear next steps, and a process built around your timeline and budget.',
  },
}

export function scoreWritingUpgrade(input: { about: string; serviceDescription: string }): {
  firstPerson: boolean
  serviceWordCount: number
  serviceInRange: boolean
  aboutWordCount: number
} {
  const aboutWords = input.about.trim().split(/\s+/).filter(Boolean).length
  const serviceWords = input.serviceDescription.trim().split(/\s+/).filter(Boolean).length
  return {
    firstPerson: /\b(i|i'm|i’ve|i've|my)\b/i.test(input.about),
    serviceWordCount: serviceWords,
    serviceInRange: serviceWords >= 40 && serviceWords <= 75,
    aboutWordCount: aboutWords,
  }
}
