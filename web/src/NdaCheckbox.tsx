import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { t } from './i18n';

/**
 * "Meet under NDA" on the booking page. Its own chunk: the Radix checkbox
 * stays off the guest entry, and only a workspace that offers an NDA loads it.
 */
export default function NdaCheckbox({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <Label className="flex cursor-pointer items-center gap-3 font-normal leading-normal">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      {t('Meet under NDA')}
    </Label>
  );
}
