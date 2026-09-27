/**
 * Restore a card's About Me text/media from leftover sources:
 *   1. Card-change history snapshots (even if the 72h restore window passed, if JSON is still stored)
 *   2. Profile.about
 *   3. about_me_* settings
 *   4. Legacy "About Me" posts
 *
 * Dry-run by default.
 *
 *   yarn restore:card-about-me --slug=nick-grimard
 *   yarn restore:card-about-me --slug=nick-grimard --apply
 */
import { prisma } from '../src/utils/prisma'

const DEFAULT_SLUG = 'nick-grimard'

function parseArgs(argv: string[]) {
  const slugArg = argv.find((arg) => arg.startsWith('--slug='))
  return {
    apply: argv.includes('--apply'),
    slug: (slugArg?.slice('--slug='.length) || DEFAULT_SLUG).trim(),
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function aboutFromSnapshot(snapshot: unknown): {
  title: string
  description: string
  featuredMediaUrl: string
  status: string
} | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
  const row = snapshot as { kind?: unknown; aboutMe?: unknown }
  if (row.kind !== 'aboutMe' || !row.aboutMe || typeof row.aboutMe !== 'object') return null
  const about = row.aboutMe as Record<string, unknown>
  const description = textOf(about.description)
  const featuredMediaUrl = textOf(about.featuredMediaUrl)
  const title = textOf(about.title)
  if (!description && !featuredMediaUrl && !title) return null
  return {
    title: title || 'About Me',
    description,
    featuredMediaUrl,
    status: textOf(about.status) || '1',
  }
}

async function main() {
  const { apply, slug } = parseArgs(process.argv.slice(2))
  const profile = await prisma.profile.findFirst({
    where: { slug: { equals: slug, mode: 'insensitive' } },
    select: {
      id: true,
      slug: true,
      name: true,
      email: true,
      about: true,
      aboutMe: true,
      settings: {
        where: { key: { startsWith: 'about_me' } },
        select: { key: true, value: true },
      },
    },
  })

  if (!profile) {
    throw new Error(`No card found for slug ${slug}`)
  }

  const settings = Object.fromEntries(profile.settings.map((row) => [row.key, row.value || '']))
  const history = await prisma.cardChangeHistory.findMany({
    where: { profileId: profile.id, area: 'aboutMe' },
    select: { id: true, createdAt: true, snapshot: true, snapshotExpiresAt: true, summary: true },
    orderBy: { createdAt: 'desc' },
    take: 40,
  })

  const aboutPostType = await prisma.postType.findFirst({
    where: { OR: [{ legacyId: 16 }, { name: { equals: 'About Me', mode: 'insensitive' } }] },
    select: { id: true },
  })
  const aboutPosts = aboutPostType
    ? await prisma.post.findMany({
        where: { profileId: profile.id, postTypeId: aboutPostType.id, deletedAt: null },
        select: { title: true, description: true, featuredImage: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      })
    : []

  const candidates = [
    ...history
      .map((row) => {
        const about = aboutFromSnapshot(row.snapshot)
        return about ? { source: `history:${row.id}`, createdAt: row.createdAt, ...about } : null
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row)),
    aboutPosts[0]
      ? {
          source: 'about-me-post',
          createdAt: aboutPosts[0].createdAt,
          title: aboutPosts[0].title?.trim() || 'About Me',
          description: aboutPosts[0].description?.trim() || '',
          featuredMediaUrl: aboutPosts[0].featuredImage?.trim() || '',
          status: aboutPosts[0].status || '1',
        }
      : null,
    profile.about?.trim()
      ? {
          source: 'profile.about',
          createdAt: null,
          title: settings.about_me_title || 'About Me',
          description: profile.about.trim(),
          featuredMediaUrl: settings.about_me_featured_media_url || '',
          status: settings.about_me_status || '1',
        }
      : null,
    settings.about_me_title || settings.about_me_featured_media_url
      ? {
          source: 'settings',
          createdAt: null,
          title: settings.about_me_title || 'About Me',
          description: '',
          featuredMediaUrl: settings.about_me_featured_media_url || '',
          status: settings.about_me_status || '1',
        }
      : null,
  ].filter((row): row is NonNullable<typeof row> => Boolean(row))

  const current = profile.aboutMe
  const currentHasContent = Boolean(current?.description?.trim() || current?.featuredMediaUrl?.trim())
  const best = candidates.sort((a, b) => {
    const aScore = (a.description?.length || 0) * 2 + (a.featuredMediaUrl ? 50 : 0)
    const bScore = (b.description?.length || 0) * 2 + (b.featuredMediaUrl ? 50 : 0)
    return bScore - aScore
  })[0]

  const plan = {
    apply,
    card: { id: profile.id, slug: profile.slug, name: profile.name, email: profile.email },
    currentAboutMe: current
      ? {
          title: current.title,
          descriptionLength: current.description?.trim().length || 0,
          featuredMediaUrl: current.featuredMediaUrl,
        }
      : null,
    candidateCount: candidates.length,
    restoreFrom: best
      ? {
          source: best.source,
          title: best.title,
          descriptionLength: best.description.length,
          featuredMediaUrl: best.featuredMediaUrl,
          descriptionPreview: best.description.slice(0, 240),
        }
      : null,
    willWrite: Boolean(
      best && (!currentHasContent || best.description.length > (current?.description?.trim().length || 0))
    ),
  }

  if (apply && plan.willWrite && best) {
    await prisma.aboutMe.upsert({
      where: { profileId: profile.id },
      create: {
        profileId: profile.id,
        title: best.title || 'About Me',
        description: best.description || null,
        featuredMediaUrl: best.featuredMediaUrl || null,
        status: best.status || '1',
      },
      update: {
        title: best.title || 'About Me',
        description: best.description || null,
        featuredMediaUrl: best.featuredMediaUrl || null,
        status: best.status || '1',
      },
    })
    if (best.description) {
      await prisma.profile.update({ where: { id: profile.id }, data: { about: best.description } })
    }
    if (best.title) {
      await prisma.setting.upsert({
        where: { profileId_key: { profileId: profile.id, key: 'about_me_title' } },
        create: { profileId: profile.id, key: 'about_me_title', value: best.title },
        update: { value: best.title },
      })
    }
    if (best.featuredMediaUrl) {
      await prisma.setting.upsert({
        where: { profileId_key: { profileId: profile.id, key: 'about_me_featured_media_url' } },
        create: { profileId: profile.id, key: 'about_me_featured_media_url', value: best.featuredMediaUrl },
        update: { value: best.featuredMediaUrl },
      })
    }
  }

  console.log(JSON.stringify(plan, null, 2))
  if (!apply) {
    console.log('Dry-run only. Re-run with --apply to write About Me back.')
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
