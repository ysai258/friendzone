import { describe, expect, it } from 'vitest'
import { matchAnswer, meldKey, normalizeAnswer, SYNONYM_GROUPS } from './index.ts'

/**
 * Answer comparison. Two different jobs with two different rules, and the
 * tests are written to keep them apart: matchAnswer judges a guess against a
 * known title and forgives typos; meldKey clusters players against each other
 * and never does.
 */

describe('normalizeAnswer', () => {
  it('folds case, punctuation, accents and a leading article', () => {
    expect(normalizeAnswer('  Thé   Dark-Knight!! ')).toBe('dark knight')
    expect(normalizeAnswer('Salt & Pepper')).toBe('salt and pepper')
  })

  it('removes only one leading article', () => {
    expect(normalizeAnswer('The The Wall')).toBe('the wall')
  })
})

describe('meldKey', () => {
  const groupsWith = (...answers: string[]): number => new Set(answers.map(meldKey)).size

  it('ignores case, punctuation and word order', () => {
    expect(groupsWith('Hot Coffee', 'coffee, hot', 'COFFEE HOT!')).toBe(1)
  })

  it('merges plurals and gerunds with their base word', () => {
    for (const [a, b] of [
      ['sleep', 'sleeping'],
      ['movie', 'movies'],
      ['phone', 'phones'],
      ['coffee', 'coffees'],
      ['city', 'cities'],
      ['party', 'parties'],
      ['glass', 'glasses'],
      ['run', 'running'],
    ]) {
      expect(groupsWith(a!, b!), `${a!} and ${b!}`).toBe(1)
    }
  })

  it('merges answers that mean the same thing', () => {
    expect(groupsWith('phone', 'mobile', 'cell phone', 'Mobile Phone', 'smartphone')).toBe(1)
    expect(groupsWith('tea', 'chai')).toBe(1)
    expect(groupsWith('tv', 'television', 'Telly')).toBe(1)
    expect(groupsWith('ac', 'air conditioner', 'Air Conditioning')).toBe(1)
    expect(groupsWith('bathroom', 'toilet', 'washroom', 'restroom')).toBe(1)
    expect(groupsWith('mom', 'mother', 'amma', 'mummy')).toBe(1)
    expect(groupsWith('biryani', 'biriyani')).toBe(1)
    expect(groupsWith('idli', 'idly')).toBe(1)
    expect(groupsWith('movie', 'film', 'cinema')).toBe(1)
  })

  it('keeps genuinely different answers apart', () => {
    // The failure that would matter most: a fold so eager that choosing
    // between two answers stops meaning anything.
    expect(groupsWith('tea', 'coffee')).toBe(2)
    expect(groupsWith('mom', 'dad')).toBe(2)
    expect(groupsWith('dosa', 'idli')).toBe(2)
    expect(groupsWith('bike', 'car')).toBe(2)
    expect(groupsWith('veg', 'nonveg')).toBe(2)
    expect(groupsWith('rice', 'roti')).toBe(2)
    expect(groupsWith('phone', 'laptop')).toBe(2)
  })

  it('does not forgive typos, because clustering cannot', () => {
    // matchAnswer may; this must not. Fuzzy clustering is not transitive, so
    // the groups would depend on submission order.
    expect(groupsWith('pizza', 'pizzza')).toBe(2)
    expect(matchAnswer('pizzza', ['pizza']).correct).toBe(true)
  })

  it('is empty for an answer with nothing in it', () => {
    expect(meldKey('   !!!   ')).toBe('')
  })

})

describe('the synonym dictionary', () => {
  it('lists every word in exactly one group', () => {
    // A word in two groups would fold according to whichever was read first.
    const owner = new Map<string, string>()
    const duplicates: string[] = []
    for (const group of SYNONYM_GROUPS) {
      const leader = group[0]!
      for (const variant of group) {
        const word = normalizeAnswer(variant)
        const previous = owner.get(word)
        if (previous !== undefined && previous !== leader) {
          duplicates.push(`${word}: in "${previous}" and "${leader}"`)
        }
        owner.set(word, leader)
      }
    }
    expect(duplicates).toEqual([])
  })

  it('folds every variant onto its group leader', () => {
    const wrong: string[] = []
    for (const group of SYNONYM_GROUPS) {
      const canonical = meldKey(group[0]!)
      for (const variant of group.slice(1)) {
        if (meldKey(variant) !== canonical) wrong.push(`${variant} -> ${meldKey(variant)}, expected ${canonical}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('never merges two groups into one key', () => {
    const keys = SYNONYM_GROUPS.map((group) => meldKey(group[0]!))
    expect(new Set(keys).size).toBe(keys.length)
  })
})
