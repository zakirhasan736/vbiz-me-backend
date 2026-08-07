import PDFDocument from 'pdfkit'
import type { SocialChannel } from './dashboardAnalytics'

export type DashboardOverviewForPdf = {
  cards: number
  totalViews: number
  viewsLast30Days: number
  contactsLast30Days: number
  notesLast30Days: number
  guestsLast30Days: number
  visitsChart: {
    total: number
    trendPercent: number
    points: Array<{ name: string; total: number }>
  }
  socialChannels: Array<{
    channel: SocialChannel
    label: string
    count: number
    trendPercent: number
  }>
  recentEngagement: Array<{
    id: string
    event: string
    viewer: string
    time: string
    platform: string
    createdAt: string
  }>
}

function formatTrend(value: number): string {
  if (value > 0) return `+${value}%`
  if (value < 0) return `${value}%`
  return '0%'
}

export async function buildOverviewPdf(stats: DashboardOverviewForPdf): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' })
    const chunks: Buffer[] = []

    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const contactsSaved = (stats.contactsLast30Days || 0) + (stats.guestsLast30Days || 0)

    doc.fontSize(20).fillColor('#0f172a').text('vBiz Me — Overview Report', { align: 'left' })
    doc.moveDown(0.3)
    doc.fontSize(10).fillColor('#64748b').text(`Generated ${new Date().toLocaleString()} · Last 30 Days`)
    doc.moveDown(1)

    doc.fontSize(14).fillColor('#0f172a').text('Summary')
    doc.moveDown(0.4)
    doc.fontSize(11).fillColor('#334155')
    const summaryLines = [
      `Cards: ${stats.cards}`,
      `Total views: ${stats.totalViews}`,
      `Views (30d): ${stats.viewsLast30Days}`,
      `Notes (30d): ${stats.notesLast30Days}`,
      `Contacts saved (30d): ${contactsSaved}`,
      `Website visits (30d): ${stats.visitsChart.total} (${formatTrend(stats.visitsChart.trendPercent)})`,
    ]
    for (const line of summaryLines) {
      doc.text(line)
    }

    doc.moveDown(1)
    doc.fontSize(14).fillColor('#0f172a').text('Website Visits (daily)')
    doc.moveDown(0.4)
    doc.fontSize(9).fillColor('#475569')
    const nonZero = stats.visitsChart.points.filter((p) => p.total > 0)
    const chartRows = nonZero.length > 0 ? nonZero : stats.visitsChart.points.slice(-7)
    for (const point of chartRows) {
      doc.text(`${point.name}: ${point.total}`)
    }

    doc.moveDown(1)
    doc.fontSize(14).fillColor('#0f172a').text('Social Engagement Channels')
    doc.moveDown(0.4)
    doc.fontSize(11).fillColor('#334155')
    for (const channel of stats.socialChannels) {
      doc.text(`${channel.label}: ${channel.count} (${formatTrend(channel.trendPercent)})`)
    }

    doc.moveDown(1)
    doc.fontSize(14).fillColor('#0f172a').text('Recent Engagement')
    doc.moveDown(0.4)

    if (stats.recentEngagement.length === 0) {
      doc.fontSize(11).fillColor('#64748b').text('No recent engagement events.')
    } else {
      doc.fontSize(9).fillColor('#475569')
      for (const row of stats.recentEngagement) {
        doc.text(`${row.event} · ${row.viewer} · ${row.time} · ${row.platform}`)
      }
    }

    doc.end()
  })
}
