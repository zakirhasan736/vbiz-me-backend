import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import ProfileZodSchema from '../zodValidation/profile.zod'

const here = dirname(fileURLToPath(import.meta.url))
const schema = readFileSync(join(here, '../../prisma/schema.prisma'), 'utf8')
const profileService = readFileSync(join(here, '../services/profile.service.ts'), 'utf8')
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
})
