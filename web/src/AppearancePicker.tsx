import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Label } from '@/ui/label';
import { useThemePreference, type ThemePreference } from './theme';
import { t } from './i18n';

const OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'auto', label: t('Auto') },
  { value: 'light', label: t('Light') },
  { value: 'dark', label: t('Dark') },
];

/** A small picker row: the muted name, then its select. Appearance and Language. */
export const PICKER_LABEL = 'inline-flex items-center gap-[7px] text-[12px] text-muted-foreground font-normal leading-normal';

export function AppearancePicker() {
  const [preference, setPreference] = useThemePreference();

  return (
    <Label className={PICKER_LABEL} htmlFor="site-appearance">
      <span>{t('Appearance')}</span>
      <NativeSelect
        id="site-appearance"
        className="py-0"
        value={preference}
        onChange={(event) => setPreference(event.target.value as ThemePreference)}
        aria-label={t('Appearance')}
      >
        {OPTIONS.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>
        ))}
      </NativeSelect>
    </Label>
  );
}
