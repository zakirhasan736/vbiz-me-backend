import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const read = (file: string) => readFileSync(path.join(process.cwd(), 'src', 'services', file), 'utf8')

describe('one push per device per event', () => {
  it('sendToProfile always dedupes by endpoint, even when the caller passes no seen set', () => {
    const push = read('push.service.ts')
    assert.match(push, /const seen = options\?\.seenEndpoints \?\? new Set<string>\(\)/)
    assert.match(push, /seen\.add\(sub\.endpoint\)\n\s*if \(await sendOne\(sub, payload\)\)/)
  })

  it("multi-card sends share one seen set (group meetings, all of a user's cards, leads with several cards)", () => {
    assert.match(read('push.service.ts'), /const notifyProfilesOnce = \(/)
    for (const file of ['meeting.service.ts', 'crmReminder.service.ts', 'exactOwnerNotify.service.ts']) {
      const source = read(file)
      assert.match(source, /notifyProfilesOnce\(/, `${file} should use notifyProfilesOnce`)
      assert.doesNotMatch(
        source,
        /for \(const [a-zA-Z]+ of [^\n]+\) \{\n\s*pushService\.notifyProfileUpdate\(/,
        `${file} must not loop notifyProfileUpdate per card (duplicates on shared devices)`
      )
    }
  })

  it('exact-owner pushes carry a stable eventId so devices collapse repeats', () => {
    assert.match(read('exactOwnerNotify.service.ts'), /eventId: opts\.push\.eventId \|\| eventKey/)
  })
})
