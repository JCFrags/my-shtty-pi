export function returnAuthoritativeAfterShadowSchedule<T>(
  authoritativeResponse: T,
  scheduleShadow: (snapshot: T) => unknown,
): T {
  const snapshot = structuredClone(authoritativeResponse);
  void scheduleShadow(snapshot);
  return authoritativeResponse;
}
