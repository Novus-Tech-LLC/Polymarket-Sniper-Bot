export type CanonicalQueryResult = {
  queryString: string;
  keys: string[];
};

const normalizeParams = (
  params?: Record<string, unknown>,
): Record<string, unknown> => {
  if (!params) return {};
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
};

export const canonicalQuery = (
  params?: Record<string, unknown>,
): CanonicalQueryResult => {
  const normalized = normalizeParams(params);
  const keys = Object.keys(normalized).sort();
  if (keys.length === 0) {
    return { queryString: "", keys };
  }
  const queryString = keys
    .map(
      (key) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(normalized[key]))}`,
    )
    .join("&");
  return { queryString, keys };
};

export const buildSignedPath = (
  path: string,
  params?: Record<string, unknown>,
): { signedPath: string; paramsKeys: string[] } => {
  const { queryString, keys } = canonicalQuery(params);
  if (!queryString) {
    return { signedPath: path, paramsKeys: keys };
  }
  return { signedPath: `${path}?${queryString}`, paramsKeys: keys };
};
