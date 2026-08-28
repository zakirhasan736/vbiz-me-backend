import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ADMIN_TEAM_CARD_SLUGS, buildAdminTeamCardsScopeWhere } from '../constants/adminTeamCards'

describe('adminTeamCards', () => {
  it('lists exactly eight VBizMe team portfolio slugs', () => {
    assert.equal(ADMIN_TEAM_CARD_SLUGS.length, 8)
    assert.deepEqual(
      [...ADMIN_TEAM_CARD_SLUGS],
      [
        'ryan-aldrich',
        'tj-desjardins',
        'julia-rose',
        'mila',
        'ryan',
        'billy-toolen',
        'michaelangelo-casanova-2',
        'michaelanglo-casanova',
      ]
    )
  })

  it('scopes Team Cards to slug allowlist only', () => {
    assert.deepEqual(buildAdminTeamCardsScopeWhere(), {
      slug: {
        in: [...ADMIN_TEAM_CARD_SLUGS],
        mode: 'insensitive',
      },
    })
  })
})
