import AppError from '../error/AppError'
import { prisma } from '../utils/prisma'
import type { CardTemplateId, UpdateCardTemplateInput } from '../zodValidation/template.zod'

export type NormalizedTemplateId = CardTemplateId

const normalizeTemplateId = (raw: string | null | undefined): NormalizedTemplateId => {
  const value = (raw || 'v3').toLowerCase().trim()
  if (value === 'v1' || value === 'dynamic') return 'v1'
  if (value === 'v2' || value === 'classic') return 'v2'
  return 'v3'
}

type CardTemplateRow = {
  id: string
  name: string
  description: string
  status: string
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

function serializeTemplate(row: CardTemplateRow, uses = 0) {
  return {
    id: row.id as NormalizedTemplateId,
    name: row.name,
    description: row.description,
    status: row.status as 'active' | 'inactive',
    sortOrder: row.sortOrder,
    uses,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

const buildUsageCounts = async (): Promise<Record<NormalizedTemplateId, number>> => {
  const counts: Record<NormalizedTemplateId, number> = { v1: 0, v2: 0, v3: 0 }

  const settingsGroups = await prisma.profileSetting.groupBy({
    by: ['profileTemplate'],
    _count: { _all: true },
  })

  for (const group of settingsGroups) {
    const id = normalizeTemplateId(group.profileTemplate)
    counts[id] += group._count._all
  }

  const orphanProfiles = await prisma.profile.findMany({
    where: { profileSettings: null },
    select: { template: true },
  })

  for (const profile of orphanProfiles) {
    const id = normalizeTemplateId(profile.template)
    counts[id] += 1
  }

  return counts
}

const listAdmin = async () => {
  const [rows, uses] = await Promise.all([
    prisma.cardTemplate.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    buildUsageCounts(),
  ])

  return rows.map((row) => serializeTemplate(row, uses[normalizeTemplateId(row.id)] ?? 0))
}

const listActive = async () => {
  const rows = await prisma.cardTemplate.findMany({
    where: { status: 'active' },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  })
  return rows.map((row) => serializeTemplate(row))
}

const update = async (id: string, input: UpdateCardTemplateInput) => {
  const existing = await prisma.cardTemplate.findUnique({ where: { id } })
  if (!existing) throw new AppError(404, 'Template not found')

  const row = await prisma.cardTemplate.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  })

  const uses = await buildUsageCounts()
  return serializeTemplate(row, uses[normalizeTemplateId(row.id)] ?? 0)
}

const templateService = {
  listAdmin,
  listActive,
  update,
  normalizeTemplateId,
}

export default templateService
