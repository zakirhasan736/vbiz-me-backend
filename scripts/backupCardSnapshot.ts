/**
 * Short restoreable backup of one public card: active tabs, section banners,
 * list/tab content, and media URLs (no binary downloads).
 *
 *   yarn backup:card --slug=michaelangelo-casanova-2
 *
 * Writes:
 *   backups/card-snapshots/<slug>-latest.json
 *   backups/card-snapshots/<slug>-<timestamp>.json
 * Also stores a CardChangeHistory row (area=cardSnapshot) for in-DB recovery.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { prisma } from '../src/utils/prisma'
import {
  CARD_SNAPSHOT_VERSION,
  SNAPSHOT_LIST_MODELS,
  stripRow,
  summarizeSnapshot,
  type CardSnapshot,
} from './backupCardSnapshot.helpers'

function parseArgs(argv: string[]) {
  const slugArg = argv.find((arg) => arg.startsWith('--slug='))
  return {
    slug: (slugArg?.slice('--slug='.length) || 'michaelangelo-casanova-2').trim(),
  }
}

type ListDelegate = {
  findMany: (args: { where: Record<string, unknown> }) => Promise<Array<Record<string, unknown>>>
}

async function main() {
  const { slug } = parseArgs(process.argv.slice(2))
  const profile = await prisma.profile.findFirst({
    where: { slug: { equals: slug, mode: 'insensitive' } },
    select: {
      id: true,
      slug: true,
      name: true,
      email: true,
      avatar: true,
      about: true,
      template: true,
      themeConfig: true,
      colorCode: true,
      profileSettings: {
        select: {
          profileTemplate: true,
          layoutStyle: true,
          buttonStyle: true,
          cornerStyle: true,
          themeConfig: true,
        },
      },
      aboutMe: true,
      customTabs: {
        include: {
          items: { orderBy: { sortOrder: 'asc' } },
        },
        orderBy: { sortOrder: 'asc' },
      },
      posts: {
        where: { deletedAt: null },
        include: { metas: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      },
      attachments: {
        include: { attachmentType: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      },
      settings: { select: { key: true, value: true } },
    },
  })

  if (!profile?.slug) {
    throw new Error(`No card found for slug ${slug}`)
  }

  const settings: Record<string, string> = {}
  for (const row of profile.settings) {
    if (row.value == null) continue
    settings[row.key] = row.value
  }

  const lists: CardSnapshot['lists'] = {}
  const client = prisma as unknown as Record<string, ListDelegate>
  for (const model of SNAPSHOT_LIST_MODELS) {
    const delegate = client[model]
    if (!delegate?.findMany) {
      lists[model] = []
      continue
    }
    try {
      const rows = await delegate.findMany({ where: { profileId: profile.id } })
      lists[model] = rows
        .filter((row) => !row.deletedAt)
        .map((row) => stripRow(row))
        .filter((row) => Object.keys(row).length > 0)
    } catch {
      lists[model] = []
    }
  }

  const aboutMe = profile.aboutMe ? stripRow(profile.aboutMe as unknown as Record<string, unknown>) : null

  const snapshot: CardSnapshot = {
    version: CARD_SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    slug: profile.slug,
    profileId: profile.id,
    name: profile.name,
    email: profile.email,
    settings,
    profile: {
      avatar: profile.avatar,
      about: profile.about,
      template: profile.template,
      themeConfig: profile.themeConfig,
      colorCode: profile.colorCode,
    },
    profileSettings: profile.profileSettings
      ? {
          profileTemplate: profile.profileSettings.profileTemplate,
          layoutStyle: profile.profileSettings.layoutStyle,
          buttonStyle: profile.profileSettings.buttonStyle,
          cornerStyle: profile.profileSettings.cornerStyle,
          themeConfig: profile.profileSettings.themeConfig,
        }
      : null,
    aboutMe,
    customTabs: profile.customTabs.map((tab) => ({
      key: tab.key,
      label: tab.label,
      slug: tab.slug,
      description: tab.description,
      icon: tab.icon,
      sortOrder: tab.sortOrder,
      isEnabled: tab.isEnabled,
      isPublic: tab.isPublic,
      status: tab.status,
      layoutType: tab.layoutType,
      settings: tab.settings,
      items: tab.items.map((item) => stripRow(item as unknown as Record<string, unknown>)),
    })),
    lists,
    posts: profile.posts.map((post) => ({
      postTypeId: post.postTypeId,
      title: post.title,
      description: post.description,
      status: post.status,
      url: post.url,
      featuredImage: post.featuredImage,
      sortOrder: post.sortOrder,
      metas: post.metas.map((meta) => ({ metaKey: meta.metaKey, metaValue: meta.metaValue })),
    })),
    attachments: profile.attachments.map((row) => ({
      url: row.url ?? null,
      publicId: row.publicId ?? null,
      typeName: row.attachmentType?.name ?? null,
    })),
    counts: {},
  }

  snapshot.counts = {
    settings: Object.keys(snapshot.settings).length,
    customTabs: snapshot.customTabs.length,
    posts: snapshot.posts.length,
    attachments: snapshot.attachments.length,
    ...Object.fromEntries(Object.entries(snapshot.lists).map(([key, rows]) => [key, rows.length])),
  }

  const dir = path.join(process.cwd(), 'backups', 'card-snapshots')
  await mkdir(dir, { recursive: true })
  const stamp = snapshot.createdAt.replace(/[:.]/g, '-')
  const latestPath = path.join(dir, `${profile.slug}-latest.json`)
  const stampedPath = path.join(dir, `${profile.slug}-${stamp}.json`)
  const body = `${JSON.stringify(snapshot, null, 2)}\n`
  await writeFile(latestPath, body, 'utf8')
  await writeFile(stampedPath, body, 'utf8')

  // In-DB copy — survives if the JSON file is lost (no expiry).
  await prisma.cardChangeHistory.create({
    data: {
      profileId: profile.id,
      area: 'cardSnapshot',
      areaLabel: 'Full card snapshot',
      action: 'backup',
      summary: `Backup of ${profile.slug} tabs/media/settings`,
      actorName: 'backup:card script',
      actorRoleLabel: 'script',
      snapshot: snapshot as object,
      snapshotExpiresAt: null,
      meta: summarizeSnapshot(snapshot) as object,
    },
  })

  console.log(
    JSON.stringify(
      {
        ok: true,
        files: { latest: latestPath, stamped: stampedPath },
        summary: summarizeSnapshot(snapshot),
      },
      null,
      2
    )
  )
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
