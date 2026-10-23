/**
 * Back-office deep links for owner push + in-app notifications.
 * Keep paths relative so the web push SW can open the same origin.
 */

export type OwnerBackofficeArea =
  'contacts' | 'contact_notes' | 'leads' | 'calendar' | 'wish' | 'crm_notes' | 'card_home' | 'one_on_one'

/** Dashboard / CRM destinations for exact card-owner alerts. */
export function buildOwnerBackofficePath(area: OwnerBackofficeArea, profileId?: string | null): string {
  switch (area) {
    case 'contacts':
      return '/?contacts=1'
    case 'contact_notes':
      return '/?contacts=1&tab=notes'
    case 'leads':
      return '/crm?tab=leads'
    case 'calendar':
      return '/crm?tab=calendar'
    case 'wish':
      return '/crm?tab=events'
    case 'crm_notes':
      return '/crm?tab=work_notes'
    case 'one_on_one':
      return profileId?.trim() ? `/vcards/edit/home/${profileId.trim()}` : '/crm?tab=calendar'
    case 'card_home':
      return profileId?.trim() ? `/vcards/edit/home/${profileId.trim()}` : '/'
    default:
      return '/'
  }
}
