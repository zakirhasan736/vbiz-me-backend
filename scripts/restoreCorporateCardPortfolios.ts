/**
 * Restore missing Photos-as-Portfolio / gallery images after corporate sibling sync
 * replaced linked-card galleries.
 *
 * Sources:
 *   1. Card-change history snapshots (portfolios / gallery)
 *   2. That card's own Portfolio Gallery attachments (S3 URLs still in Attachment rows)
 *   3. Legacy Portfolio.imageUrl rows that are no longer in Gallery
 *
 * Adds missing items only — never deletes current gallery rows.
 * Dry-run by default.
 *
 *   yarn restore:corporate-portfolios --email=mcasanova@vbizme.com
 *   yarn restore:corporate-portfolios --email=mcasanova@vbizme.com --apply
 */
import { prisma } from '../src/utils/prisma'
import s3Utils from '../src/utils/s3'
import {
  extractPortfolioItemsFromSnapshot,
  isPortfolioGalleryAttachment,
  itemFromMediaUrl,
  keyFromPublicUrl,
  missingPortfolioItems,
  type RecoveredPortfolioItem,
} from './restoreCorporateCardPortfolios.helpers'

const DEFAULT_EMAIL = 'mcasanova@vbizme.com'
const EXTRA_SLUGS = ['michaelangelo-casanova-2', 'michaelanglo-casanova', 'julia-rose', 'mila', 'gefft-excited']

function parseArgs(argv: string[]) {
  const emailArg = argv.find((arg) => arg.startsWith('--email='))
  return {
    apply: argv.includes('--apply'),
    email: (emailArg?.slice('--email='.length) || DEFAULT_EMAIL).trim().toLowerCase(),
  }
}

async function s3Exists(url: string, publicId?: string | null): Promise<boolean | null> {
  const key = publicId?.trim() || keyFromPublicUrl(url)
  if (!key) return null
  try {
    return await s3Utils.headObject(key)
  } catch {
    return null
  }
}

async function main() {
  const { apply, email } = parseArgs(process.argv.slice(2))

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, name: true, email: true },
  })

  const cards = await prisma.profile.findMany({
    where: {
      OR: [
        { slug: { in: EXTRA_SLUGS, mode: 'insensitive' } },
        { email: { equals: email, mode: 'insensitive' } },
        ...(user ? [{ userId: user.id }, { companyUserId: user.id }] : []),
      ],
    },
    select: {
      id: true,
      slug: true,
      name: true,
      galleries: {
        where: { deletedAt: null },
        select: { featuredImage: true, title: true, sortOrder: true },
        orderBy: { sortOrder: 'asc' },
      },
      portfolios: {
        select: { imageUrl: true, title: true, description: true, url: true, status: true },
        orderBy: { sortOrder: 'asc' },
      },
      attachments: {
        include: { attachmentType: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { slug: 'asc' },
  })

  const unique = [...new Map(cards.map((card) => [card.id, card])).values()]
  const plans = []

  for (const card of unique) {
    const currentUrls = [
      ...card.galleries.map((row) => row.featuredImage),
      ...card.portfolios.map((row) => row.imageUrl),
    ]
    const history = await prisma.cardChangeHistory.findMany({
      where: { profileId: card.id },
      select: { snapshot: true },
      orderBy: { createdAt: 'desc' },
      take: 80,
    })
    const candidates: RecoveredPortfolioItem[] = []
    for (const row of history) {
      candidates.push(...extractPortfolioItemsFromSnapshot(row.snapshot))
    }
    for (const att of card.attachments) {
      if (!isPortfolioGalleryAttachment(att.attachmentType?.name, att.attachableType)) continue
      const item = itemFromMediaUrl(att.url || '', { title: att.docName || '' }, 'attachment')
      if (item) candidates.push(item)
    }
    for (const row of card.portfolios) {
      const item = itemFromMediaUrl(
        row.imageUrl || '',
        {
          title: row.title || '',
          description: row.description || '',
          url: row.url || '',
          status: String(row.status ?? 1),
        },
        'legacy-row'
      )
      if (item) candidates.push(item)
    }

    const toAdd = missingPortfolioItems(currentUrls, candidates)
    const withS3 = []
    for (const item of toAdd) {
      const exists = await s3Exists(item.featuredImage)
      withS3.push({ ...item, s3Exists: exists })
    }

    const writable = withS3.filter((item) => item.s3Exists !== false)
    plans.push({
      slug: card.slug,
      name: card.name,
      currentGalleryCount: card.galleries.length,
      currentImageCount: currentUrls.filter((url) => Boolean(url?.trim())).length,
      missingCount: withS3.length,
      willWriteCount: apply ? writable.length : 0,
      missing: withS3,
    })

    if (!apply || !writable.length) continue

    const maxSort = card.galleries.reduce((max, row) => Math.max(max, row.sortOrder || 0), -1)
    for (let index = 0; index < writable.length; index += 1) {
      const item = writable[index]
      const sortOrder = maxSort + 1 + index
      await prisma.gallery.create({
        data: {
          profileId: card.id,
          title: item.title || null,
          description: item.description || null,
          url: item.url || null,
          featuredImage: item.featuredImage,
          attachmentUrl: null,
          attachmentName: null,
          status: item.status || '1',
          sortOrder,
        },
      })
      await prisma.portfolio.create({
        data: {
          profileId: card.id,
          title: item.title || null,
          description: item.description || null,
          url: item.url || null,
          imageUrl: item.featuredImage,
          attachmentUrl: null,
          attachmentName: null,
          status: Number(item.status) || 1,
          sortOrder,
        },
      })
    }
  }

  console.log(
    JSON.stringify(
      {
        apply,
        corporateUser: user,
        restoreCount: plans.reduce((sum, row) => sum + row.missingCount, 0),
        cards: plans,
      },
      null,
      2
    )
  )
  if (!apply) {
    console.log('Dry-run only. Re-run with --apply to add missing portfolio photos back onto each card.')
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
