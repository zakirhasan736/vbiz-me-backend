import { isStaffRole } from '../constants/userRole'

/**
 * After a card is removed, retire the login that owned it when that person has no cards left.
 * Corporate owners and staff stay, because they manage other cards from the same account.
 */
export function shouldRetireCardLogin(input: { role: string | null | undefined; remainingCards: number }): boolean {
  if (input.remainingCards > 0) return false
  const role = (input.role || '').trim().toLowerCase()
  if (role !== 'vcard-owner') return false
  if (isStaffRole(role)) return false
  return true
}
