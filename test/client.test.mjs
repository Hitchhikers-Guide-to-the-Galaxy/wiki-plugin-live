import { test } from 'node:test'
import assert from 'node:assert/strict'

const { live } = await import('../client/main.js')

test('item text: NAMES, LANGUAGES, MIC, and the rest is caption', () => {
  const s = live.parse('NAMES: Aycan, Anna Maria , Berk\nLANGUAGES Turkish, English\nMIC: USB Mic\nThe first session.')
  assert.deepEqual(s.names, ['Aycan', 'Anna Maria', 'Berk'])
  assert.deepEqual(s.languages, ['Turkish', 'English'])
  assert.equal(s.mic, 'USB Mic')
  assert.deepEqual(s.caption, ['The first session.'])
})

test('an empty item offers six speakers and two languages', () => {
  const s = live.parse('')
  assert.equal(s.names.length, 6)
  assert.deepEqual(s.languages, ['Turkish', 'English'])
})

test('clock reads minutes and tenths, hours when there are any', () => {
  assert.equal(live.clock(754.24), '12:34.2')
  assert.equal(live.clock(3754.2), '1:02:34.2')
  assert.equal(live.clock(null), '–')
})
