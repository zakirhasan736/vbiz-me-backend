import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tallyCorporatePoolCards } from '../utils/corporateCardPool'

describe('tallyCorporatePoolCards', () => {
  it('counts owner cards and linked team cards toward the corporate pool', () => {
    const tallies = tallyCorporatePoolCards(
      ['cesar'],
      [
        { id: 'p1', userId: 'cesar', companyUserId: null },
        { id: 'p2', userId: 'jacky', companyUserId: 'cesar' },
        { id: 'p3', userId: 'other', companyUserId: 'other-corp' },
      ]
    )
    assert.equal(tallies.get('cesar'), 2)
  })

  it('does not double-count when userId and companyUserId are both the corporate owner', () => {
    const tallies = tallyCorporatePoolCards(['cesar'], [{ id: 'p1', userId: 'cesar', companyUserId: 'cesar' }])
    assert.equal(tallies.get('cesar'), 1)
  })

  it('returns 0 for accounts with no matching profiles', () => {
    const tallies = tallyCorporatePoolCards(['cesar'], [{ id: 'p1', userId: 'jacky', companyUserId: null }])
    assert.equal(tallies.get('cesar'), 0)
  })
})
