/**
 * Emails used for 1-on-1 / schedule / CRM owner notices.
 *
 * Prefer the card's public contact email over login User.email.
 * Login addresses are often stale and cause Zoho → Gmail 550
 * "mailbox does not exist" bounce loops back to info@vbizme.com.
 *
 * Exact identity (default): never CC the corporate parent on a member card.
 * Pair with meta.userId / meta.profileId on inbox notices so the backoffice
 * bell matches the direct card owner even when contact emails are shared.
 */
export function collectProfileNotificationEmails(input: {
  profileEmail?: string | null
  userEmail?: string | null
  companyUserEmail?: string | null
  /**
   * When true, also include the corporate parent email.
   * Default false — member-card alerts must not leak into the corporate inbox.
   */
  includeCompanyUser?: boolean
}): string[] {
  const normalize = (value?: string | null) => value?.trim().toLowerCase() || ''
  const card = normalize(input.profileEmail)
  const company = normalize(input.companyUserEmail)
  const login = normalize(input.userEmail)

  const emails: string[] = []
  if (card) emails.push(card)
  // Only fall back to login email when the card has no contact email.
  if (!card && login && !emails.includes(login)) emails.push(login)
  // Orphan corporate-owned card with no member login / contact email.
  if (!emails.length && company) emails.push(company)
  if (input.includeCompanyUser && company && !emails.includes(company)) {
    emails.push(company)
  }
  return emails
}

/** Direct owner account id for inbox meta — member login first, else corporate parent. */
export function resolveDirectOwnerUserId(input: {
  userId?: string | null
  companyUserId?: string | null
}): string | null {
  return input.userId?.trim() || input.companyUserId?.trim() || null
}
