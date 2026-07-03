export function apiSuccess<T>(data: T) {
  return { data, error: null, meta: { apiVersion: 1 } };
}

export function apiFailure(code: string, message: string) {
  return { data: null, error: { code, message }, meta: { apiVersion: 1 } };
}
