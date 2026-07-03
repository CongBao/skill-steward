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

function errorCode(error: unknown): string | undefined {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

export function consumedReviewedPlanError(error: unknown): Error {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const consumed = "This reviewed plan has been consumed.";
  const freshPreview = "Run the preview command again to create a fresh reviewed plan.";
  const additions = [
    ...(message.includes(consumed) ? [] : [consumed]),
    ...(
      (code !== undefined && reviewedPlanRetryHint(code) !== "")
      || message.includes(freshPreview)
        ? []
        : [freshPreview]
    )
  ];
  if (additions.length === 0 && error instanceof Error) return error;

  const wrapped = new Error(
    `${message}${additions.length > 0 ? ` ${additions.join(" ")}` : ""}`,
    { cause: error }
  );
  wrapped.name = error instanceof Error ? error.name : "ReviewedPlanApplyError";
  if (code !== undefined) {
    Object.defineProperty(wrapped, "code", { value: code, enumerable: true });
  }
  return wrapped;
}

export async function applyClaimedReviewedPlan<T>(
  apply: () => Promise<T>
): Promise<T> {
  try {
    return await apply();
  } catch (error) {
    throw consumedReviewedPlanError(error);
  }
}
