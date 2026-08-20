import { z } from 'zod'

const PASSWORD_NOT_SAME_AS_EMAIL = "Password can't be the same as email"
const SPECIAL_CHAR_REGEX = /[!@#$%^&*(),.?":{}|<>_\-+=[\]\\/]/

const strongPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(SPECIAL_CHAR_REGEX, 'Password must contain at least one special character')

const ownerRole = z.enum(['vcard-owner', 'corporate-owner'] as const, {
  errorMap: () => ({ message: 'Role must be vcard-owner or corporate-owner' }),
})

const filterRole = z.enum(['vcard-owner', 'corporate-owner', 'admin', 'super-admin'] as const)

const accountStatus = z.enum(['ACTIVE', 'PAUSED', 'SUSPENDED'] as const)

const listAdminUsersQuery = z.object({
  q: z.string().trim().optional(),
  role: filterRole.optional(),
  accountStatus: accountStatus.optional(),
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(8),
})

const createAdminUser = z
  .object({
    name: z.string().trim().min(1, 'Name is required'),
    email: z.string().trim().email('Valid email is required'),
    password: strongPassword.optional(),
    packageId: z.string().trim().min(1, 'Package is required'),
    companyName: z.string().trim().max(200).optional().nullable(),
    cardLimit: z.number().int().min(0).max(100000).optional(),
    negotiatedMonthlyCents: z.number().int().min(0).nullable().optional(),
    negotiatedSignupFeeCents: z.number().int().min(0).nullable().optional(),
    featureOverrides: z
      .array(
        z.object({
          featureKey: z.string().trim().min(1).max(80),
          featureValue: z.string().trim().max(80).nullable(),
        })
      )
      .max(100)
      .optional(),
  })
  .refine((data) => !data.password || data.password.trim().toLowerCase() !== data.email.trim().toLowerCase(), {
    message: PASSWORD_NOT_SAME_AS_EMAIL,
    path: ['password'],
  })

const updateAdminUser = z
  .object({
    name: z.string().trim().min(1, 'Name cannot be empty').optional(),
    email: z.string().trim().email('Valid email is required').optional(),
    role: ownerRole.optional(),
    companyName: z.string().trim().max(200).optional().nullable(),
    password: strongPassword.optional(),
    cardLimit: z.number().int().min(0).max(100000).optional(),
    negotiatedMonthlyCents: z.number().int().min(0).nullable().optional(),
    negotiatedSignupFeeCents: z.number().int().min(0).nullable().optional(),
    featureOverrides: z
      .array(
        z.object({
          featureKey: z.string().trim().min(1).max(80),
          featureValue: z.string().trim().max(80).nullable(),
        })
      )
      .max(100)
      .optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.email !== undefined ||
      data.role !== undefined ||
      data.companyName !== undefined ||
      data.password !== undefined ||
      data.cardLimit !== undefined ||
      data.negotiatedMonthlyCents !== undefined ||
      data.negotiatedSignupFeeCents !== undefined ||
      data.featureOverrides !== undefined,
    {
      message: 'At least one field to update is required',
    }
  )
  .refine(
    (data) => {
      if (!data.password || !data.email) return true
      return data.password.trim().toLowerCase() !== data.email.trim().toLowerCase()
    },
    {
      message: PASSWORD_NOT_SAME_AS_EMAIL,
      path: ['password'],
    }
  )

const setAdminUserStatus = z.object({
  accountStatus,
})

const AdminUserZodSchema = {
  listAdminUsersQuery,
  createAdminUser,
  updateAdminUser,
  setAdminUserStatus,
}

export type ListAdminUsersQuery = z.infer<typeof listAdminUsersQuery>
export type CreateAdminUserBody = z.infer<typeof createAdminUser>
export type UpdateAdminUserBody = z.infer<typeof updateAdminUser>
export type SetAdminUserStatusBody = z.infer<typeof setAdminUserStatus>
export type AccountStatusValue = z.infer<typeof accountStatus>

export default AdminUserZodSchema
