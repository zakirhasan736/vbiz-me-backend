import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ADMIN_TEAM_CARD_SLUGS, buildAdminTeamCardsScopeWhere } from '../constants/adminTeamCards'

describe('adminTeamCards', () => {
  it('lists the curated VBizMe team portfolio slugs', () => {
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

  it('includes curated slugs and admin-assigned portfolio cards for Team Cards scope', () => {
    assert.deepEqual(buildAdminTeamCardsScopeWhere(['admin-1']), {
      OR: [
        {
          slug: {
            in: [...ADMIN_TEAM_CARD_SLUGS],
            mode: 'insensitive',
          },
        },
        { companyUserId: { in: ['admin-1'] } },
      ],
    })
  })

  it('keeps slug allowlist when no staff ids are available', () => {
    assert.deepEqual(buildAdminTeamCardsScopeWhere({ length: 0 } as string[]), {
      OR: [
        {
          slug: {
            in: [...ADMIN_TEAM_CARD_SLUGS],
            mode: 'insensitive',
          },
        },
      ],
    })
  })
})
