import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RULE_PREFIXES, parseRoutingLine } from '../src/shared/routingRules'

const docs = readFileSync(join(__dirname, '..', 'docs', 'routing.md'), 'utf8')

/** The lines of every ```routing-lines block in docs/routing.md. */
const blocks = [...docs.matchAll(/```routing-lines\n([\s\S]*?)```/g)].map((m) => m[1].split('\n'))

describe('docs/routing.md', () => {
  it('has examples, and every line of every example parses', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(5)
    for (const lines of blocks) {
      for (const line of lines) {
        expect(parseRoutingLine(line).error, line).toBeUndefined()
      }
    }
  })

  it('names every prefix the parser knows', () => {
    for (const prefix of RULE_PREFIXES) expect(docs, prefix).toContain(`\`${prefix}:\``)
  })

  it('describes the two lists and the rules', () => {
    for (const word of ['«Через VPN»', '«В обход VPN»', '«Продвинутые»', '«Всё остальное»', '«Программы»']) expect(docs, word).toContain(word)
  })
})
