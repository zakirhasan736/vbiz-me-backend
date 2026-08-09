import logger from '../utils/logger'
import { prisma } from '../utils/prisma'

const MOCK_TICKETS = [
  {
    channel: 'feedback',
    type: 'satisfaction',
    status: 'open',
    subject: 'Love the new card templates',
    details: 'The corporate template pack looks great. Would love a few more dark-mode variants for our sales team.',
    rating: 5,
    fromRole: 'corporate',
    fromName: 'Amina Rahman',
    fromEmail: 'amina@northstar.co',
  },
  {
    channel: 'email',
    type: 'issue',
    status: 'open',
    subject: 'QR code not scanning on Android',
    details:
      'Several prospects reported that the download QR on my personal card fails on Samsung Galaxy devices. Works fine on iPhone.',
    fromRole: 'single',
    fromName: 'Jordan Lee',
    fromEmail: 'jordan.lee@example.com',
  },
  {
    channel: 'support',
    type: 'help',
    status: 'in_progress',
    subject: 'How do I invite team members?',
    details:
      'We upgraded to corporate but I cannot find where to send invite links to employees. Need step-by-step guidance.',
    fromRole: 'corporate',
    fromName: 'Priya Shah',
    fromEmail: 'priya@brightpath.io',
    adminReply: 'Checking your workspace settings — will confirm invite permissions shortly.',
  },
  {
    channel: 'feedback',
    type: 'feature',
    status: 'open',
    subject: 'Request: analytics export to CSV',
    details: 'Weekly engagement charts are useful. Please add a CSV export for leads and social clicks.',
    rating: 4,
    fromRole: 'single',
    fromName: 'Marcus Chen',
    fromEmail: 'marcus.chen@gmail.com',
  },
  {
    channel: 'email',
    type: 'issue',
    status: 'closed',
    subject: 'Billing receipt missing',
    details: 'I did not receive a receipt for last month’s renewal. Card ending 4242.',
    fromRole: 'corporate',
    fromName: 'Elena Vargas',
    fromEmail: 'elena@orbitlabs.com',
    adminReply: 'Resent the receipt to your billing email. Let us know if it still does not arrive.',
  },
  {
    channel: 'ai',
    type: 'help',
    status: 'open',
    subject: 'Custom domain setup stuck',
    details: 'DNS verified but the custom domain still shows pending after 48 hours.',
    fromRole: 'single',
    fromName: 'Sam Okonkwo',
    fromEmail: 'sam@okonkwo.design',
  },
  {
    channel: 'support',
    type: 'system_update',
    status: 'in_progress',
    subject: 'Team card branding colors reset',
    details: 'After yesterday’s update, our brand primary color reverted to default indigo across all employee cards.',
    fromRole: 'corporate',
    fromName: 'Chris Nguyen',
    fromEmail: 'chris@helixgroup.com',
  },
  {
    channel: 'feedback',
    type: 'other',
    status: 'closed',
    subject: 'Thank you for onboarding help',
    details: 'Support walked us through bulk card creation. Everything works smoothly now.',
    rating: 5,
    fromRole: 'corporate',
    fromName: 'Fatima Al-Hassan',
    fromEmail: 'fatima@crescent.media',
    adminReply: 'Glad we could help — reach out anytime.',
  },
] as const

/**
 * Idempotent startup seed: inserts demo support tickets only when the table is empty.
 * Temporary mock data for admin inbox development.
 */
const seedSupportTickets = async (): Promise<void> => {
  const count = await prisma.supportTicket.count()
  if (count > 0) {
    logger.info(`Support ticket seed skipped (${count} existing)`)
    return
  }

  const now = Date.now()
  await prisma.supportTicket.createMany({
    data: MOCK_TICKETS.map((ticket, index) => ({
      ...ticket,
      createdAt: new Date(now - (MOCK_TICKETS.length - index) * 3_600_000),
      updatedAt: new Date(now - (MOCK_TICKETS.length - index) * 1_800_000),
    })),
  })

  logger.info(`Seeded ${MOCK_TICKETS.length} mock support tickets`)
}

export default seedSupportTickets
