import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import AdminLeadsZodSchema from '../zodValidation/adminLeads.zod'
import AdminProfileZodSchema from '../zodValidation/adminProfile.zod'
import ProfileZodSchema from '../zodValidation/profile.zod'

const here = dirname(fileURLToPath(import.meta.url))
const schema = readFileSync(join(here, '../../prisma/schema.prisma'), 'utf8')
const profileService = readFileSync(join(here, '../services/profile.service.ts'), 'utf8')
const publicCardService = readFileSync(join(here, '../services/publicCard.service.ts'), 'utf8')
const publicController = readFileSync(join(here, '../controller/public.controller.ts'), 'utf8')
const adminProfileService = readFileSync(join(here, '../services/adminProfile.service.ts'), 'utf8')
const announcementService = readFileSync(join(here, '../services/announcement.service.ts'), 'utf8')
const adminLeadsService = readFileSync(join(here, '../services/adminLeads.service.ts'), 'utf8')
const cardJobService = readFileSync(join(here, '../services/ai/cardJob.service.ts'), 'utf8')

describe('profile persistence safeguards', () => {
  it('accepts a bounded creation key and persists it under a unique constraint', () => {
    const parsed = ProfileZodSchema.createProfileBody.parse({ name: 'Card', creationKey: 'create-key-123' })
    assert.equal(parsed.creationKey, 'create-key-123')
    assert.throws(() => ProfileZodSchema.createProfileBody.parse({ name: 'Card', creationKey: 'short' }))
    assert.match(schema, /creationKey\s+String\?\s+@unique/)
    assert.match(profileService, /where: \{ creationKey, createdById: userId \}/)
  })

  it('completes settings entitlement checks before updating the parent profile', () => {
    const updateStart = profileService.indexOf('const update = async')
    const updateBody = profileService.slice(updateStart)
    const validation = updateBody.indexOf('Complete entitlement validation before changing the parent Profile')
    const parentWrite = updateBody.indexOf('await prisma.profile.update')
    assert.ok(validation >= 0)
    assert.ok(parentWrite > validation)
  })

  it('applies AI update jobs to their existing profile and keys create retries by job', () => {
    assert.match(cardJobService, /ready\.builderMode === 'update'/)
    assert.match(cardJobService, /profileService\.update\(String\(ready\.profileId\)/)
    assert.match(cardJobService, /creationKey: `ai-card-job:\$\{ready\.id\}`/)
  })

  it('keeps an admin card notice scoped to one card while delivering through owner and saver channels', () => {
    const parsed = ProfileZodSchema.createTeamNoticeBody.parse({
      text: 'Card update',
      type: 'info',
      audience: 'all',
      targetProfileId: 'profile_123',
      deliver: true,
    })
    assert.equal(parsed.deliver, true)
    assert.match(profileService, /input\.audience === 'savers' \|\| input\.deliver/)
    assert.match(profileService, /pushService\.notifyProfileUpdate\(targetProfileId/)
    assert.match(profileService, /source: 'card_notice', channel: 'inbox'/)
    assert.match(profileService, /\.\.\.new Set\(\[\.\.\.saverEmails, \.\.\.ownerEmails\]\)/)
  })

  it('links contact saves to a stable guest and privately notifies owners after a return cooldown', () => {
    assert.match(publicController, /req\.query\.visitor_id/)
    assert.match(publicCardService, /RETURNING_SAVED_GUEST_DELAY_MS = 3 \* 24 \* 60 \* 60 \* 1000/)
    assert.match(publicCardService, /meta: \{ path: \['guestId'\], equals: guestId \}/)
    assert.match(publicCardService, /eventType: 'save_contact_download'/)
    assert.match(publicCardService, /eventType: RETURNING_SAVED_GUEST_EVENT/)
    assert.match(publicCardService, /channel: 'inbox'/)
    assert.match(publicCardService, /targetEmails: ownerEmails/)
  })

  it('searches specific card owners across professional and linked account identities', () => {
    assert.match(adminProfileService, /\.split\(\/\\s\+\//)
    assert.match(adminProfileService, /profession: \{ name: \{ contains: token/)
    assert.match(adminProfileService, /companyUser:/)
    assert.match(adminProfileService, /createdBy:/)
    assert.match(announcementService, /profileIdFromMeta\(row\.meta\) === id/)
  })

  it('requires three-character admin searches and includes professional identity in lead matching', () => {
    assert.throws(() => AdminProfileZodSchema.listAdminProfilesQuery.parse({ q: 'ab' }))
    assert.throws(() => AdminLeadsZodSchema.listQuery.parse({ q: 'ab' }))
    assert.equal(AdminProfileZodSchema.listAdminProfilesQuery.parse({ q: 'abc' }).q, 'abc')
    assert.match(adminLeadsService, /designation: search/)
    assert.match(adminLeadsService, /profession: \{ name: search \}/)
    assert.match(adminLeadsService, /AND: tokens\.map/)
  })
})
