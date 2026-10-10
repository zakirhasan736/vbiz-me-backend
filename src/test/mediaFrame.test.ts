import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { metasWithoutMediaFrame, parseStoredMediaFrame, readRowMediaFrame } from '../utils/mediaFrame'

describe('mediaFrame', () => {
  it('returns null when no crop is stored', () => {
    assert.equal(parseStoredMediaFrame(null), null)
    assert.equal(parseStoredMediaFrame({}), null)
    assert.equal(parseStoredMediaFrame(''), null)
  })

  it('clamps a dragged crop', () => {
    const frame = parseStoredMediaFrame({ focusX: 140, focusY: -4, zoom: 9, height: 0.1 })
    assert.deepEqual(frame, { focusX: 100, focusY: 0, zoom: 2.5, height: 0.7 })
  })

  it('reads a crop from the column or from metas', () => {
    assert.deepEqual(readRowMediaFrame({ mediaFrame: { focusX: 10, focusY: 20 } }), {
      focusX: 10,
      focusY: 20,
      zoom: 1,
      height: 1,
    })
    assert.deepEqual(readRowMediaFrame({ metas: { mediaFrame: { focusX: 80, focusY: 30 }, category: 'News' } }), {
      focusX: 80,
      focusY: 30,
      zoom: 1,
      height: 1,
    })
    assert.deepEqual(metasWithoutMediaFrame({ mediaFrame: { focusX: 1 }, category: 'News' }), { category: 'News' })
  })
})
