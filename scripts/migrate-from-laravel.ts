/**
 * Import Laravel MySQL data into the new Prisma/Postgres database.
 *
 * Preferred: set LARAVEL_MYSQL_URL=mysql://user:pass@host:3306/vbizme_app
 * after loading vbizme_app_backup.sql into a temporary MySQL instance.
 *
 * Usage:
 *   yarn tsx --env-file=.env scripts/migrate-from-laravel.ts
 */
import mysql from 'mysql2/promise'
import { AuthProvider, UserRole } from '../generated/prisma/client'
import config from '../src/configs/config'
import logger from '../src/utils/logger'
import { resolveMediaUrl } from '../src/utils/mediaUrl'
import { prisma } from '../src/utils/prisma'

const legacyIdForProfile = (profileMap: IdMap, profileId: string | null): number | null => {
  if (!profileId) return null
  for (const [legacy, id] of profileMap) {
    if (id === profileId) return legacy
  }
  return null
}

type IdMap = Map<number, string>

const mapOrNull = (map: IdMap, legacy?: number | null) => (legacy == null ? null : (map.get(Number(legacy)) ?? null))

const toDate = (v: unknown): Date | null => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

const roleFromSpatie = (roleName?: string | null): UserRole => {
  const n = (roleName || '').toLowerCase()
  if (n.includes('admin') && !n.includes('corporate')) return UserRole.ADMIN
  if (n.includes('corporate')) return UserRole.CORPORATE_OWNER
  return UserRole.VCARD_OWNER
}

async function loadRows(conn: mysql.Connection, table: string) {
  const [rows] = await conn.query(`SELECT * FROM \`${table}\``)
  return rows as Record<string, unknown>[]
}

async function importLookups(conn: mysql.Connection) {
  const statusMap: IdMap = new Map()
  const genderMap: IdMap = new Map()
  const maritalMap: IdMap = new Map()
  const professionMap: IdMap = new Map()
  const countryMap: IdMap = new Map()
  const stateMap: IdMap = new Map()
  const cityMap: IdMap = new Map()
  const attachmentTypeMap: IdMap = new Map()
  const postTypeMap: IdMap = new Map()
  const packageMap: IdMap = new Map()

  for (const row of await loadRows(conn, 'statuses')) {
    const created = await prisma.status.upsert({
      where: { legacyId: Number(row.id) },
      create: { legacyId: Number(row.id), name: String(row.name) },
      update: { name: String(row.name) },
    })
    statusMap.set(Number(row.id), created.id)
  }

  for (const row of await loadRows(conn, 'genders')) {
    const created = await prisma.gender.upsert({
      where: { legacyId: Number(row.id) },
      create: { legacyId: Number(row.id), name: String(row.name) },
      update: { name: String(row.name) },
    })
    genderMap.set(Number(row.id), created.id)
  }

  for (const row of await loadRows(conn, 'marital_statuses')) {
    const created = await prisma.maritalStatus.upsert({
      where: { legacyId: Number(row.id) },
      create: { legacyId: Number(row.id), name: String(row.name) },
      update: { name: String(row.name) },
    })
    maritalMap.set(Number(row.id), created.id)
  }

  for (const row of await loadRows(conn, 'professions')) {
    const name = String(row.name || `profession-${row.id}`)
    const existing = await prisma.profession.findFirst({
      where: { OR: [{ legacyId: Number(row.id) }, { name }] },
    })
    const created = existing || (await prisma.profession.create({ data: { legacyId: Number(row.id), name } }))
    if (!existing) {
      // ok
    } else if (existing.legacyId == null) {
      await prisma.profession.update({ where: { id: existing.id }, data: { legacyId: Number(row.id) } })
    }
    professionMap.set(Number(row.id), created.id)
  }

  for (const row of await loadRows(conn, 'countries')) {
    const created = await prisma.country.upsert({
      where: { legacyId: Number(row.id) },
      create: { legacyId: Number(row.id), name: String(row.name), code: row.code ? String(row.code) : null },
      update: { name: String(row.name) },
    })
    countryMap.set(Number(row.id), created.id)
  }

  for (const row of await loadRows(conn, 'states')) {
    const created = await prisma.state.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        name: String(row.name),
        countryId: mapOrNull(countryMap, row.country_id as number),
      },
      update: { name: String(row.name) },
    })
    stateMap.set(Number(row.id), created.id)
  }

  for (const row of await loadRows(conn, 'cities')) {
    const created = await prisma.city.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        name: String(row.name),
        stateId: mapOrNull(stateMap, row.state_id as number),
        countryId: mapOrNull(countryMap, row.country_id as number),
      },
      update: { name: String(row.name) },
    })
    cityMap.set(Number(row.id), created.id)
  }

  for (const row of await loadRows(conn, 'attachment_types')) {
    const created = await prisma.attachmentType.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        name: String(row.name),
        slug: row.slug ? String(row.slug) : null,
        status: row.status ? String(row.status) : 'active',
      },
      update: { name: String(row.name) },
    })
    attachmentTypeMap.set(Number(row.id), created.id)
  }

  for (const row of await loadRows(conn, 'post_types')) {
    const created = await prisma.postType.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        name: String(row.name),
        title: row.title ? String(row.title) : String(row.name),
        slug: row.slug ? String(row.slug) : null,
        status: row.status ? String(row.status) : 'active',
        typeId: row.type_id != null ? Number(row.type_id) : null,
      },
      update: { name: String(row.name), title: row.title ? String(row.title) : undefined },
    })
    postTypeMap.set(Number(row.id), created.id)
  }

  for (const row of await loadRows(conn, 'packages')) {
    const created = await prisma.package.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        name: String(row.name),
        slug: row.slug ? String(row.slug) : null,
        description: row.description ? String(row.description) : null,
        monthlyPrice: row.monthly_price != null ? Number(row.monthly_price) : 0,
        yearlyPrice: row.yearly_price != null ? Number(row.yearly_price) : 0,
        isActive: true,
      },
      update: { name: String(row.name) },
    })
    packageMap.set(Number(row.id), created.id)
  }

  for (const row of await loadRows(conn, 'package_features')) {
    const packageId = mapOrNull(packageMap, row.package_id as number)
    if (!packageId) continue
    const featureKey = String(row.feature_key || row.key || row.name || `feature-${row.id}`)
    await prisma.packageFeature.upsert({
      where: { packageId_featureKey: { packageId, featureKey } },
      create: {
        legacyId: Number(row.id),
        packageId,
        featureKey,
        featureValue:
          row.feature_value != null ? String(row.feature_value) : row.value != null ? String(row.value) : null,
      },
      update: {
        featureValue: row.feature_value != null ? String(row.feature_value) : undefined,
      },
    })
  }

  return {
    statusMap,
    genderMap,
    maritalMap,
    professionMap,
    countryMap,
    stateMap,
    cityMap,
    attachmentTypeMap,
    postTypeMap,
    packageMap,
  }
}

async function importUsers(conn: mysql.Connection) {
  const userMap: IdMap = new Map()
  const roles = await loadRows(conn, 'roles')
  const roleNameById = new Map(roles.map((r) => [Number(r.id), String(r.name)]))
  const modelRoles = await loadRows(conn, 'model_has_roles')
  const userRoleName = new Map<number, string>()
  for (const mr of modelRoles) {
    if (String(mr.model_type || '').includes('User')) {
      userRoleName.set(Number(mr.model_id), roleNameById.get(Number(mr.role_id)) || 'User')
    }
  }

  for (const row of await loadRows(conn, 'users')) {
    if (row.deleted_at) continue
    const email = String(row.email).toLowerCase()
    const role = roleFromSpatie(userRoleName.get(Number(row.id)))
    const existing = await prisma.user.findFirst({
      where: { OR: [{ legacyId: Number(row.id) }, { email }] },
    })
    const data = {
      legacyId: Number(row.id),
      email,
      name: String(row.name || email),
      password: row.password ? String(row.password) : null,
      role,
      provider: AuthProvider.LOCAL,
      isVerified: Boolean(row.email_verified_at),
      isActive: true,
      stripeId: row.stripe_id ? String(row.stripe_id) : null,
      pmType: row.pm_type ? String(row.pm_type) : null,
      pmLastFour: row.pm_last_four ? String(row.pm_last_four) : null,
      trialEndsAt: toDate(row.trial_ends_at),
      deletedAt: toDate(row.deleted_at),
      createdAt: toDate(row.created_at) || new Date(),
      updatedAt: toDate(row.updated_at) || new Date(),
    }
    const user = existing
      ? await prisma.user.update({ where: { id: existing.id }, data })
      : await prisma.user.create({ data })
    userMap.set(Number(row.id), user.id)
  }
  return userMap
}

async function importProfiles(conn: mysql.Connection, userMap: IdMap, maps: Awaited<ReturnType<typeof importLookups>>) {
  const profileMap: IdMap = new Map()
  for (const row of await loadRows(conn, 'profiles')) {
    const userId = mapOrNull(userMap, row.user_id as number)
    const slug = row.slug ? String(row.slug) : null
    const existing = await prisma.profile.findFirst({
      where: {
        OR: [{ legacyId: Number(row.id) }, ...(slug ? [{ slug }] : [])],
      },
    })
    const data = {
      legacyId: Number(row.id),
      userId,
      companyUserId: mapOrNull(userMap, row.company_user_id as number),
      statusId: mapOrNull(maps.statusMap, 1),
      genderId: mapOrNull(maps.genderMap, row.gender_id as number),
      maritalStatusId: mapOrNull(maps.maritalMap, row.marital_status_id as number),
      professionId: mapOrNull(maps.professionMap, row.profession_id as number),
      name: String(row.name || 'Unnamed'),
      slug,
      prof: row.prof ? String(row.prof) : null,
      companyName: row.company_name ? String(row.company_name) : null,
      email: String(row.email || `profile-${row.id}@migrated.local`),
      website: row.website ? String(row.website) : null,
      lastName: row.last_name ? String(row.last_name) : null,
      dob: toDate(row.dob),
      phone: row.phone ? String(row.phone) : null,
      whatsapp: row.whatsapp ? String(row.whatsapp) : null,
      countryCode: row.country_code ? String(row.country_code) : null,
      facebook: row.facebook ? String(row.facebook) : null,
      instagram: row.instagram ? String(row.instagram) : null,
      twitter: row.twitter ? String(row.twitter) : null,
      tiktok: row.tiktok ? String(row.tiktok) : null,
      youtube: row.youtube ? String(row.youtube) : null,
      rumble: row.rumble ? String(row.rumble) : null,
      truth: row.truth ? String(row.truth) : null,
      linkedin: row.linkedin ? String(row.linkedin) : null,
      avatar: row.avatar
        ? resolveMediaUrl({
            url: String(row.avatar),
            docName: String(row.avatar),
            attachmentTypeLegacyId: 13,
            attachmentTypeName: 'Profile Picture',
            profileLegacyId: Number(row.id),
          }) || String(row.avatar)
        : null,
      zipCode: row.zip_code ? String(row.zip_code) : null,
      colorCode: row.color_code ? String(row.color_code) : '#212121',
      address: row.address ? String(row.address) : null,
      about: row.about ? String(row.about) : null,
      isEmploy: Boolean(row.is_employ),
      designation: row.designation ? String(row.designation) : null,
      referralCount: Number(row.referral_count || 0),
      referralCode: row.referral_code ? String(row.referral_code) : null,
      isPublic: true,
      createdAt: toDate(row.created_at) || new Date(),
      updatedAt: toDate(row.updated_at) || new Date(),
    }
    const profile = existing
      ? await prisma.profile.update({ where: { id: existing.id }, data })
      : await prisma.profile.create({ data })
    profileMap.set(Number(row.id), profile.id)
  }
  return profileMap
}

async function importContent(
  conn: mysql.Connection,
  profileMap: IdMap,
  userMap: IdMap,
  maps: Awaited<ReturnType<typeof importLookups>>
) {
  for (const row of await loadRows(conn, 'education')) {
    const profileId = mapOrNull(profileMap, row.profile_id as number)
    if (!profileId) continue
    await prisma.education.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        profileId,
        institute: row.institute ? String(row.institute) : row.school ? String(row.school) : null,
        degree: row.degree ? String(row.degree) : null,
        fromDate: toDate(row.from_date || row.start_date),
        toDate: toDate(row.to_date || row.end_date),
        tillNow: Boolean(row.till_now || row.is_current),
        description: row.description ? String(row.description) : null,
      },
      update: {},
    })
  }

  for (const row of await loadRows(conn, 'experiences')) {
    const profileId = mapOrNull(profileMap, row.profile_id as number)
    if (!profileId) continue
    await prisma.experience.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        profileId,
        company: row.company ? String(row.company) : row.company_name ? String(row.company_name) : null,
        jobTitle: row.job_title ? String(row.job_title) : row.title ? String(row.title) : null,
        description: row.description ? String(row.description) : null,
        fromDate: toDate(row.from_date || row.start_date),
        toDate: toDate(row.to_date || row.end_date),
        tillNow: Boolean(row.till_now || row.is_current),
      },
      update: {},
    })
  }

  for (const row of await loadRows(conn, 'services')) {
    const profileId = mapOrNull(profileMap, row.profile_id as number)
    if (!profileId) continue
    await prisma.service.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        profileId,
        title: row.title ? String(row.title) : row.name ? String(row.name) : null,
        description: row.description ? String(row.description) : null,
        status: row.status != null ? Number(row.status) : 1,
      },
      update: {},
    })
  }

  for (const row of await loadRows(conn, 'portfolios')) {
    const profileId = mapOrNull(profileMap, row.profile_id as number)
    if (!profileId) continue
    await prisma.portfolio.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        profileId,
        title: row.title ? String(row.title) : null,
        description: row.description ? String(row.description) : null,
        status: row.status != null ? Number(row.status) : 1,
        url: row.url ? String(row.url) : null,
      },
      update: {},
    })
  }

  const postMap: IdMap = new Map()
  for (const row of await loadRows(conn, 'posts')) {
    const profileId = mapOrNull(profileMap, row.profile_id as number)
    if (!profileId) continue
    const post = await prisma.post.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        profileId,
        postTypeId: mapOrNull(maps.postTypeMap, row.post_type_id as number),
        title: row.title ? String(row.title) : null,
        description: row.description ? String(row.description) : null,
        status: row.status != null ? String(row.status) : '1',
        url: row.url ? String(row.url) : null,
        createdById: mapOrNull(userMap, row.created_by as number),
        updatedById: mapOrNull(userMap, row.updated_by as number),
        deletedAt: toDate(row.deleted_at),
        createdAt: toDate(row.created_at) || new Date(),
        updatedAt: toDate(row.updated_at) || new Date(),
      },
      update: {},
    })
    postMap.set(Number(row.id), post.id)
  }

  for (const row of await loadRows(conn, 'post_metas')) {
    const postId = mapOrNull(postMap, row.post_id as number)
    if (!postId) continue
    await prisma.postMeta.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        postId,
        metaKey: String(row.meta_key || row.key || 'meta'),
        metaValue: row.meta_value != null ? String(row.meta_value) : null,
      },
      update: {},
    })
  }

  for (const row of await loadRows(conn, 'settings')) {
    const profileId = mapOrNull(profileMap, row.profile_id as number)
    if (!profileId) continue
    const key = String(row.key || row.name || `setting-${row.id}`)
    await prisma.setting.upsert({
      where: { profileId_key: { profileId, key } },
      create: {
        legacyId: Number(row.id),
        profileId,
        key,
        value: row.value != null ? String(row.value) : null,
      },
      update: { value: row.value != null ? String(row.value) : null },
    })
  }

  for (const row of await loadRows(conn, 'profile_settings')) {
    const profileId = mapOrNull(profileMap, row.profile_id as number)
    if (!profileId) continue
    let themeConfig = null
    if (row.theme_config) {
      try {
        themeConfig = typeof row.theme_config === 'string' ? JSON.parse(String(row.theme_config)) : row.theme_config
      } catch {
        themeConfig = null
      }
    }
    await prisma.profileSetting.upsert({
      where: { profileId },
      create: {
        legacyId: Number(row.id),
        profileId,
        profileTemplate: row.profile_template ? String(row.profile_template) : 'v3',
        layoutStyle: row.layout_style ? String(row.layout_style) : null,
        buttonStyle: row.button_style ? String(row.button_style) : null,
        cornerStyle: row.corner_style ? String(row.corner_style) : null,
        themeConfig: themeConfig as object | undefined,
      },
      update: {
        profileTemplate: row.profile_template ? String(row.profile_template) : undefined,
      },
    })
  }

  for (const row of await loadRows(conn, 'attachments')) {
    const attachableType = String(row.attachmentable_type || row.attachable_type || 'Profile')
    const attachableLegacyId = Number(row.attachmentable_id || row.attachable_id)
    let profileId: string | null = null
    let postId: string | null = null
    let attachableId: string | null

    if (attachableType.includes('Profile')) {
      profileId = mapOrNull(profileMap, attachableLegacyId)
      attachableId = profileId
    } else if (attachableType.includes('Post')) {
      postId = mapOrNull(postMap, attachableLegacyId)
      attachableId = postId
      if (postId) {
        const post = await prisma.post.findUnique({ where: { id: postId } })
        profileId = post?.profileId || null
      }
    } else {
      attachableId = mapOrNull(profileMap, attachableLegacyId) || String(attachableLegacyId)
      profileId = mapOrNull(profileMap, attachableLegacyId)
    }
    if (!attachableId) continue

    const docName = row.doc_name ? String(row.doc_name) : row.name ? String(row.name) : null
    const typeLegacyId = row.attachment_type_id != null ? Number(row.attachment_type_id) : null
    const profileLegacyId =
      legacyIdForProfile(profileMap, profileId) ?? (attachableType.includes('Profile') ? attachableLegacyId : null)
    const rawUrl = row.url ? String(row.url) : docName
    const url =
      resolveMediaUrl({
        url: rawUrl,
        docName,
        attachmentTypeLegacyId: typeLegacyId,
        profileLegacyId,
      }) || rawUrl

    await prisma.attachment.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        attachmentTypeId: mapOrNull(maps.attachmentTypeMap, row.attachment_type_id as number),
        attachableType,
        attachableId,
        profileId,
        postId,
        docName,
        url,
        extension: row.extension ? String(row.extension) : null,
      },
      update: { url, docName },
    })
  }

  for (const row of await loadRows(conn, 'contacts')) {
    const profileId = mapOrNull(profileMap, row.profile_id as number)
    if (!profileId) continue
    await prisma.contact.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        profileId,
        name: row.name ? String(row.name) : null,
        email: row.email ? String(row.email) : null,
        phone: row.phone ? String(row.phone) : null,
        message: row.message ? String(row.message) : null,
      },
      update: {},
    })
  }

  for (const row of await loadRows(conn, 'guest_user_data')) {
    const profileId = mapOrNull(profileMap, row.profile_id as number)
    if (!profileId) continue
    await prisma.guestUserData.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        profileId,
        firstName: row.first_name ? String(row.first_name) : null,
        lastName: row.last_name ? String(row.last_name) : null,
        email: row.email ? String(row.email) : null,
      },
      update: {},
    })
  }

  for (const row of await loadRows(conn, 'user_notes')) {
    const profileId = mapOrNull(profileMap, row.profile_id as number)
    if (!profileId) continue
    await prisma.userNote.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        profileId,
        content: String(row.content || row.note || ''),
      },
      update: {},
    })
  }

  for (const row of await loadRows(conn, 'company_employees')) {
    const userId = mapOrNull(userMap, row.user_id as number)
    const companyId = mapOrNull(userMap, row.company_id as number)
    if (!userId || !companyId) continue
    await prisma.companyEmployee.upsert({
      where: { userId_companyId: { userId, companyId } },
      create: { legacyId: Number(row.id), userId, companyId },
      update: {},
    })
  }

  for (const row of await loadRows(conn, 'subscriptions')) {
    const userId = mapOrNull(userMap, row.user_id as number)
    if (!userId) continue
    await prisma.subscription.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        userId,
        packageId: mapOrNull(maps.packageMap, row.package_id as number),
        name: row.name ? String(row.name) : null,
        stripeId: row.stripe_id ? String(row.stripe_id) : null,
        stripeStatus: row.stripe_status ? String(row.stripe_status) : null,
        stripePrice: row.stripe_price ? String(row.stripe_price) : null,
        quantity: row.quantity != null ? Number(row.quantity) : null,
        trialEndsAt: toDate(row.trial_ends_at),
        endsAt: toDate(row.ends_at),
        provider: row.provider ? String(row.provider) : null,
      },
      update: {},
    })
  }

  for (const row of await loadRows(conn, 'transactions')) {
    const userId = mapOrNull(userMap, row.user_id as number)
    if (!userId) continue
    const subLegacy = row.subscription_id != null ? Number(row.subscription_id) : null
    const sub = subLegacy ? await prisma.subscription.findFirst({ where: { legacyId: subLegacy } }) : null
    await prisma.transaction.upsert({
      where: { legacyId: Number(row.id) },
      create: {
        legacyId: Number(row.id),
        userId,
        subscriptionId: sub?.id,
        amount: row.amount != null ? Number(row.amount) : 0,
        currency: row.currency ? String(row.currency) : 'usd',
        status: row.status ? String(row.status) : null,
        provider: row.provider ? String(row.provider) : null,
      },
      update: {},
    })
  }

  return postMap
}

async function main() {
  if (!config.LARAVEL_MYSQL_URL) {
    throw new Error(
      'LARAVEL_MYSQL_URL is required. Load vbizme_app_backup.sql into MySQL and set LARAVEL_MYSQL_URL=mysql://user:pass@host:3306/vbizme_app'
    )
  }

  const conn = await mysql.createConnection(config.LARAVEL_MYSQL_URL)
  logger.info('Connected to Laravel MySQL')

  const maps = await importLookups(conn)
  logger.info('Lookups imported')

  const userMap = await importUsers(conn)
  logger.info(`Users imported: ${userMap.size}`)

  const profileMap = await importProfiles(conn, userMap, maps)
  logger.info(`Profiles imported: ${profileMap.size}`)

  await importContent(conn, profileMap, userMap, maps)
  logger.info('Content imported')

  await conn.end()
  logger.info('Done. Next: yarn migrate:media')
}

main()
  .catch((err) => {
    logger.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
