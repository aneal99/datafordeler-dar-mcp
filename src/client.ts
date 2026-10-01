import {
  API_KEY_HELP,
  GRAPHQL_BASE,
  REQUEST_TIMEOUT_MS,
  REST_BASE,
  REST_SUNSET,
  SERVER_NAME,
  SERVER_VERSION,
} from "./constants.js";

export interface Auth {
  /** Datafordeler IT-system API key. Required for GraphQL; required for everything after REST_SUNSET. */
  apiKey?: string;
  /** Legacy "tjenestebruger" credentials for the REST service. Optional; anonymous works until REST_SUNSET. */
  username?: string;
  password?: string;
}

export function authFromEnv(env: NodeJS.ProcessEnv = process.env): Auth {
  return {
    apiKey: env.DATAFORDELER_API_KEY?.trim() || undefined,
    username: env.DATAFORDELER_USERNAME?.trim() || undefined,
    password: env.DATAFORDELER_PASSWORD?.trim() || undefined,
  };
}

export type DarErrorKind =
  | "config"
  | "bad_request"
  | "auth"
  | "not_found"
  | "rate_limited"
  | "upstream"
  | "timeout"
  | "network";

export class DarError extends Error {
  constructor(
    message: string,
    public readonly kind: DarErrorKind,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DarError";
  }
}

const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION} (+https://www.npmjs.com/package/${SERVER_NAME})`;

function restSunsetNote(): string {
  return new Date() >= new Date(REST_SUNSET)
    ? ` The legacy REST service was scheduled to close on ${REST_SUNSET}; this error is probably the shutdown. Set DATAFORDELER_API_KEY and use the GraphQL tools.`
    : "";
}

async function doFetch(url: URL, init: RequestInit, label: string): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error & { name?: string };
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new DarError(
        `${label}: Datafordeler did not answer within ${REQUEST_TIMEOUT_MS / 1000}s. Retry, or narrow the query (smaller page_size, add a status filter).`,
        "timeout",
      );
    }
    throw new DarError(`${label}: could not reach Datafordeler (${e.message}).${restSunsetNote()}`, "network");
  }
}

async function mapHttpError(res: Response, label: string): Promise<never> {
  const body = (await res.text().catch(() => "")).slice(0, 500);
  switch (res.status) {
    case 400:
      throw new DarError(`${label}: Datafordeler rejected the request (400): ${body}`, "bad_request", 400);
    case 401:
    case 403:
      throw new DarError(
        `${label}: Datafordeler refused the credentials (${res.status}). Check DATAFORDELER_API_KEY.${restSunsetNote()} ${body}`,
        "auth",
        res.status,
      );
    case 404:
    case 410:
      throw new DarError(`${label}: resource not found (${res.status}).${restSunsetNote()} ${body}`, "not_found", res.status);
    case 429:
      throw new DarError(
        `${label}: Datafordeler rate limit hit (429). Wait a few seconds and retry; limits per key are undocumented. ${body}`,
        "rate_limited",
        429,
      );
    default:
      throw new DarError(`${label}: Datafordeler upstream error (${res.status}). ${body}`, "upstream", res.status);
  }
}

export type RestParams = Record<string, string | number | boolean | undefined>;

/** GET a legacy REST resource. Returns the parsed JSON array. */
export async function restGet<T = unknown>(resource: string, params: RestParams, auth: Auth): Promise<T[]> {
  const url = new URL(`${REST_BASE}/${resource}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  url.searchParams.set("format", "json");
  if (auth.username && auth.password) {
    url.searchParams.set("username", auth.username);
    url.searchParams.set("password", auth.password);
  }
  const label = `REST ${resource}`;
  const res = await doFetch(url, { method: "GET", headers: { Accept: "application/json" } }, label);
  if (!res.ok) await mapHttpError(res, label);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new DarError(`${label}: unexpected response shape (expected a JSON array).`, "upstream", res.status);
  }
  return data as T[];
}

export interface GraphQLResult<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; [k: string]: unknown }>;
}

function requireApiKey(auth: Auth): string {
  if (!auth.apiKey) throw new DarError(API_KEY_HELP, "config");
  return auth.apiKey;
}

/** POST a GraphQL query to DAR/v1. GraphQL-level errors are returned, not thrown, so callers can show them. */
export async function graphql<T = unknown>(
  query: string,
  variables: Record<string, unknown> | undefined,
  auth: Auth,
): Promise<GraphQLResult<T>> {
  const url = new URL(GRAPHQL_BASE);
  url.searchParams.set("apiKey", requireApiKey(auth));
  const label = "GraphQL DAR/v1";
  const res = await doFetch(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/graphql-response+json, application/json" },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    },
    label,
  );
  const text = await res.text();
  let parsed: GraphQLResult<T> | undefined;
  try {
    parsed = JSON.parse(text) as GraphQLResult<T>;
  } catch {
    parsed = undefined;
  }
  if (!res.ok && !(parsed && (parsed.errors || parsed.data))) {
    await mapHttpError(new Response(text, { status: res.status }), label);
  }
  if (!parsed) throw new DarError(`${label}: response was not JSON: ${text.slice(0, 300)}`, "upstream", res.status);
  return parsed;
}

/** GET the DAR/v1 GraphQL schema (SDL text). */
export async function graphqlSchema(auth: Auth): Promise<string> {
  const url = new URL(`${GRAPHQL_BASE}/schema`);
  url.searchParams.set("apiKey", requireApiKey(auth));
  const label = "GraphQL DAR/v1 schema";
  const res = await doFetch(url, { method: "GET" }, label);
  if (!res.ok) await mapHttpError(res, label);
  return await res.text();
}
