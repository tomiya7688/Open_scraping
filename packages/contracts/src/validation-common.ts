// Cycle diagnostics shared by component bindings and node dependencies.
export function detectDirectedCycle(
  vertices: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>
): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  function visit(vertex: string): string[] | undefined {
    const current = state.get(vertex) ?? 0;
    if (current === 2) return undefined;
    if (current === 1) {
      const start = stack.lastIndexOf(vertex);
      return [...stack.slice(Math.max(0, start)), vertex];
    }

    state.set(vertex, 1);
    stack.push(vertex);

    for (const dependency of edges.get(vertex) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }

    stack.pop();
    state.set(vertex, 2);
    return undefined;
  }

  for (const vertex of vertices) {
    const cycle = visit(vertex);
    if (cycle) return cycle;
  }

  return undefined;
}
