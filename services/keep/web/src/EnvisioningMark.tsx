/** EV glyph, `currentColor`. Same geometry as meet's `EnvisioningMark`. */
export function EnvisioningMark({
  size = 14,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 28 28"
      aria-hidden="true"
      focusable="false"
    >
      <g transform="translate(4.2 4.2)" fill="currentColor">
        <rect x="0" y="6.29944" width="7" height="7" />
        <path
          transform="translate(9.8 0)"
          d="M7.000025,19.6 L0,19.6 L0,14.7 C0,14.37478 0.0452901618,14.05117 0.134680481,13.73848 L2.80001,4.40979 L2.80001,0 L9.800035,0 L9.800035,4.9 C9.800035,5.22522 9.75474484,5.54883 9.66535452,5.86152 L7.000025,15.19021 L7.000025,19.6 Z"
        />
      </g>
    </svg>
  );
}
