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

const AdminProfileZodSchema = {
  listAdminProfilesQuery,
  exportAdminProfilesQuery,
}

export type ListAdminProfilesQuery = z.infer<typeof listAdminProfilesQuery>
export type ExportAdminProfilesQuery = z.infer<typeof exportAdminProfilesQuery>
export type AdminProfileFiltersInput = z.infer<typeof adminProfileFilters>

export default AdminProfileZodSchema
