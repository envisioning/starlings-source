/** The account address behind a device-scoped identity. */
export function ownerAccountEmail(identity: string): string {
  const at = identity.lastIndexOf('@');
  if (at <= 0) return identity;
  const local = identity.slice(0, at);
  const plus = local.indexOf('+');
  return plus <= 0 ? identity : `${local.slice(0, plus)}${identity.slice(at)}`;
}
