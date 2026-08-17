import { test, expect } from 'playwright/test'

import { classifyParentRelation } from '@/components/agency/org-chart'

interface FixtureAgent {
  id: string
  layer: 1 | 2 | 3
  parentId: string | null
}

const fixture = (id: string, layer: FixtureAgent['layer'], parentId: string | null): FixtureAgent => ({
  id,
  layer,
  parentId,
})

test.describe('org-chart parent relations', () => {
  test('keeps roots/orphans explicit and connects valid adjacent layers', () => {
    const root = fixture('root', 1, null)
    const child = fixture('child', 2, 'root')
    const byId = new Map([root, child].map((agent) => [agent.id, agent]))

    expect(classifyParentRelation(root, byId).kind).toBe('root')
    expect(classifyParentRelation(child, byId).kind).toBe('connected')
  })

  test('does not draw a false edge for a missing parent', () => {
    const orphan = fixture('orphan', 3, 'deleted-parent')
    const byId = new Map([[orphan.id, orphan]])

    const relation = classifyParentRelation(orphan, byId)
    expect(relation.kind).toBe('missing-parent')
    expect(relation.parent).toBeNull()
  })

  test('preserves unexpected-layer data as a visible diagnostic relation', () => {
    const parent = fixture('parent', 1, null)
    const child = fixture('child', 3, parent.id)
    const byId = new Map([parent, child].map((agent) => [agent.id, agent]))

    const relation = classifyParentRelation(child, byId)
    expect(relation.kind).toBe('unexpected-layer')
    expect(relation.parent?.id).toBe(parent.id)
  })
})
