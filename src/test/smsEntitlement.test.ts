import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  SMS_MONTHLY_LIMIT_BY_SLUG,
  SMS_MONTHLY_LIMIT_FEATURE_KEY,
  parseSmsMonthlyLimitFeature,
  smsMonthlyLimitForPackageSlug,
} from '../constants/smsEntitlement'
import { returningGuestDayKey } from '../utils/returningSavedGuest'
import { getTwilio10DlcStatus } from '../utils/twilio10dlc'

const here = dirname(fileURLToPath(import.meta.url))
const smsService = readFileSync(join(here, '../services/sms.service.ts'), 'utf8')
const meetingService = readFileSync(join(here, '../services/meeting.service.ts'), 'utf8')
const crmReminder = readFileSync(join(here, '../services/crmReminder.service.ts'), 'utf8')
const publicCard = readFileSync(join(here, '../services/publicCard.service.ts'), 'utf8')
const seedPackages = readFileSync(join(here, '../bootstrap/seedPackages.ts'), 'utf8')

describe('SMS entitlements by package', () => {
  it('gives Free no SMS and paid tiers the agreed monthly caps', () => {
    assert.equal(SMS_MONTHLY_LIMIT_FEATURE_KEY, 'sms_monthly_limit')
    assert.equal(smsMonthlyLimitForPackageSlug('free'), 0)
    assert.equal(smsMonthlyLimitForPackageSlug('professional'), 200)
    assert.equal(smsMonthlyLimitForPackageSlug('professional-concierge'), 1000)
    assert.equal(smsMonthlyLimitForPackageSlug('corporate'), 1000)
    assert.equal(SMS_MONTHLY_LIMIT_BY_SLUG.professional, 200)
  })

  it('parses package feature values including unlimited', () => {
    assert.equal(parseSmsMonthlyLimitFeature('200'), 200)
    assert.equal(parseSmsMonthlyLimitFeature('0'), 0)
    assert.equal(parseSmsMonthlyLimitFeature('unlimited'), Number.POSITIVE_INFINITY)
    assert.equal(parseSmsMonthlyLimitFeature(''), null)
  })

  it('seeds sms_monthly_limit and gates owner SMS through quota', () => {
    assert.match(seedPackages, /sms_monthly_limit/)
    assert.match(seedPackages, /professional: '200'/)
    assert.match(smsService, /evaluateOwnerSmsQuota/)
    assert.match(smsService, /notifyOwnerScheduleAlert/)
  })
})

describe('Owner text-alert moments', () => {
  it('texts owners for back-office schedules without admin fan-out', () => {
    assert.match(meetingService, /notifyOwnerScheduleAlert/)
    assert.match(meetingService, /actorIsResponsibleOwner/)
    assert.doesNotMatch(meetingService, /Meeting admin email failed/)
  })

  it('keeps schedule guest SMS guest-only (never owner fallback / admin sender)', () => {
    assert.match(smsService, /notifyGuestScheduleSms/)
    assert.match(smsService, /Never falls back to the card-owner phone/)
    assert.doesNotMatch(smsService, /notifyScheduleSender/)
  })

  it('texts owners for wishes with a view link (no MMS)', () => {
    assert.match(crmReminder, /smsTopic:\s*'Wish'/)
    assert.match(crmReminder, /smsLinkUrl:\s*wishAbsoluteUrl/)
    assert.match(crmReminder, /leadWishLink/)
  })

  it('dedupes returning viewers to one owner alert per Eastern day', () => {
    assert.match(publicCard, /returningGuestDayKey/)
    assert.match(publicCard, /dayKey/)
    const day = returningGuestDayKey(new Date('2026-10-20T18:00:00.000Z'), 'America/New_York')
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('10DLC registration surface', () => {
  it('exposes Messaging Service / Brand / Campaign readiness without auto-filing', () => {
    const status = getTwilio10DlcStatus()
    assert.equal(typeof status.readyForUsTraffic, 'boolean')
    assert.ok(Array.isArray(status.notes))
    assert.ok(status.notes.length >= 1)
  })
})
