export interface SearchablePickerOption {
  id: string;
  title: string;
  context?: string;
  subtitle?: string | null;
  isStarred?: boolean;
  color?: string;
  /** A heading the option sits under; options of one group come together. */
  group?: string;
}

export function searchablePickerMatches(option: SearchablePickerOption, query: string): boolean {
  const needle = fold(query.trim());
  if (!needle) return true;
  return fold([option.title, option.context, option.subtitle].filter(Boolean).join(' ')).includes(needle);
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
}
