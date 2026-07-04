export function apiSuccess<T>(data: T) {
  return { data, error: null, meta: { apiVersion: 1 } };
}

export function apiFailure(code: string, message: string, data?: unknown) {
  return {
    data: null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
    meta: { apiVersion: 1 }
  };
}
