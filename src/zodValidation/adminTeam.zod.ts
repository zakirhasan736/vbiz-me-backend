import { z } from 'zod'
import { GRANTABLE_ADMIN_MODULES } from '../constants/userRole'

const PASSWORD_NOT_SAME_AS_EMAIL = "Password can't be the same as email"
const SPECIAL_CHAR_REGEX = /[!@#$%^&*(),.?":{}|<>_\-+=[\]\\/]/

const strongPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(SPECIAL_CHAR_REGEX, 'Password must contain at least one special character')

const staffRolePreset = z.enum(['Co-Administrator', 'Moderator', 'Compliance Auditor', 'Support Agent'] as const)

const grantableModule = z.enum(GRANTABLE_ADMIN_MODULES)

const createAdminTeamMember = z
  .object({
    name: z.string().trim().min(1, 'Name is required'),
    email: z.string().trim().email('Valid email is required'),
    password: strongPassword,
    staffRole: staffRolePreset,
    allowedModules: z.array(grantableModule).min(1, 'Select at least one module'),
  })
  .refine((data) => data.password.trim().toLowerCase() !== data.email.trim().toLowerCase(), {
    message: PASSWORD_NOT_SAME_AS_EMAIL,
    path: ['password'],
  })

const updateAdminTeamMember = z
  .object({
    name: z.string().trim().min(1).optional(),
    staffRole: staffRolePreset.optional(),
    allowedModules: z.array(grantableModule).min(1).optional(),
  })
  .refine((data) => data.name !== undefined || data.staffRole !== undefined || data.allowedModules !== undefined, {
    message: 'At least one field to update is required',
  })

const setAdminTeamStatus = z.object({
  isActive: z.boolean(),
})

const AdminTeamZodSchema = {
  createAdminTeamMember,
  updateAdminTeamMember,
  setAdminTeamStatus,
}

export type CreateAdminTeamMemberBody = z.infer<typeof createAdminTeamMember>
export type UpdateAdminTeamMemberBody = z.infer<typeof updateAdminTeamMember>
export type SetAdminTeamStatusBody = z.infer<typeof setAdminTeamStatus>

export default AdminTeamZodSchema
