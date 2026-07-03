interface ReviewedPlanIdentity {
  id: string;
  createdAt: string;
  expiresAt: string;
}

const invalidatingPlanErrorCodes = new Set([
  "REVIEWED_PLAN_NOT_FOUND",
  "REVIEWED_PLAN_EXPIRED",
  "REVIEWED_PLAN_INVALID",
  "REVIEWED_PLAN_KIND_MISMATCH"
]);

export function matchesReviewedPlanIdentity(
  envelope: ReviewedPlanIdentity,
  payload: ReviewedPlanIdentity
): boolean {
  return payload.id === envelope.id
    && payload.createdAt === envelope.createdAt
    && payload.expiresAt === envelope.expiresAt;
}

export function reviewedPlanRetryHint(code: string): string {
  return invalidatingPlanErrorCodes.has(code)
    ? " Run the preview command again to create a fresh reviewed plan."
    : "";
}
