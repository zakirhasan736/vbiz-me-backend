/**
 * Owner/package backfill (plan Step 11). Default is dry-run (report only).
 *
 *   yarn backfill:owner-packages
 *   yarn backfill:owner-packages -- --apply
 *
 * Apply `20260820040000_package_owner_mode` first (`yarn migrate:deploy`).
 * Never deletes profiles or cards. Corporate owners on Free/Single are listed, not demoted.
 */
import 'dotenv/config'
import { UserRole as PrismaUserRole } from '../generated/prisma/enums'
import { defaultAllowFlagValue } from '../src/constants/packageAccess'
import {
  CATALOG_PACKAGE_SLUGS,
  inferOwnerModeFromCatalog,
  parsePackageMaxCards,
  parseStoredOwnerMode,
  resolveOwnerMode,
  resolveProvisionCardQuantity,
} from '../src/constants/packageOwnerMode'
import { toApiRole, toPrismaRole } from '../src/constants/userRole'
import {
  assertProfileCountUnchanged,
  decideCorporateQuantityCopy,
  decideMissingSubscription,
  decideOwnerRoleBackfill,
  missingAllowFlagKeys,
} from '../src/utils/packageBackfill'
import { prisma } from '../src/utils/prisma'

const apply = process.argv.includes('--apply')

type ReportRow = {
  userId: string
  email: string
  role: string
  packageSlug: string | null
  action: string
  detail: string
}

async function latestActiveSubscription(userId: string) {
  const now = new Date()
  return prisma.subscription.findFirst({
    where: { userId, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    include: { package: { include: { features: true } } },
    orderBy: { createdAt: 'desc' },
  })
}

async function main() {
  const profileCountBefore = await prisma.profile.count()
  console.log(apply ? 'MODE: apply' : 'MODE: dry-run (pass --apply to write)')
  console.log(`profiles before: ${profileCountBefore}`)

  const packages = await prisma.package.findMany({ include: { features: true } })
  for (const pkg of packages) {
    const expected = inferOwnerModeFromCatalog(pkg)
    const stored = parseStoredOwnerMode(pkg.ownerMode)
    if (stored !== expected) {
      console.log(`package ownerMode drift: ${pkg.slug || pkg.name} stored=${pkg.ownerMode} expected=${expected}`)
      if (apply) {
        await prisma.package.update({
          where: { id: pkg.id },
          data: { ownerMode: expected === 'corporate' ? 'CORPORATE' : 'SINGLE' },
        })
      }
    }
  }
  const catalogBySlug = new Map(
    packages.map((pkg) => [(pkg.slug || '').trim().toLowerCase(), pkg] as const).filter(([slug]) => Boolean(slug))
  )
  const missingCatalog = CATALOG_PACKAGE_SLUGS.filter((slug) => !catalogBySlug.has(slug))
  if (missingCatalog.length) {
    console.log(`missing catalog packages (not auto-created): ${missingCatalog.join(', ')}`)
  }

  const allowFlagCreates: Array<{ packageId: string; slug: string; featureKey: string }> = []
  for (const slug of CATALOG_PACKAGE_SLUGS) {
    const pkg = catalogBySlug.get(slug)
    if (!pkg) continue
    for (const featureKey of missingAllowFlagKeys(pkg.features.map((row) => row.featureKey))) {
      allowFlagCreates.push({ packageId: pkg.id, slug, featureKey })
    }
  }

  const owners = await prisma.user.findMany({
    where: {
      deletedAt: null,
      role: { in: [PrismaUserRole.VCARD_OWNER, PrismaUserRole.CORPORATE_OWNER] },
    },
    select: { id: true, email: true, role: true },
    orderBy: { createdAt: 'asc' },
  })

  const attachRows: ReportRow[] = []
  const roleRows: ReportRow[] = []
  const reportRows: ReportRow[] = []
  const quantityRows: ReportRow[] = []

  for (const owner of owners) {
    const role = toApiRole(owner.role)
    const sub = await latestActiveSubscription(owner.id)
    const pkg = sub?.package || null
    const ownerMode = pkg ? resolveOwnerMode(pkg) : null
    const packageSlug = pkg?.slug || null

    const missing = decideMissingSubscription({ role, hasActiveSubscription: Boolean(sub) })
    if (missing.action === 'attach') {
      const target = catalogBySlug.get(missing.slug)
      attachRows.push({
        userId: owner.id,
        email: owner.email,
        role,
        packageSlug,
        action: target ? `attach:${missing.slug}` : `missing-package:${missing.slug}`,
        detail: target ? `Would attach ${missing.slug}` : `Catalog package ${missing.slug} is missing`,
      })
    }

    const roleDecision = decideOwnerRoleBackfill({ role, ownerMode })
    if (roleDecision.action === 'set') {
      roleRows.push({
        userId: owner.id,
        email: owner.email,
        role,
        packageSlug,
        action: `role:${roleDecision.nextRole}`,
        detail: roleDecision.reason,
      })
    } else if (roleDecision.action === 'report') {
      reportRows.push({
        userId: owner.id,
        email: owner.email,
        role,
        packageSlug,
        action: roleDecision.code,
        detail: roleDecision.reason,
      })
    }

    if (sub && ownerMode === 'corporate') {
      const quantityDecision = decideCorporateQuantityCopy({
        ownerMode,
        quantity: sub.quantity,
        packageMaxCards: parsePackageMaxCards(pkg?.features),
      })
      if (quantityDecision.action === 'set') {
        quantityRows.push({
          userId: owner.id,
          email: owner.email,
          role,
          packageSlug,
          action: `quantity:${quantityDecision.quantity}`,
          detail: `Copy package max_cards=${quantityDecision.quantity} into Subscription.quantity`,
        })
      }
    }
  }

  const printGroup = (title: string, rows: ReportRow[]) => {
    console.log(`\n${title}: ${rows.length}`)
    for (const row of rows.slice(0, 50)) {
      console.log(`  ${row.email} role=${row.role} package=${row.packageSlug || 'none'} ${row.action} — ${row.detail}`)
    }
    if (rows.length > 50) console.log(`  … ${rows.length - 50} more`)
  }

  console.log(`\nallow_* explicit defaults to insert: ${allowFlagCreates.length}`)
  for (const row of allowFlagCreates) {
    console.log(`  ${row.slug} ${row.featureKey}=${defaultAllowFlagValue(row.featureKey)}`)
  }

  printGroup('attach missing subscriptions', attachRows)
  printGroup('unambiguous role alignments', roleRows)
  printGroup('Corporate owners on Single/Free (not auto-demoted)', reportRows)
  printGroup('copy Corporate max_cards into quantity', quantityRows)

  if (!apply) {
    console.log('\nDry-run complete. No writes. Re-run with --apply after reviewing the report.')
    assertProfileCountUnchanged(profileCountBefore, await prisma.profile.count())
    return
  }

  for (const row of allowFlagCreates) {
    const featureValue = defaultAllowFlagValue(row.featureKey)
    await prisma.packageFeature.upsert({
      where: { packageId_featureKey: { packageId: row.packageId, featureKey: row.featureKey } },
      create: { packageId: row.packageId, featureKey: row.featureKey, featureValue },
      update: {},
    })
  }

  for (const row of attachRows) {
    if (!row.action.startsWith('attach:')) continue
    const slug = row.action.slice('attach:'.length)
    const pkg = catalogBySlug.get(slug)
    if (!pkg) continue
    const existing = await latestActiveSubscription(row.userId)
    if (existing) continue
    const ownerMode = resolveOwnerMode(pkg)
    const quantity = resolveProvisionCardQuantity({
      ownerMode,
      packageMaxCards: parsePackageMaxCards(pkg.features),
    })
    await prisma.subscription.create({
      data: {
        userId: row.userId,
        packageId: pkg.id,
        name: pkg.name,
        provider: 'admin',
        stripeStatus: 'active',
        endsAt: null,
        ...(quantity != null ? { quantity } : {}),
      },
    })
  }

  for (const row of roleRows) {
    const nextRole = row.action.startsWith('role:') ? row.action.slice('role:'.length) : null
    if (nextRole !== 'vcard-owner' && nextRole !== 'corporate-owner') continue
    await prisma.user.update({
      where: { id: row.userId },
      data: { role: toPrismaRole(nextRole) },
    })
  }

  for (const row of quantityRows) {
    const sub = await latestActiveSubscription(row.userId)
    if (!sub || sub.quantity != null) continue
    const parsed = Number.parseInt(row.action.slice('quantity:'.length), 10)
    if (!Number.isInteger(parsed) || parsed < 0) continue
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { quantity: parsed },
    })
  }

  const profileCountAfter = await prisma.profile.count()
  assertProfileCountUnchanged(profileCountBefore, profileCountAfter)
  console.log(`\nApply complete. profiles after: ${profileCountAfter}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
