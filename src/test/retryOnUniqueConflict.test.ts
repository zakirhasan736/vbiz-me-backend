import assert from 'node:assert/strict'
import { test } from 'node:test'
import { retryOnUniqueConflict } from '../utils/prismaErrors'

const uniqueError = () =>
  Object.assign(new Error('Unique constraint failed on the fields: (`"profileId"`, `"endpointHash"`)'), {
    code: 'P2002',
  })

test('a write that loses a unique-key race is retried and succeeds', async () => {
  let calls = 0
  const result = await retryOnUniqueConflict(async () => {
    calls += 1
    if (calls === 1) throw uniqueError()
    return 'saved'
  })
  assert.equal(result, 'saved')
  assert.equal(calls, 2)
})

test('other errors are thrown at once, and a repeated conflict is not retried forever', async () => {
  let calls = 0
  await assert.rejects(
    retryOnUniqueConflict(async () => {
      calls += 1
      throw new Error('connection lost')
    }),
    /connection lost/
  )
  assert.equal(calls, 1)

  calls = 0
  await assert.rejects(
    retryOnUniqueConflict(async () => {
      calls += 1
      throw uniqueError()
    }),
    /Unique constraint/
  )
  assert.equal(calls, 2)
})
