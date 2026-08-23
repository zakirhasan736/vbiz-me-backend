import { prisma } from '../src/utils/prisma'

async function main() {
  const rows = await prisma.announcement.findMany({
    where: { status: 'active' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, title: true, targetType: true, meta: true, targetEmails: true, body: true },
  })

  const summary = rows.map((row) => {
    const meta =
      row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? (row.meta as Record<string, unknown>) : {}
    return {
      id: row.id.slice(0, 10),
      title: (row.title || '').slice(0, 48),
      targetType: row.targetType,
      showPublic: meta.showPublic ?? null,
      channel: meta.channel ?? null,
      profileId: meta.profileId ?? null,
      emailCount: row.targetEmails.length,
      bodyLen: (row.body || '').length,
    }
  })

  console.log(JSON.stringify(summary, null, 2))
  console.log('publicEligible:', summary.filter((row) => row.showPublic === '1' && row.channel !== 'inbox').length)
  await prisma.$disconnect()
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
