'use client'

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import type { Agent } from '@/lib/missions/types'

export type ParentRelationKind = 'root' | 'connected' | 'unexpected-layer' | 'missing-parent' | 'self-parent'

export interface ParentRelation<T extends Pick<Agent, 'id' | 'layer' | 'parentId'> = Agent> {
  kind: ParentRelationKind
  parentId: string | null
  parent: T | null
}

/**
 * Classify a row's parent without assuming the database is perfectly shaped.
 * A missing parent is rendered as an unlinked/orphaned node; a parent on the
 * wrong layer still gets a visible (dashed) relationship so the UI reflects
 * the stored data instead of silently rewriting it.
 */
export function classifyParentRelation<T extends Pick<Agent, 'id' | 'layer' | 'parentId'>>(
  agent: T,
  agentsById: ReadonlyMap<string, T>,
): ParentRelation<T> {
  if (!agent.parentId) return { kind: 'root', parentId: null, parent: null }

  const parent = agentsById.get(agent.parentId) ?? null
  if (!parent) return { kind: 'missing-parent', parentId: agent.parentId, parent: null }
  if (parent.id === agent.id) return { kind: 'self-parent', parentId: agent.parentId, parent }
  if (parent.layer !== agent.layer - 1) {
    return { kind: 'unexpected-layer', parentId: agent.parentId, parent }
  }
  return { kind: 'connected', parentId: agent.parentId, parent }
}

interface Connector {
  childId: string
  parentId: string
  path: string
  unexpectedLayer: boolean
}

interface OrgChartProps<T extends Agent> {
  agents: readonly T[]
  layerLabels: Readonly<Record<T['layer'], string>>
  layerDescriptions: Readonly<Record<T['layer'], string>>
  layers: readonly T['layer'][]
  renderCard: (agent: T, relation: ParentRelation<T>) => ReactNode
}

/**
 * Layered display with relationship lines overlaid in a lightweight SVG. The
 * cards remain normal DOM, so links/buttons/selects keep their existing
 * behavior and the SVG never intercepts pointer events.
 */
export function OrgChart<T extends Agent>({
  agents,
  layerLabels,
  layerDescriptions,
  layers,
  renderCard,
}: OrgChartProps<T>) {
  const chartRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())
  const [connectors, setConnectors] = useState<Connector[]>([])

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
  const relations = new Map(
    agents.map((agent) => [agent.id, classifyParentRelation(agent, agentsById)]),
  )

  useLayoutEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const measure = () => {
      const chartRect = chart.getBoundingClientRect()
      const next: Connector[] = []

      for (const child of agents) {
        const relation = relations.get(child.id)
        if (!relation?.parent || !relation.parentId || relation.kind === 'self-parent') continue

        const parentEl = cardRefs.current.get(relation.parent.id)
        const childEl = cardRefs.current.get(child.id)
        if (!parentEl || !childEl) continue

        const parentRect = parentEl.getBoundingClientRect()
        const childRect = childEl.getBoundingClientRect()
        const startX = parentRect.left - chartRect.left + parentRect.width / 2
        const startY = parentRect.bottom - chartRect.top
        const endX = childRect.left - chartRect.left + childRect.width / 2
        const endY = childRect.top - chartRect.top
        const bendY = startY + (endY - startY) / 2

        next.push({
          childId: child.id,
          parentId: relation.parent.id,
          path: `M ${startX} ${startY} C ${startX} ${bendY}, ${endX} ${bendY}, ${endX} ${endY}`,
          unexpectedLayer: relation.kind === 'unexpected-layer',
        })
      }

      setConnectors(next)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(chart)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
    // The relation map is derived from agents and card refs are populated by
    // this render before layout effects run. Re-measure whenever the data set
    // changes; ResizeObserver handles container/card reflow afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents])

  return (
    <div ref={chartRef} className="relative" data-org-chart>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible text-foreground/25"
        data-org-chart-connectors
      >
        {connectors.map((connector) => (
          <path
            key={`${connector.parentId}-${connector.childId}`}
            d={connector.path}
            fill="none"
            stroke="currentColor"
            strokeDasharray={connector.unexpectedLayer ? '5 5' : undefined}
            strokeLinecap="round"
            strokeOpacity={connector.unexpectedLayer ? 0.35 : 0.3}
            strokeWidth="2.5"
            data-org-connector
            data-child-id={connector.childId}
            data-parent-id={connector.parentId}
          />
        ))}
      </svg>

      <div className="relative z-10 space-y-9">
        {layers.map((layer) => {
          const layerAgents = agents.filter((agent) => agent.layer === layer)
          return (
            <section key={layer} data-org-layer={layer}>
              <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="font-mono text-sm uppercase tracking-wide leading-6 text-foreground">
                  layer {layer} · {layerLabels[layer]}
                </h2>
                <span className="font-mono text-[11px] leading-5 text-muted-foreground">
                  {layerDescriptions[layer]}
                </span>
              </div>
              {layerAgents.length === 0 ? (
                <p className="font-mono text-[11px] leading-5 text-muted-foreground">
                  no agents registered at this layer
                </p>
              ) : (
                <div className="flex flex-wrap gap-4">
                  {layerAgents.map((agent) => {
                    const relation = relations.get(agent.id)!
                    return (
                      <div
                        key={agent.id}
                        ref={(element) => {
                          if (element) cardRefs.current.set(agent.id, element)
                          else cardRefs.current.delete(agent.id)
                        }}
                        className="relative z-10"
                        data-org-chart-node
                        data-org-chart-state={relation.kind}
                        data-agent-id={agent.id}
                      >
                        {renderCard(agent, relation)}
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
