/**
 * FR-IAM-7. A token is refused when it was issued at or before the person's `tokensValidAfter`.
 * Token issue times have a resolution of one second, so the comparison is in whole seconds and errs towards refusing:
 * a token issued in the same second as the revocation is refused too, and the person simply signs in again.
 */
export function isRevoked(tokensValidAfter: Date | null | undefined, issuedAtSeconds: number | undefined): boolean {
  if (!tokensValidAfter) return false;
  if (typeof issuedAtSeconds !== 'number') return true; // a token that cannot say when it was issued cannot prove it is newer
  return issuedAtSeconds <= Math.floor(tokensValidAfter.getTime() / 1000);
}
