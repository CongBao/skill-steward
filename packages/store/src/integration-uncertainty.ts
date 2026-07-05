const uncertainCodes = new Set([
  "INTEGRATION_LEASE_LOST",
  "INTEGRATION_LEASE_UNSAFE",
  "INTEGRATION_CONFIGURATION_UNCERTAIN"
]);

/** Traverses arbitrary error graphs without assuming a tree-shaped `cause`. */
export function isIntegrationMutationUncertainty(
  error: unknown,
  seen = new Set<unknown>()
): boolean {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return false;
  }
  if (seen.has(error)) return false;
  seen.add(error);
  if (
    "code" in error
    && typeof error.code === "string"
    && uncertainCodes.has(error.code)
  ) return true;
  if (
    error instanceof AggregateError
    && error.errors.some((child) => isIntegrationMutationUncertainty(child, seen))
  ) return true;
  return "cause" in error && isIntegrationMutationUncertainty(error.cause, seen);
}
