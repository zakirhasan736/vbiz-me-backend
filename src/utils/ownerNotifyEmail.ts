import config from '../configs/config'
import type { OwnerBackofficeArea } from './pushOwnerDeepLink'

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Absolute back-office / app URL for email CTAs. */
export function absoluteFrontendUrl(path?: string | null): string {
  const base = (config.FRONTEND_URL || 'https://vbiz.me').replace(/\/$/, '')
  const raw = String(path || '/').trim() || '/'
  if (/^https?:\/\//i.test(raw)) return raw
  return `${base}${raw.startsWith('/') ? raw : `/${raw}`}`
}

/** Human label for the destination area shown in email + push. */
export function notifyAreaLabel(href?: string | null, topic?: 'card' | 'crm' | null): string {
  const value = String(href || '').trim()
  if (!value) return topic === 'crm' ? 'CRM' : 'Back office'

  try {
    const url = value.startsWith('http') ? new URL(value) : new URL(value, 'https://vbiz.me')
    const path = url.pathname || '/'
    const tab = (url.searchParams.get('tab') || '').toLowerCase()
    const contacts = url.searchParams.has('contacts')

    if (contacts && tab === 'notes') return 'Contact Saves · Lead Notes'
    if (contacts) return 'Contact Saves'
    if (path.startsWith('/crm')) {
      if (tab === 'leads') return 'CRM · Leads'
      if (tab === 'calendar' || tab === 'schedules' || tab === 'schedule') return 'CRM · Schedules'
      if (tab === 'events' || tab === 'wish') return 'CRM · Wish & Outreach'
      if (tab === 'work_notes' || tab === 'notes') return 'CRM · Notes'
      return 'CRM'
    }
    if (path.startsWith('/vcards/edit')) return 'Card editor'
    if (path.startsWith('/admin')) return 'Admin'
  } catch {
    /* fall through */
  }

  return topic === 'crm' ? 'CRM' : 'Back office'
}

export function notifyTopicLabel(topic?: 'card' | 'crm' | null): string {
  return topic === 'crm' ? 'CRM alert' : 'Card back-office alert'
}

export type OwnerNotifyEmailDetail = { label: string; value: string }

/**
 * Specific owner / admin email: identity title, clear topic, detail rows, area + deep link CTA.
 * Push works when tabs are closed; email carries the same responsible identity + area link.
 */
export function buildOwnerNotifyEmailHtml(input: {
  greetingName: string
  title: string
  body: string
  topic?: 'card' | 'crm' | null
  href?: string | null
  cardName?: string | null
  details?: OwnerNotifyEmailDetail[]
  ctaLabel?: string
}): string {
  const area = notifyAreaLabel(input.href, input.topic)
  const topicLabel = notifyTopicLabel(input.topic)
  const ctaUrl = absoluteFrontendUrl(input.href || (input.topic === 'crm' ? '/crm' : '/'))
  const ctaLabel = input.ctaLabel?.trim() || `Open ${area}`

  const detailRows = [
    ...(input.cardName?.trim() ? [{ label: 'Card', value: input.cardName.trim() }] : []),
    ...(input.details || []),
    { label: 'Area', value: area },
    { label: 'Topic', value: topicLabel },
  ]
    .filter((d) => d.value.trim())
    .map(
      (d) =>
        `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;width:130px;vertical-align:top">${escapeHtml(d.label)}</td><td style="padding:6px 0;color:#0f172a;font-size:14px;font-weight:600">${escapeHtml(d.value)}</td></tr>`
    )
    .join('')

  return `<div style="margin:0 auto;max-width:640px;font-family:Arial,sans-serif;color:#172033;line-height:1.6">
    <p>Hello ${escapeHtml(input.greetingName.trim() || 'there')},</p>
    <p style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#0f766e">${escapeHtml(topicLabel)}</p>
    <h2 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#0f172a">${escapeHtml(input.title)}</h2>
    <p style="margin:0 0 16px;color:#334155">${escapeHtml(input.body)}</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 16px;padding:12px 0;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0">${detailRows}</table>
    <p style="margin:20px 0 8px"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:12px 18px;background:#0f766e;color:#fff;text-decoration:none;border-radius:10px;font-weight:700">${escapeHtml(ctaLabel)}</a></p>
    <p style="font-size:12px;color:#94a3b8">This alert is for your responsible ${escapeHtml(area)} area. Open the link in vBiz Me anytime — backoffice does not need to be open.</p>
    <p style="font-size:12px;color:#94a3b8">— vBiz Me</p>
  </div>`
}

/** Map owner deep-link area to a short email subject prefix. */
export function emailSubjectForArea(area: OwnerBackofficeArea | string, title: string): string {
  const labels: Record<string, string> = {
    contacts: 'Contact Saves',
    contact_notes: 'Lead Notes',
    leads: 'CRM Leads',
    calendar: 'CRM Schedules',
    wish: 'CRM Wish',
    crm_notes: 'CRM Notes',
    one_on_one: '1-on-1',
    card_home: 'Card',
  }
  const prefix = labels[area] || notifyAreaLabel(typeof area === 'string' && area.startsWith('/') ? area : null)
  return `${prefix}: ${title}`
}
