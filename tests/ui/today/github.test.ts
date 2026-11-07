import { describe, expect, test } from 'bun:test'
import { linkHasNext } from '../../../src/today/github'

describe('linkHasNext', () => {
  test('detects rel="next" in either quote style', () => {
    expect(linkHasNext('<https://x?page=2>; rel="next", <https://x?page=9>; rel="last"')).toBe(true)
    expect(linkHasNext("<https://x?page=2>; rel='next'")).toBe(true)
  })

  test('null or last-only headers mean no next page', () => {
    expect(linkHasNext(null)).toBe(false)
    expect(linkHasNext('<https://x?page=9>; rel="last"')).toBe(false)
  })
})
