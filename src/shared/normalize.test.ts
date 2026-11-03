import { expect, test } from 'vitest'
import { normalizeTerm, queryTerms, parseQuery } from './normalize'

test('preserves Danish letters at word boundaries', () => {
  expect(normalizeTerm('(Øvre)')).toBe('øvre')
  expect(normalizeTerm('BLÅ.')).toBe('blå')
  expect(queryTerms('Ændring af små rør')).toEqual(['ændring', 'små', 'rør'])
  expect(normalizeTerm('på')).toBeNull()
})

test('parses weighted expressions separately from mandatory literal phrases', () => {
  expect(parseQuery('byggeplads *16 A* *stikkontakt* "IP 44"')).toEqual({
    unquoted: 'byggeplads 16 A stikkontakt', boosted: ['16 A', 'stikkontakt'], phrases: ['IP 44'], valid: true
  })
  expect(parseQuery('"*16 A*"').boosted).toEqual([])
  expect(parseQuery('"*16 A*"').phrases).toEqual(['*16 A*'])
  expect(parseQuery('byggeplads *16 A').valid).toBe(false)
  expect(parseQuery('*16 "A"*').valid).toBe(false)
  expect(parseQuery('"16 A').valid).toBe(false)
})
