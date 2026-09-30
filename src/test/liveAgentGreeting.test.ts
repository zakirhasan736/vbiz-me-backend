import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveLiveAgentGreetingHostName } from '../utils/liveAgentGreeting'

describe('resolveLiveAgentGreetingHostName', () => {
  it('uses corporate company owner for linked cards', () => {
    assert.equal(
      resolveLiveAgentGreetingHostName({
        cardName: 'Linked Teammate',
        user: { name: 'Linked Teammate', role: 'VCARD_OWNER' },
        companyUser: { name: 'Michaelangelo Casanova', role: 'CORPORATE_OWNER' },
      }),
      'Michaelangelo Casanova'
    )
  })

  it('uses corporate account name for corporate-owned cards', () => {
    assert.equal(
      resolveLiveAgentGreetingHostName({
        cardName: 'Michaelangelo Casanova',
        user: { name: 'Michaelangelo Casanova', role: 'CORPORATE_OWNER' },
        companyUser: null,
      }),
      'Michaelangelo Casanova'
    )
  })

  it('uses card name for single owners', () => {
    assert.equal(
      resolveLiveAgentGreetingHostName({
        cardName: 'Jane Owner',
        lastName: null,
        user: { name: 'Jane Owner', role: 'VCARD_OWNER' },
        companyUser: null,
      }),
      'Jane Owner'
    )
  })

  it('ignores non-corporate companyUser (e.g. staff parent)', () => {
    assert.equal(
      resolveLiveAgentGreetingHostName({
        cardName: 'CEO Card',
        user: { name: 'CEO Card', role: 'VCARD_OWNER' },
        companyUser: { name: 'Platform Admin', role: 'SUPER_ADMIN' },
      }),
      'CEO Card'
    )
  })
})
