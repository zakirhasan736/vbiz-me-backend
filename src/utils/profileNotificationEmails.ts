/**
 * Emails used for 1-on-1 / schedule / CRM owner notices.
 *
 * Prefer the card's public contact email over login User.email.
 * Login addresses are often stale and cause Zoho → Gmail 550
 * "mailbox does not exist" bounce loops back to info@vbizme.com.
 */
export function collectProfileNotificationEmails(input: {
  profileEmail?: string | null
  userEmail?: string | null
  companyUserEmail?: string | null
}): string[] {
  const normalize = (value?: string | null) => value?.trim().toLowerCase() || ''
  const card = normalize(input.profileEmail)
  const company = normalize(input.companyUserEmail)
  const login = normalize(input.userEmail)

  const emails: string[] = []
  if (card) emails.push(card)
  if (company && !emails.includes(company)) emails.push(company)
  // Only fall back to login email when the card has no contact email.
  if (!card && login && !emails.includes(login)) emails.push(login)
  return emails
}
