import { z } from 'zod'

const PASSWORD_NOT_SAME_AS_EMAIL = "Password can't be the same as email"

const SPECIAL_CHAR_REGEX = /[!@#$%^&*(),.?":{}|<>_\-+=[\]\\/]/

const strongPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(SPECIAL_CHAR_REGEX, 'Password must contain at least one special character')

const register = z
  .object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Valid email is required'),
    password: strongPassword,
    role: z.enum(['vcard-owner', 'corporate-owner'] as const, {
      errorMap: () => ({ message: 'Role must be vcard-owner or corporate-owner' }),
    }),
  })
  .refine((data) => data.password.trim().toLowerCase() !== data.email.trim().toLowerCase(), {
    message: PASSWORD_NOT_SAME_AS_EMAIL,
    path: ['password'],
  })

const login = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(1, 'Password is required'),
})

const update = z
  .object({
    passwordSetupToken: z.string().min(1).optional(),
    password: strongPassword.optional(),
    currentPassword: z.string().min(1).optional(),
    name: z.string().min(1, 'Name cannot be empty').optional(),
    avatar: z.string().url('Avatar must be a valid URL').optional(),
  })
  .refine((data) => Boolean(data.password || data.name !== undefined || data.avatar !== undefined), {
    message: 'At least one field to update is required (password, name, or avatar)',
  })

const sendVerificationEmail = z.object({
  email: z.string().email('Valid email is required'),
})

const verifyEmail = z.object({
  email: z.string().email('Valid email is required'),
  otp: z.coerce.number().int().min(100000).max(999999),
})

const forgotPassword = z.object({
  email: z.string().email('Valid email is required'),
})

const verifyForgotPassword = z.object({
  token: z.string().min(1, 'Token is required'),
})

const resetPassword = z.object({
  token: z.string().min(1, 'Token is required'),
  password: strongPassword,
})

const changePassword = z.object({
  oldPassword: z.string().min(1, 'Old password is required'),
  password: strongPassword,
})

const verifyPasswordSetup = z.object({
  token: z.string().min(1, 'Token is required'),
})

const resendPasswordSetup = z.object({
  email: z.string().email('Valid email is required'),
})

const AuthZodSchema = {
  register,
  login,
  update,
  sendVerificationEmail,
  verifyEmail,
  forgotPassword,
  verifyForgotPassword,
  resetPassword,
  changePassword,
  verifyPasswordSetup,
  resendPasswordSetup,
}

export default AuthZodSchema
