import logger from '../utils/logger'
import { prisma } from '../utils/prisma'

const DEFAULT_TEMPLATES = [
  {
    id: 'v3',
    name: 'Ocean Profile',
    description: 'Redesign home hero, notepad, and floating navigation (public default).',
    status: 'active',
    sortOrder: 0,
  },
  {
    id: 'v2',
    name: 'Link in Bio',
    description: 'Bento dashboard home, cover video, and categorized floating navigation.',
    status: 'active',
    sortOrder: 1,
  },
  {
    id: 'v1',
    name: 'Classic Profile',
    description: 'Geometric grid background, typewriter home, and compact icon dock navigation.',
    status: 'active',
    sortOrder: 2,
  },
] as const

/**
 * Idempotent startup seed: ensures the three fixed vCard shells exist.
 * Does not overwrite name/description/status if an admin already edited them.
 */
const seedCardTemplates = async (): Promise<void> => {
  for (const tpl of DEFAULT_TEMPLATES) {
    await prisma.cardTemplate.upsert({
      where: { id: tpl.id },
      create: { ...tpl },
      update: {},
    })
  }
  logger.info('Card template seed ensured (v1, v2, v3)')
}

export default seedCardTemplates
