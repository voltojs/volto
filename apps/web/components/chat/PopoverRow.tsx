/**
 * One "label — value" row inside a stats popover. A null value drops the
 * whole row rather than rendering an empty cell: "no such number" and "this
 * number is zero" are different facts. Shared by the per-round usage chip,
 * the conversation usage chip and the session stats chip.
 */
export function PopoverRow({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  if (value === null) return null;
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      {/* Truncate, never wrap: long values stay on one line and the panel
          grows to fit up to its max width. */}
      <span className="min-w-0 truncate font-mono">{value}</span>
    </li>
  );
}
