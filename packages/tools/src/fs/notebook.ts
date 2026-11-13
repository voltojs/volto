interface NotebookCell {
  cell_type: string;
  source: string[] | string;
  outputs?: Array<{ output_type: string; text?: string[] | string; data?: Record<string, unknown> }>;
}

const joinSource = (s: string[] | string | undefined): string =>
  Array.isArray(s) ? s.join("") : (s ?? "");

/**
 * Render a notebook as numbered cells with their outputs. Outputs matter as
 * much as the code: a cell's error trace is usually why the file is being
 * read at all.
 */
export function formatNotebook(raw: string): string {
  const nb = JSON.parse(raw) as { cells?: NotebookCell[] };
  const cells = nb.cells ?? [];
  return cells
    .map((cell, i) => {
      const head = `[cell ${i + 1} · ${cell.cell_type}]`;
      const body = joinSource(cell.source);
      const outputs = (cell.outputs ?? [])
        .map((o) => {
          const text = joinSource(o.text);
          if (text) return `  out: ${text.trimEnd()}`;
          const keys = Object.keys(o.data ?? {}).join(", ");
          return keys ? `  out: [${o.output_type}: ${keys}]` : `  out: [${o.output_type}]`;
        })
        .join("\n");
      return outputs ? `${head}\n${body}\n${outputs}` : `${head}\n${body}`;
    })
    .join("\n\n");
}
