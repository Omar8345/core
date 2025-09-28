import { Group } from "../Group"
import { SchematicTracePipelineSolver } from "@tscircuit/schematic-trace-solver"
import type { SchematicTrace } from "circuit-json"
import { computeCrossings } from "./compute-crossings"
import { computeJunctions } from "./compute-junctions"
import Debug from "debug"

const debug = Debug("Group_doInitialSchematicTraceRender")

export function applyTracesFromSolverOutput(args: {
  group: Group<any>
  solver: SchematicTracePipelineSolver
  pinIdToSchematicPortId: Map<string, string>
  userNetIdToSck: Map<string, string>
}) {
  const { group, solver, pinIdToSchematicPortId, userNetIdToSck } = args
  const { db } = group.root!

  // Prefer overlap-corrected traces (produced by traceOverlapShiftSolver)
  // when present. Otherwise fall back to the previous solver outputs.
  const correctedMap = solver.traceOverlapShiftSolver?.correctedTraceMap
  // traceLabelOverlapAvoidanceSolver.getOutput() returns an object with a
  // `traceMap` (Map) and other helpers; use its values when available.
  const fallbackTracesFromLabelSolver =
    solver.traceLabelOverlapAvoidanceSolver?.getOutput().traceMap
  const fallbackTraces = fallbackTracesFromLabelSolver
    ? Array.from(fallbackTracesFromLabelSolver.values())
    : solver.schematicTraceLinesSolver?.solvedTracePaths
  const traces = correctedMap ? Object.values(correctedMap) : fallbackTraces

  const pendingTraces: Array<{
    source_trace_id: string
    edges: SchematicTrace["edges"]
    subcircuit_connectivity_map_key?: string
  }> = []

  debug(
    `Traces inside SchematicTraceSolver output: ${
      Object.values(correctedMap ?? {}).length
    }`,
  )

  for (const solvedTracePath of traces ?? []) {
    const points = solvedTracePath?.tracePath as Array<{
      x: number
      y: number
    }>
    if (!Array.isArray(points) || points.length < 2) {
      debug(
        `Skipping trace ${solvedTracePath?.pinIds.join(",")} because it has less than 2 points`,
      )
      continue
    }

    const edges: SchematicTrace["edges"] = []
    for (let i = 0; i < points.length - 1; i++) {
      edges.push({
        from: { x: points[i]!.x, y: points[i]!.y },
        to: { x: points[i + 1]!.x, y: points[i + 1]!.y },
      })
    }

    // Try to associate with an existing source_trace_id when this is a direct connection
    let source_trace_id: string | null = null
    let subcircuit_connectivity_map_key: string | undefined
    if (
      Array.isArray(solvedTracePath?.pins) &&
      solvedTracePath.pins.length === 2
    ) {
      const pA = pinIdToSchematicPortId.get(solvedTracePath.pins[0]?.pinId!)
      const pB = pinIdToSchematicPortId.get(solvedTracePath.pins[1]?.pinId!)
      if (pA && pB) {
        // Mark ports as connected on schematic
        for (const schPid of [pA, pB]) {
          const existing = db.schematic_port.get(schPid)
          if (existing) db.schematic_port.update(schPid, { is_connected: true })
        }

        subcircuit_connectivity_map_key = userNetIdToSck.get(
          String(solvedTracePath.userNetId),
        )
      }
    }

    if (!source_trace_id) {
      source_trace_id = `solver_${solvedTracePath?.mspPairId!}`
      subcircuit_connectivity_map_key = subcircuit_connectivity_map_key ?? userNetIdToSck.get(
        String(solvedTracePath.userNetId),
      )
    }

    pendingTraces.push({
      source_trace_id,
      edges,
      subcircuit_connectivity_map_key,
    })
  }

  debug(
    `Applying ${pendingTraces.length} traces from SchematicTraceSolver output`,
  )

  // Compute crossings and junctions without relying on DB lookups
  const withCrossings = computeCrossings(
    pendingTraces.map((t) => ({
      source_trace_id: t.source_trace_id,
      edges: t.edges,
    })),
  )

  const junctionsById = computeJunctions(
    withCrossings.map((t) => ({
      source_trace_id: t.source_trace_id,
      edges: t.edges,
      // Preserve the per-trace connectivity key so the junction logic can
      // avoid creating junctions between traces that belong to the same
      // subcircuit/network (this is the behavioral fix from the feature
      // branch).
      subcircuit_connectivity_map_key: pendingTraces.find(
        (p) => p.source_trace_id === t.source_trace_id,
      )?.subcircuit_connectivity_map_key,
    })),
  )

  for (const t of withCrossings) {
    db.schematic_trace.insert({
      source_trace_id: t.source_trace_id,
      edges: t.edges,
      junctions: junctionsById[t.source_trace_id] ?? [],
      subcircuit_connectivity_map_key: pendingTraces.find(
        (p) => p.source_trace_id === t.source_trace_id,
      )?.subcircuit_connectivity_map_key,
    })
  }
}
