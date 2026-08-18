import { z } from 'zod'

const boolFromQuery = z.preprocess((val) => {
  if (val === true || val === 'true' || val === '1') return true
  if (val === false || val === 'false' || val === '0' || val === undefined || val === '') return false
  return val
}, z.boolean())

const adminProfileFilters = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.string().trim().max(100).optional(),
  profession: z.string().trim().max(100).optional(),
  lifecycle: z.enum(['active', 'draft']).optional(),
})

const listAdminProfilesQuery = adminProfileFilters.extend({
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  showAll: boolFromQuery.default(false),
  sortBy: z.enum(['updatedAt', 'createdAt', 'name', 'viewCount', 'companyName']).default('updatedAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
})

const exportAdminProfilesQuery = adminProfileFilters.extend({
  sortBy: z.enum(['updatedAt', 'createdAt', 'name', 'viewCount', 'companyName']).default('updatedAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
})

const sendProfileEmail = z.object({
  subject: z.string().trim().min(1, 'Subject is required').max(200),
  message: z.string().trim().min(1, 'Message is required').max(10_000),
})

const AdminProfileZodSchema = {
  listAdminProfilesQuery,
  exportAdminProfilesQuery,
  sendProfileEmail,
}

export type ListAdminProfilesQuery = z.infer<typeof listAdminProfilesQuery>
export type ExportAdminProfilesQuery = z.infer<typeof exportAdminProfilesQuery>
export type AdminProfileFiltersInput = z.infer<typeof adminProfileFilters>
export type SendProfileEmailInput = z.infer<typeof sendProfileEmail>

export default AdminProfileZodSchema
