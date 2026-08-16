/**
 * Idempotent backfill: Post rows → Blog / TabItem by PostType.legacyId.
 *
 * Usage:
 *   yarn tsx --env-file=.env scripts/backfill-direct-tabs-from-posts.ts
 */
import { LEGACY_POST_TYPE_TO_TAB, TAB_REGISTRY } from '../src/constants/tabRegistry'
import { prisma } from '../src/utils/prisma'

async function main() {
  const posts = await prisma.post.findMany({
    where: { deletedAt: null },
    include: { postType: true, metas: true },
    orderBy: [{ profileId: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  })

  let blogsUpserted = 0
  let tabItemsUpserted = 0
  let skipped = 0
  let unmapped = 0
  const unknownMetaKeys = new Set<string>()

  for (const post of posts) {
    const legacyTypeId = post.postType?.legacyId ?? post.postType?.typeId ?? null
    const tabKey =
      (legacyTypeId != null ? LEGACY_POST_TYPE_TO_TAB[legacyTypeId] : null) ||
      Object.values(TAB_REGISTRY).find(
        (t) =>
          t.publicSectionName.toLowerCase() === (post.postType?.name || '').toLowerCase() ||
          t.publicSectionName.toLowerCase() === (post.postType?.title || '').toLowerCase()
      )?.key

    if (!tabKey) {
      unmapped += 1
      console.warn(`UNMAPPED post ${post.id} type=${post.postType?.name || post.postTypeId}`)
      continue
    }

    const tab = TAB_REGISTRY[tabKey]
    if (!tab || tab.architecture !== 'direct') {
      skipped += 1
      continue
    }
    if (
      tab.storage === 'about_me' ||
      tab.storage === 'service' ||
      tab.storage === 'portfolio' ||
      tab.storage === 'review'
    ) {
      skipped += 1
      continue
    }

    const metas = Object.fromEntries(post.metas.map((m) => [m.metaKey, m.metaValue ?? '']))
    for (const key of Object.keys(metas)) {
      if (!['category', 'date', 'issuer', 'year'].includes(key)) unknownMetaKeys.add(`${tabKey}:${key}`)
    }

    const legacyPostId = post.legacyId ?? null

    if (tab.storage === 'blog') {
      const data = {
        profileId: post.profileId,
        title: post.title,
        description: post.description,
        category: metas.category || null,
        date: metas.date || null,
        url: post.url,
        featuredImage: post.featuredImage,
        status: post.status || '1',
        sortOrder: post.sortOrder,
        legacyPostId: legacyPostId ?? undefined,
      }
      if (legacyPostId != null) {
        await prisma.blog.upsert({
          where: { legacyPostId },
          create: { ...data, legacyPostId },
          update: data,
        })
      } else {
        const existing = await prisma.blog.findFirst({
          where: { profileId: post.profileId, title: post.title || undefined, deletedAt: null },
        })
        if (existing) {
          await prisma.blog.update({ where: { id: existing.id }, data })
        } else {
          await prisma.blog.create({ data })
        }
      }
      blogsUpserted += 1
      continue
    }

    if (tab.storage === 'tab_item') {
      const data = {
        profileId: post.profileId,
        tabKey,
        legacyPostTypeId: tab.legacyPostTypeId,
        title: post.title,
        description: post.description,
        url: post.url,
        featuredImage: post.featuredImage,
        status: post.status || '1',
        sortOrder: post.sortOrder,
        metas,
        legacyPostId: legacyPostId ?? undefined,
      }
      if (legacyPostId != null) {
        await prisma.tabItem.upsert({
          where: { legacyPostId },
          create: { ...data, legacyPostId },
          update: data,
        })
      } else {
        const existing = await prisma.tabItem.findFirst({
          where: {
            profileId: post.profileId,
            tabKey,
            title: post.title || undefined,
            deletedAt: null,
          },
        })
        if (existing) {
          await prisma.tabItem.update({ where: { id: existing.id }, data })
        } else {
          await prisma.tabItem.create({ data })
        }
      }
      tabItemsUpserted += 1
    }
  }

  console.log(
    JSON.stringify(
      {
        blogsUpserted,
        tabItemsUpserted,
        skipped,
        unmapped,
        unknownMetaKeys: Array.from(unknownMetaKeys).sort(),
      },
      null,
      2
    )
  )
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
