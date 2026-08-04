import { UserRole } from '../constants/userRole'

export type IRegisterBody = {
  name: string
  email: string
  password: string
  role: UserRole
}

export type ILoginBody = {
  email: string
  password: string
}

export type IUpdateUserBody = {
  passwordSetupToken?: string
  password?: string
  currentPassword?: string
  name?: string
  avatar?: string
}

export type IAuthUser = {
  id: string
  email: string
  name: string | null
  avatar: string | null
  role: UserRole
  provider: string
  hasPassword: boolean
  isVerified: boolean
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export type IAuthResult = {
  user: IAuthUser
  accessToken: string
  refreshToken: string
}

export type ILoginResult = {
  profile: IAuthUser
  accessToken: string
  refreshToken: string
}

export type IPasswordSetupRequiredData = {
  email: string
  providers: string[]
  hasPassword: false
}

export type IVerifyPasswordSetupBody = {
  token: string
}

export type IResendPasswordSetupBody = {
  email: string
}

export type IPasswordSetupVerifyResult = {
  email: string
  providers: string[]
}

export type IVerifyEmailBody = {
  otp: number
  email: string
}

export type IForgotPasswordBody = {
  email: string
}

export type IVerifyForgotPasswordBody = {
  token: string
}

export type IForgotPasswordVerifyResult = {
  email: string
}

export type IResetPasswordBody = {
  token: string
  password: string
}

export type IChangePasswordBody = {
  oldPassword: string
  password: string
}
