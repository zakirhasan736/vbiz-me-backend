import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import AdminUserZodSchema from '../zodValidation/adminUser.zod'

const validAccount = {
  name: 'Corporate Owner',
  email: 'owner@example.com',
  password: 'Strong!2',
  packageId: 'corporate-package',
  companyName: 'Example Ltd',
}

describe('admin user provisioning credentials', () => {
  it('requires any supplied password to be strong', () => {
    const weak = AdminUserZodSchema.createAdminUser.safeParse({
      ...validAccount,
      password: 'password',
    })

    assert.equal(weak.success, false)
  })

  it('accepts the complete one-step provisioning payload', () => {
    const result = AdminUserZodSchema.createAdminUser.safeParse(validAccount)
    assert.equal(result.success, true)
  })

  it('does not allow the password to equal the email address', () => {
    const emailAndPassword = 'Owner1!@example.com'
    const result = AdminUserZodSchema.createAdminUser.safeParse({
      ...validAccount,
      email: emailAndPassword,
      password: emailAndPassword,
    })

    assert.equal(result.success, false)
  })

  it('preserves invitation-based provisioning when no password is supplied', () => {
    const result = AdminUserZodSchema.createAdminUser.safeParse({
      ...validAccount,
      password: undefined,
    })

    assert.equal(result.success, true)
  })
})
