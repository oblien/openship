/**
 * HTTP opt-in to fixed organization scope; any client may request it.
 * The only supported value is "fixed", with an explicit X-Organization-Id.
 * This narrows scope; authentication and resource authorization still apply.
 * Omitting it preserves the HTTP API's legacy resource-derived scope.
 */
export const SDK_SCOPE_HEADER = "X-Openship-Scope";
export const SDK_CAPABILITIES = Object.freeze({ protocol: 1, fixedOrganizationScope: true });
