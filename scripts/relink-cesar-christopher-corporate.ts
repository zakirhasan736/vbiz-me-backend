/**
 * Flip corporate hierarchy for two existing cards (no content overwrite):
 *   - cesar-vertiz-1     → Corporate Team Owner card
 *   - christopher-crespo → linked Corporate Team Member card under Cesar
 *
 * Also ensures Christopher has a User login matching his card email, demotes
 * his old corporate-owner role if needed, and clears member-only locks on Cesar.
 *
 * IMPORTANT: both cards currently publish the same email (adukoct@gmail.com).
 * A separate team-member login REQUIRES a distinct email for Christopher:
 *   --member-email=chris@example.com
 * That updates christopher-crespo Profile.email (login source) only — other
 * card content is untouched.
 *
 * Dry-run:  npx tsx --env-file=.env scripts/relink-cesar-christopher-corporate.ts --member-email=...
 * Apply:    npx tsx --env-file=.env scripts/relink-cesar-christopher-corporate.ts --member-email=... --apply
 *
 * Optional:
 *   --reset-member-password  Set Christopher's login to CORPORATE_MEMBER_DEFAULT_PASSWORD
 *   --corporate-email=...    Force which User is the corporate parent (default: Cesar card login / email)
 */
import { AccountStatus, UserRole as PrismaUserRole } from '../generated/prisma/enums'
import { toApiRole, toPrismaRole } from '../src/constants/userRole'
import { provisionCorporateMemberUser } from '../src/utils/corporateMemberUser'
import { clearCorporateMemberState } from '../src/utils/corporateSiblingSync'
import { CORPORATE_MEMBER_DEFAULT_PASSWORD } from '../src/utils/duplicateCard'
import { prisma } from '../src/utils/prisma'

const OWNER_SLUG = 'cesar-vertiz-1'
const MEMBER_SLUG = 'christopher-crespo'

async function loadCard(slug: string) {
  return prisma.profile.findFirst({
    where: { slug: { equals: slug, mode: 'insensitive' } },
    select: {
      id: true,
      slug: true,
      name: true,
      email: true,
      phone: true,
      companyName: true,
      userId: true,
      companyUserId: true,
      createdById: true,
      user: { select: { id: true, email: true, role: true, deletedAt: true, isActive: true } },
      companyUser: { select: { id: true, email: true, role: true, deletedAt: true } },
    },
  })
}

function snapshot(card: NonNullable<Awaited<ReturnType<typeof loadCard>>>) {
  return {
    slug: card.slug,
    name: card.name,
    email: card.email,
    userId: card.userId,
    companyUserId: card.companyUserId,
    loginEmail: card.user?.email || null,
    loginRole: card.user ? toApiRole(card.user.role) : null,
    companyEmail: card.companyUser?.email || null,
    companyRole: card.companyUser ? toApiRole(card.companyUser.role) : null,
    isOwnerCard: Boolean(card.userId && card.userId === card.companyUserId),
    isMemberCard: Boolean(card.userId && card.companyUserId && card.userId !== card.companyUserId),
  }
}

function argValue(prefix: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(prefix))
  if (!hit) return null
  return hit.slice(prefix.length).trim() || null
}

async function main() {
  const apply = process.argv.includes('--apply')
  const resetMemberPassword = process.argv.includes('--reset-member-password')
  const forcedCorporateEmail = argValue('--corporate-email=')
  const forcedMemberEmail = argValue('--member-email=')

  const ownerCard = await loadCard(OWNER_SLUG)
  const memberCard = await loadCard(MEMBER_SLUG)
  if (!ownerCard) throw new Error(`Owner card not found: ${OWNER_SLUG}`)
  if (!memberCard) throw new Error(`Member card not found: ${MEMBER_SLUG}`)

  console.log('=== BEFORE ===')
  console.log(JSON.stringify({ owner: snapshot(ownerCard), member: snapshot(memberCard) }, null, 2))

  // Corporate login: explicit flag → Cesar card userId → User matching Cesar card email.
  let corporate = forcedCorporateEmail
    ? await prisma.user.findFirst({
        where: { email: { equals: forcedCorporateEmail, mode: 'insensitive' }, deletedAt: null },
        select: { id: true, email: true, name: true, role: true },
      })
    : null

  if (!corporate && ownerCard.userId) {
    corporate = await prisma.user.findFirst({
      where: { id: ownerCard.userId, deletedAt: null },
      select: { id: true, email: true, name: true, role: true },
    })
  }

  if (!corporate) {
    const ownerEmail = (ownerCard.email || '').trim().toLowerCase()
    if (!ownerEmail) {
      throw new Error(`${OWNER_SLUG} has no login user and no card email — cannot determine corporate account`)
    }
    corporate = await prisma.user.findFirst({
      where: { email: { equals: ownerEmail, mode: 'insensitive' }, deletedAt: null },
      select: { id: true, email: true, name: true, role: true },
    })
  }

  if (!corporate) {
    throw new Error(
      `${OWNER_SLUG} needs a User login (card email / userId). Create/claim Cesar's login first, then re-run.`
    )
  }

  // Resolve Christopher's member login email (must differ from corporate login).
  let memberEmail = (forcedMemberEmail || memberCard.email || '').trim().toLowerCase()
  if (!memberEmail) {
    throw new Error(
      `${MEMBER_SLUG} has no card email. Pass --member-email=chris@example.com for his team-member login.`
    )
  }
  if (memberEmail === corporate.email.trim().toLowerCase()) {
    throw new Error(
      [
        `${MEMBER_SLUG} email "${memberEmail}" is the same as Cesar corporate login.`,
        'Team-member login needs a DISTINCT email (User.email is unique).',
        'Re-run with e.g. --member-email=christopher.crespo@example.com',
        '(that only updates the member card email + creates/links his User; no other content changes).',
      ].join('\n')
    )
  }

  const willUpdateMemberCardEmail = (memberCard.email || '').trim().toLowerCase() !== memberEmail

  const plan = {
    apply,
    corporate: { id: corporate.id, email: corporate.email, role: toApiRole(corporate.role) },
    ownerCard: {
      slug: ownerCard.slug,
      action: 'claim_as_owner_card',
      next: { userId: corporate.id, companyUserId: corporate.id },
    },
    memberCard: {
      slug: memberCard.slug,
      action: 'link_as_team_member',
      cardEmail: memberEmail,
      updateCardEmail: willUpdateMemberCardEmail,
      previousCardEmail: memberCard.email,
      note: 'Ensure User exists for card email, then set userId=member, companyUserId=cesar',
    },
    demoteOldCorporateOwners: true,
    clearOwnerMemberLocks: true,
    resetMemberPassword,
    defaultPassword: CORPORATE_MEMBER_DEFAULT_PASSWORD,
    contentSync: false,
  }
  console.log('\n=== PLAN ===')
  console.log(JSON.stringify(plan, null, 2))

  if (!apply) {
    console.log('\nDry-run only. Re-run with --apply to write ownership (card content untouched).')
    return
  }

  // 1) Promote Cesar login → corporate-owner
  if (toApiRole(corporate.role) !== 'corporate-owner') {
    await prisma.user.update({
      where: { id: corporate.id },
      data: { role: toPrismaRole('corporate-owner') },
    })
    console.log(`Promoted ${corporate.email} → corporate-owner`)
  }

  // 2) Cesar card = owner source card (login + company parent = Cesar)
  await prisma.profile.update({
    where: { id: ownerCard.id },
    data: {
      userId: corporate.id,
      companyUserId: corporate.id,
      createdById: ownerCard.createdById || corporate.id,
    },
  })
  // Owner card should not keep member-only lock settings
  await clearCorporateMemberState(ownerCard.id)
  // Owner source cards must not look like duplicates of another card
  await prisma.setting.deleteMany({ where: { profileId: ownerCard.id, key: 'duplicated_from' } }).catch(() => undefined)

  // 3) Ensure Christopher has a User matching his (possibly updated) card email, then link under Cesar
  if (willUpdateMemberCardEmail) {
    await prisma.profile.update({
      where: { id: memberCard.id },
      data: { email: memberEmail },
    })
    console.log(`Updated ${MEMBER_SLUG} card email → ${memberEmail}`)
  }

  const provisioned = await provisionCorporateMemberUser({
    name: memberCard.name || memberEmail,
    email: memberEmail,
    phone: memberCard.phone,
    companyName: memberCard.companyName,
    createdById: corporate.id,
    corporateUserId: corporate.id,
    linkExistingMember: true,
    resetPasswordOnLink: resetMemberPassword || willUpdateMemberCardEmail,
  })

  await prisma.profile.update({
    where: { id: memberCard.id },
    data: {
      userId: provisioned.ownership.userId,
      companyUserId: provisioned.ownership.companyUserId,
      createdById: provisioned.ownership.createdById,
    },
  })

  // If member was never duplicated, stamp duplicated_from so corporate member semantics apply
  // (locks / hide-owner features). Do not overwrite if already set.
  const existingDup = await prisma.setting.findUnique({
    where: { profileId_key: { profileId: memberCard.id, key: 'duplicated_from' } },
    select: { value: true },
  })
  if (!existingDup?.value) {
    await prisma.setting.upsert({
      where: { profileId_key: { profileId: memberCard.id, key: 'duplicated_from' } },
      create: { profileId: memberCard.id, key: 'duplicated_from', value: ownerCard.id },
      update: { value: ownerCard.id },
    })
  }

  // 4) Demote previous corporate-owner users that are no longer owners of any owner-source card
  //    (typically Christopher's old corporate login).
  const previousCorporateUserIds = new Set<string>()
  for (const id of [memberCard.userId, memberCard.companyUserId, ownerCard.companyUserId]) {
    if (id && id !== corporate.id) previousCorporateUserIds.add(id)
  }
  for (const userId of previousCorporateUserIds) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, role: true },
    })
    if (!user || toApiRole(user.role) !== 'corporate-owner') continue

    const stillOwnsOwnerCard = await prisma.profile.findFirst({
      where: {
        userId: user.id,
        companyUserId: user.id,
      },
      select: { id: true, slug: true },
    })
    if (stillOwnsOwnerCard) {
      console.log(`Kept corporate-owner on ${user.email} — still owns owner card ${stillOwnsOwnerCard.slug}`)
      continue
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        role: PrismaUserRole.VCARD_OWNER,
        isActive: true,
        accountStatus: AccountStatus.ACTIVE,
      },
    })
    console.log(`Demoted ${user.email} corporate-owner → vcard-owner (team member login)`)
  }

  const afterOwner = await loadCard(OWNER_SLUG)
  const afterMember = await loadCard(MEMBER_SLUG)
  console.log('\n=== AFTER ===')
  console.log(
    JSON.stringify(
      {
        owner: afterOwner ? snapshot(afterOwner) : null,
        member: afterMember ? snapshot(afterMember) : null,
        memberProvision: {
          memberUserId: provisioned.memberUserId,
          created: provisioned.created,
          linkedExisting: provisioned.linkedExisting,
          passwordReset: provisioned.passwordReset || resetMemberPassword,
          loginEmail: memberEmail,
          passwordHint:
            resetMemberPassword || provisioned.created || provisioned.passwordReset
              ? CORPORATE_MEMBER_DEFAULT_PASSWORD
              : '(unchanged — pass --reset-member-password to set default)',
        },
        note: 'Profile content / media / tabs were NOT modified — only ownership + login linkage.',
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
