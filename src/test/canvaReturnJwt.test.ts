import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveCanvaFieldPreset } from '../services/canva/canva.fieldPresets'
import { assertCorrelationClaims } from '../services/canva/canva.returnJwt'

describe('assertCorrelationClaims', () => {
  it('accepts a valid rti payload', () => {
    const claims = assertCorrelationClaims({
      type: 'rti',
      sub: 'user_1',
      team_id: 'team_1',
      design_id: 'DAF123',
      correlation_state: 'abc123',
      jti: 'jti_1',
      aud: 'client_id',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    assert.equal(claims.design_id, 'DAF123')
    assert.equal(claims.correlation_state, 'abc123')
  })

  it('rejects wrong type', () => {
    assert.throws(() =>
      assertCorrelationClaims({
        type: 'other',
        sub: 'user_1',
        team_id: 'team_1',
        design_id: 'DAF123',
        correlation_state: 'abc123',
        jti: 'jti_1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    )
  })
})

describe('resolveCanvaFieldPreset', () => {
  it('maps logo fields to square PNG', () => {
    const preset = resolveCanvaFieldPreset({ fieldKey: 'Business Logo' })
    assert.equal(preset.exportFormat, 'png')
    assert.equal(preset.width, preset.height)
  })

  it('maps intro video to mp4', () => {
    const preset = resolveCanvaFieldPreset({ attachmentType: 'Intro vCard Video', mediaKind: 'video' })
    assert.equal(preset.exportFormat, 'mp4')
    assert.equal(preset.mediaKind, 'video')
  })
})
