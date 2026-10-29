/**
 * Report which card media URLs are missing from S3 (browser shows AccessDenied).
 *
 *   npx tsx --env-file=.env scripts/audit-card-media-urls.ts michelle-loyola
 */
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import config from '../src/configs/config'
import { prisma } from '../src/utils/prisma'

function keyFromUrl(url: string): string | null {
  const base = (config.S3.PUBLIC_BASE_URL || '').replace(/\/$/, '')
  const trimmed = url.trim()
  if (!trimmed || !base || !trimmed.startsWith(base + '/')) return null
  return trimmed.slice(base.length + 1).split(/[?#]/)[0]
}

async function main() {
  const slug = (process.argv[2] || '').trim()
  if (!slug) throw new Error('Usage: audit-card-media-urls.ts <profile-slug>')

  const profile = await prisma.profile.findFirst({
    where: { slug },
    select: { id: true, slug: true, avatar: true, name: true },
  })
  if (!profile) throw new Error(`Profile not found: ${slug}`)

  const urls = new Set<string>()
  const add = (u?: string | null) => {
    const v = (u || '').trim()
    if (v.startsWith('http')) urls.add(v)
  }
  add(profile.avatar)

  const [services, portfolios, galleries, blogs, about, tabs, settings, attachments] = await Promise.all([
    prisma.service.findMany({ where: { profileId: profile.id }, select: { id: true, title: true, imageUrl: true } }),
    prisma.portfolio.findMany({
      where: { profileId: profile.id },
      select: { id: true, title: true, imageUrl: true, attachmentUrl: true },
    }),
    prisma.gallery.findMany({
      where: { profileId: profile.id },
      select: { id: true, title: true, featuredImage: true, url: true, attachmentUrl: true },
    }),
    prisma.blog.findMany({
      where: { profileId: profile.id },
      select: { id: true, title: true, featuredImage: true, url: true },
    }),
    prisma.aboutMe.findFirst({
      where: { profileId: profile.id },
      select: { featuredMediaUrl: true },
    }),
    prisma.tabItem.findMany({
      where: { profileId: profile.id },
      select: { id: true, tabKey: true, title: true, featuredImage: true, url: true },
    }),
    prisma.setting.findMany({ where: { profileId: profile.id }, select: { key: true, value: true } }),
    prisma.attachment.findMany({
      where: { profileId: profile.id },
      select: { id: true, url: true, publicId: true },
    }),
  ])

  for (const s of services) add(s.imageUrl)
  for (const p of portfolios) {
    add(p.imageUrl)
    add(p.attachmentUrl)
  }
  for (const g of galleries) {
    add(g.featuredImage)
    add(g.url)
    add(g.attachmentUrl)
  }
  for (const b of blogs) {
    add(b.featuredImage)
    add(b.url)
  }
  add(about?.featuredMediaUrl)
  for (const t of tabs) {
    add(t.featuredImage)
    add(t.url)
  }
  for (const s of settings) add(s.value)
  for (const a of attachments) add(a.url)

  const client = new S3Client({
    region: config.S3.REGION,
    credentials: {
      accessKeyId: config.S3.ACCESS_KEY_ID!,
      secretAccessKey: config.S3.SECRET_ACCESS_KEY!,
    },
  })

  console.log(`Card ${profile.slug} (${profile.id}) — ${urls.size} media URLs`)
  let missing = 0
  let ok = 0
  let skipped = 0
  for (const url of [...urls].sort()) {
    const key = keyFromUrl(url)
    if (!key) {
      skipped++
      console.log('SKIP (not our S3 base)', url.slice(0, 120))
      continue
    }
    try {
      await client.send(new HeadObjectCommand({ Bucket: config.S3.BUCKET!, Key: key }))
      ok++
      console.log('OK ', key)
    } catch {
      missing++
      console.log('MISS', key)
      console.log('     ', url)
    }
  }
  console.log(`\nSummary: ok=${ok} missing=${missing} skipped=${skipped}`)
  console.log(
    missing
      ? 'Missing keys cause browser AccessDenied. Re-upload those images on the card (do not use Remove on one item until this fix is deployed).'
      : 'All S3 URLs resolve.'
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined)
  })
