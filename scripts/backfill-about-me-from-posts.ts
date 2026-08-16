/**
 * Backfill AboutMe rows from:
 * 1) Posts with PostType legacyId=16 / name "About Me" (latest non-deleted per profile)
 * 2) Laravel dump `posts.content` when Post.description is empty (import bug)
 * 3) Profile.about when no About Me post exists
 *
 * Usage:
 *   yarn tsx --env-file=.env scripts/backfill-about-me-from-posts.ts
 *   LARAVEL_SQL_DUMP=C:/path/to/vbizme_app_live_latest.sql yarn tsx --env-file=.env scripts/backfill-about-me-from-posts.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { prisma } from '../src/utils/prisma'

const DEFAULT_TITLE = 'About Me'
const ABOUT_POST_TYPE_LEGACY_ID = 16

function parseTuples(valuesSql: string): string[] {
  const tuples: string[] = []
  let i = 0
  while (i < valuesSql.length) {
    if (valuesSql[i] !== '(') {
      i += 1
      continue
    }
    let depth = 0
    const start = i
    let inStr = false
    let esc = false
    for (; i < valuesSql.length; i += 1) {
      const c = valuesSql[i]
      if (esc) {
        esc = false
        continue
      }
      if (inStr && c === '\\') {
        esc = true
        continue
      }
      if (c === "'") {
        inStr = !inStr
        continue
      }
      if (inStr) continue
      if (c === '(') depth += 1
      if (c === ')') {
        depth -= 1
        if (depth === 0) {
          tuples.push(valuesSql.slice(start + 1, i))
          i += 1
          break
        }
      }
    }
  }
  return tuples
}

function splitFields(tuple: string): string[] {
  const fields: string[] = []
  let cur = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < tuple.length; i += 1) {
    const c = tuple[i]
    if (esc) {
      cur += c
      esc = false
      continue
    }
    if (inStr && c === '\\') {
      cur += c
      esc = true
      continue
    }
    if (c === "'") {
      inStr = !inStr
      cur += c
      continue
    }
    if (!inStr && c === ',') {
      fields.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  fields.push(cur.trim())
  return fields
}

function unquoteSql(value: string): string | null {
  if (!value || value === 'NULL') return null
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
  }
  return value
}

/** Map Laravel post id -> content from dump (posts.content column). */
function loadDumpPostContent(dumpPath: string): Map<number, string> {
  const map = new Map<number, string>()
  if (!fs.existsSync(dumpPath)) {
    console.warn(`Laravel dump not found at ${dumpPath}; skipping content repair from dump`)
    return map
  }
  console.log(`Parsing dump for post content: ${dumpPath}`)
  const content = fs.readFileSync(dumpPath, 'utf8')
  const insert = content.match(/INSERT INTO `posts` VALUES ([\s\S]*?);\n/)
  if (!insert) {
    console.warn('No INSERT INTO `posts` found in dump')
    return map
  }
  for (const tuple of parseTuples(insert[1])) {
    const f = splitFields(tuple)
    // id,title,slug,excerpt,content,order,date,status,post_type_id,...
    if (f[8] !== String(ABOUT_POST_TYPE_LEGACY_ID)) continue
    const id = Number(f[0])
    const body = unquoteSql(f[4])
    if (Number.isFinite(id) && body && body.trim()) {
      map.set(id, body)
    }
  }
  console.log(`Dump content rows for About Me posts: ${map.size}`)
  return map
}

function resolveDumpPath(): string {
  if (process.env.LARAVEL_SQL_DUMP?.trim()) return process.env.LARAVEL_SQL_DUMP.trim()
  const candidates = [
    path.resolve('C:/Users/Rifajul/Desktop/vbizme_app_live_latest.sql'),
    path.resolve(process.cwd(), '../vbizme_app_live_latest.sql'),
    path.resolve(process.cwd(), 'vbizme_app_live_latest.sql'),
  ]
  return candidates.find((p) => fs.existsSync(p)) || candidates[0]
}

async function main() {
  const dumpContent = loadDumpPostContent(resolveDumpPath())

  let aboutType = await prisma.postType.findFirst({
    where: {
      OR: [{ legacyId: ABOUT_POST_TYPE_LEGACY_ID }, { name: { equals: 'About Me', mode: 'insensitive' } }],
    },
  })
  if (!aboutType) {
    aboutType = await prisma.postType.create({
      data: {
        legacyId: ABOUT_POST_TYPE_LEGACY_ID,
        name: 'About Me',
        title: 'About Me',
        slug: 'about-me',
        status: 'active',
      },
    })
    console.log('Created PostType About Me')
  } else if (aboutType.legacyId == null) {
    aboutType = await prisma.postType.update({
      where: { id: aboutType.id },
      data: { legacyId: ABOUT_POST_TYPE_LEGACY_ID },
    })
  }

  const aboutPosts = await prisma.post.findMany({
    where: {
      deletedAt: null,
      postTypeId: aboutType.id,
    },
    include: {
      attachments: {
        orderBy: { createdAt: 'asc' },
        take: 5,
      },
    },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
  })

  const latestByProfile = new Map<string, (typeof aboutPosts)[number]>()
  for (const post of aboutPosts) {
    if (!latestByProfile.has(post.profileId)) {
      latestByProfile.set(post.profileId, post)
    }
  }

  let created = 0
  let updated = 0
  let repairedFromDump = 0
  let fromProfileAbout = 0
  let skippedEmpty = 0

  for (const [profileId, post] of latestByProfile) {
    let description = post.description?.trim() || ''
    if (!description && post.legacyId != null) {
      const fromDump = dumpContent.get(post.legacyId)?.trim()
      if (fromDump) {
        description = fromDump
        repairedFromDump += 1
      }
    }
    if (!description) {
      const profile = await prisma.profile.findUnique({
        where: { id: profileId },
        select: { about: true },
      })
      description = profile?.about?.trim() || ''
    }

    const title = post.title?.trim() || DEFAULT_TITLE
    const featuredMediaUrl =
      post.featuredImage?.trim() || post.attachments.find((a) => a.url?.trim())?.url?.trim() || null

    if (!description && !featuredMediaUrl && title === DEFAULT_TITLE) {
      // Still upsert a row if there was an About Me post (title may be custom).
      if (!post.title?.trim()) {
        skippedEmpty += 1
        continue
      }
    }

    const existing = await prisma.aboutMe.findUnique({ where: { profileId } })
    await prisma.aboutMe.upsert({
      where: { profileId },
      create: {
        profileId,
        legacyPostId: post.legacyId ?? undefined,
        title,
        description: description || null,
        featuredMediaUrl,
        status: post.status || '1',
      },
      update: {
        legacyPostId: post.legacyId ?? undefined,
        title,
        description: description || null,
        featuredMediaUrl,
        status: post.status || '1',
      },
    })
    if (existing) updated += 1
    else created += 1
  }

  const profilesWithAbout = await prisma.profile.findMany({
    where: {
      about: { not: null },
      aboutMe: null,
    },
    select: { id: true, about: true },
  })

  for (const profile of profilesWithAbout) {
    const description = profile.about?.trim()
    if (!description) continue
    await prisma.aboutMe.create({
      data: {
        profileId: profile.id,
        title: DEFAULT_TITLE,
        description,
        status: '1',
      },
    })
    created += 1
    fromProfileAbout += 1
  }

  const total = await prisma.aboutMe.count()
  console.log(
    JSON.stringify(
      {
        created,
        updated,
        repairedFromDump,
        fromProfileAbout,
        skippedEmpty,
        aboutPostsConsidered: aboutPosts.length,
        profilesFromPosts: latestByProfile.size,
        totalAboutMeRows: total,
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
  .finally(() => prisma.$disconnect())
