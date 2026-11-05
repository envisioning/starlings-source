import { t } from './i18n';
type CountryFlagProps = {
  country?: string | null;
  className?: string;
};

/** ISO alpha-2 code normalisation shared by every browser flag use. */
export function normalizedCountryCode(country: string | null | undefined): string | null {
  const code = country?.trim().toLowerCase() ?? '';
  return /^[a-z]{2}$/u.test(code) ? code : null;
}

/**
 * A local SVG flag from flag-icons. This is an image, not a Unicode emoji, so
 * the artwork is stable across browsers and follows Meet's no-emoji UI rule.
 */
export function CountryFlag({ country, className = '' }: CountryFlagProps) {
  const code = normalizedCountryCode(country);
  if (!code) return null;
  const label = t('Country {code}', { code: code.toUpperCase() });
  return (
    <img
      className={`inline-block h-3 w-[18px] flex-[0_0_18px] rounded-[2px] border border-[rgb(var(--ink-rgb)/0.16)] object-cover align-middle ${className}`.trim()}
      src={`/flags/${code}.svg`}
      alt={label}
      title={label}
    />
  );
}
