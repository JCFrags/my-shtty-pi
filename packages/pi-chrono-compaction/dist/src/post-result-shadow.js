export function returnAuthoritativeAfterShadowSchedule(authoritativeResponse, scheduleShadow) {
    const snapshot = structuredClone(authoritativeResponse);
    void scheduleShadow(snapshot);
    return authoritativeResponse;
}
//# sourceMappingURL=post-result-shadow.js.map