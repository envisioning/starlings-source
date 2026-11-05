import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';

/**
 * One choice from a short row of filters: shadcn ToggleGroup, single value.
 * Tab reaches the group at the chosen item; the arrow keys move inside it.
 * A press on the chosen item keeps it chosen, because a filter always has a
 * value. Radix, so lazy surfaces only (web/vite.config.ts).
 */
export function SegmentedFilter<V extends string>({ label, value, options, onChange, className }: {
  label: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  onChange: (value: V) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label={label}
      className={className}
      value={value}
      onValueChange={(next) => {
        const option = options.find((row) => row.value === next);
        if (option) onChange(option.value);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} className="data-[state=on]:bg-secondary data-[state=on]:text-secondary-foreground">
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
