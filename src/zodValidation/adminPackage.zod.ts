import { z } from 'zod'

const packageFeature = z.object({
  featureKey: z.string().trim().min(1).max(120),
  featureValue: z.string().trim().max(500).optional().nullable(),
})

const createAdminPackage = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase kebab-case')
    .optional()
    .nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  monthlyPrice: z.coerce.number().int().min(0).default(0),
  yearlyPrice: z.coerce.number().int().min(0).default(0),
  signupFeeCents: z.coerce.number().int().min(0).default(0),
  isActive: z.boolean().optional().default(true),
  sortOrder: z.coerce.number().int().min(0).optional().default(0),
  features: z.array(packageFeature).optional().default([]),
})

const updateAdminPackage = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase kebab-case')
      .optional()
      .nullable(),
    description: z.string().trim().max(2000).optional().nullable(),
    monthlyPrice: z.coerce.number().int().min(0).optional(),
    yearlyPrice: z.coerce.number().int().min(0).optional(),
    signupFeeCents: z.coerce.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).optional(),
    features: z.array(packageFeature).optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.slug !== undefined ||
      data.description !== undefined ||
      data.monthlyPrice !== undefined ||
      data.yearlyPrice !== undefined ||
      data.signupFeeCents !== undefined ||
      data.isActive !== undefined ||
      data.sortOrder !== undefined ||
      data.features !== undefined,
    { message: 'At least one field to update is required' }
  )

const AdminPackageZodSchema = {
  createAdminPackage,
  updateAdminPackage,
}

export type CreateAdminPackageBody = z.infer<typeof createAdminPackage>
export type UpdateAdminPackageBody = z.infer<typeof updateAdminPackage>
export type PackageFeatureInput = z.infer<typeof packageFeature>

export default AdminPackageZodSchema
