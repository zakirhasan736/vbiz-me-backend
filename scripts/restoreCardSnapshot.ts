/**
 * Restore a card from a short JSON snapshot created by backup:card.
 * Dry-run by default.
 *
 *   yarn restore:card --slug=michaelangelo-casanova-2
 *   yarn restore:card --slug=michaelangelo-casanova-2 --apply
 *   yarn restore:card --file=backups/card-snapshots/michaelangelo-casanova-2-latest.json --apply
 *   yarn restore:card --slug=michaelangelo-casanova-2 --apply --fanout
 *
 * --fanout re-pushes shared tab content to corporate linked cards after restore.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Prisma } from '../generated/prisma/client'
import { syncCorporateSiblingSharedContent } from '../src/utils/corporateSiblingSync'
import { cloneRecord } from '../src/utils/duplicateCard'
import { toGalleryWriteData } from '../src/utils/galleryMedia'
import { prisma } from '../src/utils/prisma'
import {
  CARD_SNAPSHOT_VERSION,
  SNAPSHOT_LIST_MODELS,
  summarizeSnapshot,
  type CardSnapshot,
} from './backupCardSnapshot.helpers'

function parseArgs(argv: string[]) {
  const slugArg = argv.find((arg) => arg.startsWith('--slug='))
  const fileArg = argv.find((arg) => arg.startsWith('--file='))
  return {
    apply: argv.includes('--apply'),
    fanout: argv.includes('--fanout'),
    slug: (slugArg?.slice('--slug='.length) || '').trim(),
    file: (fileArg?.slice('--file='.length) || '').trim(),
  }
}

type ListDelegate = {
  findMany: (args: { where: Record<string, unknown> }) => Promise<Array<Record<string, unknown>>>
  deleteMany: (args: { where: Record<string, unknown> }) => Promise<unknown>
  create: (args: { data: Record<string, unknown> }) => Promise<unknown>
}

function isCardSnapshot(value: unknown): value is CardSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as CardSnapshot
  return row.version === CARD_SNAPSHOT_VERSION && typeof row.slug === 'string' && Boolean(row.settings)
}

async function loadSnapshot(file: string, slug: string): Promise<CardSnapshot> {
  if (file) {
    const raw = await readFile(path.resolve(process.cwd(), file), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isCardSnapshot(parsed)) throw new Error(`Invalid snapshot file: ${file}`)
    return parsed
  }

  const resolvedSlug = slug || 'michaelangelo-casanova-2'
  const latest = path.join(process.cwd(), 'backups', 'card-snapshots', `${resolvedSlug}-latest.json`)
  try {
    const raw = await readFile(latest, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isCardSnapshot(parsed)) throw new Error(`Invalid snapshot file: ${latest}`)
    return parsed
  } catch {
    const history = await prisma.cardChangeHistory.findFirst({
      where: {
        area: 'cardSnapshot',
        profile: { slug: { equals: resolvedSlug, mode: 'insensitive' } },
      },
      orderBy: { createdAt: 'desc' },
      select: { snapshot: true },
    })
    if (!isCardSnapshot(history?.snapshot)) {
      throw new Error(`No snapshot file or history for slug ${resolvedSlug}`)
    }
    return history.snapshot
  }
}

async function replaceListModel(profileId: string, model: string, rows: Array<Record<string, unknown>>) {
  const client = prisma as unknown as Record<string, ListDelegate>
  const delegate = client[model]
  if (!delegate?.deleteMany || !delegate?.create) return { model, deleted: false, created: 0 }

  await delegate.deleteMany({ where: { profileId } })
  let created = 0
  for (const row of rows) {
    const cloned = cloneRecord(row)
    const payload = model === 'gallery' ? toGalleryWriteData(cloned) : cloned
    await delegate.create({ data: { ...payload, profileId } })
    created += 1
  }
  return { model, deleted: true, created }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const snapshot = await loadSnapshot(args.file, args.slug)
  const targetSlug = args.slug || snapshot.slug

  const profile = await prisma.profile.findFirst({
    where: { slug: { equals: targetSlug, mode: 'insensitive' } },
    select: { id: true, slug: true, name: true },
  })
  if (!profile?.slug) throw new Error(`No card found for slug ${targetSlug}`)

  const plan = {
    target: { id: profile.id, slug: profile.slug, name: profile.name },
    from: summarizeSnapshot(snapshot),
    apply: args.apply,
    fanout: args.fanout,
  }

  if (!args.apply) {
    console.log(JSON.stringify({ ...plan, note: 'Dry-run only. Re-run with --apply to write.' }, null, 2))
    return
  }

  const listResults = []
  for (const model of SNAPSHOT_LIST_MODELS) {
    listResults.push(await replaceListModel(profile.id, model, snapshot.lists[model] || []))
  }

  // About Me (unique per profile)
  if (snapshot.aboutMe) {
    const data = cloneRecord(snapshot.aboutMe)
    await prisma.aboutMe.upsert({
      where: { profileId: profile.id },
      create: {
        profileId: profile.id,
        title: typeof data.title === 'string' ? data.title : 'About Me',
        description: typeof data.description === 'string' ? data.description : null,
        featuredMediaUrl: typeof data.featuredMediaUrl === 'string' ? data.featuredMediaUrl : null,
        status: typeof data.status === 'string' ? data.status : '1',
      },
      update: {
        title: typeof data.title === 'string' ? data.title : 'About Me',
        description: typeof data.description === 'string' ? data.description : null,
        featuredMediaUrl: typeof data.featuredMediaUrl === 'string' ? data.featuredMediaUrl : null,
        status: typeof data.status === 'string' ? data.status : '1',
      },
    })
  }

  // Custom tabs + items
  await prisma.customTabItem.deleteMany({ where: { profileId: profile.id } })
  await prisma.customTab.deleteMany({ where: { profileId: profile.id } })
  for (const tab of snapshot.customTabs) {
    const created = await prisma.customTab.create({
      data: {
        profileId: profile.id,
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
        settings: tab.settings === null ? undefined : (tab.settings as Prisma.InputJsonValue),
      },
    })
    for (const item of tab.items) {
      const cloned = cloneRecord(item)
      await prisma.customTabItem.create({
        data: {
          ...cloned,
          customTabId: created.id,
          profileId: profile.id,
        },
      })
    }
  }

  // Legacy posts
  await prisma.post.deleteMany({ where: { profileId: profile.id } })
  for (const post of snapshot.posts) {
    const created = await prisma.post.create({
      data: {
        profileId: profile.id,
        postTypeId: post.postTypeId,
        title: post.title,
        description: post.description,
        status: post.status,
        url: post.url,
        featuredImage: post.featuredImage,
        sortOrder: post.sortOrder,
      },
    })
    for (const meta of post.metas) {
      await prisma.postMeta.create({
        data: { postId: created.id, metaKey: meta.metaKey, metaValue: meta.metaValue },
      })
    }
  }

  // Settings (active tabs / banners / media URLs)
  for (const [key, value] of Object.entries(snapshot.settings)) {
    await prisma.setting.upsert({
      where: { profileId_key: { profileId: profile.id, key } },
      create: { profileId: profile.id, key, value },
      update: { value },
    })
  }

  await prisma.profile.update({
    where: { id: profile.id },
    data: {
      avatar: snapshot.profile.avatar,
      about: snapshot.profile.about,
      template: snapshot.profile.template,
      colorCode: snapshot.profile.colorCode,
      themeConfig:
        snapshot.profile.themeConfig === null ? undefined : (snapshot.profile.themeConfig as Prisma.InputJsonValue),
    },
  })

  if (snapshot.profileSettings) {
    await prisma.profileSetting.upsert({
      where: { profileId: profile.id },
      create: {
        profileId: profile.id,
        profileTemplate: snapshot.profileSettings.profileTemplate || 'v3',
        layoutStyle: snapshot.profileSettings.layoutStyle,
        buttonStyle: snapshot.profileSettings.buttonStyle,
        cornerStyle: snapshot.profileSettings.cornerStyle,
        themeConfig:
          snapshot.profileSettings.themeConfig === null
            ? undefined
            : (snapshot.profileSettings.themeConfig as Prisma.InputJsonValue),
      },
      update: {
        profileTemplate: snapshot.profileSettings.profileTemplate || 'v3',
        layoutStyle: snapshot.profileSettings.layoutStyle,
        buttonStyle: snapshot.profileSettings.buttonStyle,
        cornerStyle: snapshot.profileSettings.cornerStyle,
        themeConfig:
          snapshot.profileSettings.themeConfig === null
            ? undefined
            : (snapshot.profileSettings.themeConfig as Prisma.InputJsonValue),
      },
    })
  }

  let fanout: { siblingCount: number } | null = null
  if (args.fanout) {
    fanout = await syncCorporateSiblingSharedContent(
      profile.id,
      { type: 'fullShared' },
      { allowEmpty: true, force: true }
    )
  }

  await prisma.cardChangeHistory.create({
    data: {
      profileId: profile.id,
      area: 'cardSnapshot',
      areaLabel: 'Full card snapshot',
      action: 'restore',
      summary: `Restored ${snapshot.slug} snapshot from ${snapshot.createdAt}`,
      actorName: 'restore:card script',
      actorRoleLabel: 'script',
      snapshot: snapshot as object,
      snapshotExpiresAt: null,
      meta: { fanout, from: summarizeSnapshot(snapshot) } as object,
      restoredAt: new Date(),
    },
  })

  console.log(
    JSON.stringify(
      {
        ok: true,
        ...plan,
        listResults: listResults.filter((row) => row.created > 0 || row.deleted),
        fanout,
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
