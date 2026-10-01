import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type Auth, DarError, graphql, graphqlSchema, restGet } from "./client.js";
import {
  ATTRIBUTION,
  CHARACTER_LIMIT,
  DEFAULT_PAGE_SIZE,
  GRAPHQL_BASE,
  MAX_PAGE_SIZE,
  REST_BASE,
  REST_SUNSET,
  SERVER_NAME,
  SERVER_VERSION,
} from "./constants.js";
import {
  type Raw,
  compact,
  normaliseAccessAddress,
  normaliseAddress,
  normalisePostcode,
  normaliseStreet,
} from "./normalise.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(output: Record<string, unknown>): ToolResult {
  const withAttribution = { ...compact(output), attribution: ATTRIBUTION };
  let text = JSON.stringify(withAttribution, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    text =
      text.slice(0, CHARACTER_LIMIT) +
      `\n... [truncated at ${CHARACTER_LIMIT} characters; lower page_size or add filters]`;
  }
  return { content: [{ type: "text", text }], structuredContent: withAttribution };
}

function fail(err: unknown): ToolResult {
  const message =
    err instanceof DarError
      ? `${err.kind}: ${err.message}`
      : err instanceof Error
        ? `error: ${err.message}`
        : `error: ${String(err)}`;
  return { content: [{ type: "text", text: message }], isError: true };
}

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
}

const uuid = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "must be a UUID");
const fourDigits = (what: string) => z.string().regex(/^\d{4}$/, `${what} is a 4-digit string, e.g. "0101"`);
const statusFilter = z
  .enum(["current", "all"])
  .default("current")
  .describe('"current" returns only status 3 (gældende) records; "all" includes preliminary, discontinued and cancelled.');

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function statusParam(s: "current" | "all"): string | undefined {
  return s === "current" ? "3" : undefined;
}

export function createServer(auth: Auth): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "dar_status",
    {
      title: "DAR connection status",
      description: `Check connectivity to Datafordeleren (DAR) and report which access paths are configured.

Returns: whether the legacy REST service answers (and its latency), whether an API key for the GraphQL service is configured, the REST sunset date (${REST_SUNSET}; after it only API-key/OAuth access exists), and the attribution text that must accompany the data (CC BY 4.0, Klimadatastyrelsen).

Use first when a DAR call fails unexpectedly, or to decide whether text search (dar_search_addresses, needs API key) is available.`,
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    async () =>
      run(async () => {
        const started = Date.now();
        let restOk = false;
        let restError: string | undefined;
        try {
          await restGet("postnummer", { postnr: "1000" }, auth);
          restOk = true;
        } catch (err) {
          restError = err instanceof Error ? err.message : String(err);
        }
        const daysToSunset = Math.ceil((new Date(REST_SUNSET).getTime() - Date.now()) / 86_400_000);
        return ok({
          server: `${SERVER_NAME} ${SERVER_VERSION}`,
          rest: { base: REST_BASE, reachable: restOk, latency_ms: Date.now() - started, error: restError },
          rest_sunset: { date: REST_SUNSET, days_remaining: daysToSunset },
          graphql: {
            base: GRAPHQL_BASE,
            api_key_configured: Boolean(auth.apiKey),
            note: auth.apiKey
              ? "dar_search_addresses, dar_graphql and dar_get_graphql_schema are available."
              : "No DATAFORDELER_API_KEY. Text search is unavailable; lookups by id and by municipality/road code still work via REST until the sunset date.",
          },
          note: "DAWA (dawa.aws.dk / api.dataforsyningen.dk) closed on 2026-10-01. DAR ids are identical to the ids DAWA used.",
        });
      }),
  );

  server.registerTool(
    "dar_get_address",
    {
      title: "Get address by id",
      description: `Fetch one Danish address (adresse: a specific door/floor unit) from DAR by its UUID.

The id is the same UUID DAWA used for /adresser, so stored DAWA ids keep working. Returns the normalised address with its access address (husnummer) embedded: street, house number, municipality, postcode, parish, cadastral parcel, building id and the access point coordinates in both EPSG:25832 (x, y) and WGS84 (lat, lon).

Example: dar_get_address({ address_id: "0a3f50a0-0000-32b8-e044-0003ba298018" }) -> "Oehlenschlægersgade 35, st. tv, 1663 København V".

Not for text search: use dar_search_addresses (API key) or dar_list_access_addresses (municipality + road code).`,
      inputSchema: z.object({
        address_id: uuid.describe("DAR/DAWA address UUID (id_lokalId of an Adresse)."),
      }),
      annotations: readOnly,
    },
    async ({ address_id }) =>
      run(async () => {
        const rows = await restGet<Raw>("adresse", { id: address_id }, auth);
        if (rows.length === 0) {
          throw new DarError(
            `No DAR address with id ${address_id}. If this is an access-address (husnummer) id, use dar_get_access_address.`,
            "not_found",
          );
        }
        return ok({ address: normaliseAddress(rows[0]) });
      }),
  );

  server.registerTool(
    "dar_get_access_address",
    {
      title: "Get access address by id",
      description: `Fetch one access address (husnummer: street + house number, the entrance) from DAR by its UUID.

The id is the same UUID DAWA used for /adgangsadresser. Returns street, house number, municipality, postcode, supplementary town name, parish, cadastral parcel (jordstykke), GeoDanmark building id, and access/road point coordinates (EPSG:25832 and WGS84).

Example: dar_get_access_address({ access_address_id: "0a3f507a-d330-32b8-e044-0003ba298018" }) -> "Oehlenschlægersgade 35, 1663 København V".

To list the individual units (floors/doors) at this entrance, call dar_list_addresses with the same id.`,
      inputSchema: z.object({
        access_address_id: uuid.describe("DAR/DAWA access-address UUID (id_lokalId of a Husnummer)."),
      }),
      annotations: readOnly,
    },
    async ({ access_address_id }) =>
      run(async () => {
        const rows = await restGet<Raw>("husnummer", { id: access_address_id }, auth);
        if (rows.length === 0) {
          throw new DarError(
            `No DAR access address with id ${access_address_id}. If this is a unit-address id, use dar_get_address.`,
            "not_found",
          );
        }
        return ok({ access_address: normaliseAccessAddress(rows[0]) });
      }),
  );

  server.registerTool(
    "dar_list_addresses",
    {
      title: "List addresses at an access address",
      description: `List the unit addresses (floors/doors) that belong to one access address (husnummer).

Example: dar_list_addresses({ access_address_id: "0a3f507a-d330-32b8-e044-0003ba298018" }) -> 12 addresses at Oehlenschlægersgade 35 (st. tv, st. th, 1. tv, ...).

Returns compact records (id, text, floor, door, status). Fetch one with dar_get_address for full detail. A single-family house typically has exactly one address with no floor/door.`,
      inputSchema: z.object({
        access_address_id: uuid.describe("DAR/DAWA access-address UUID."),
        status: statusFilter,
      }),
      annotations: readOnly,
    },
    async ({ access_address_id, status }) =>
      run(async () => {
        const rows = await restGet<Raw>("adresse", { husnummer: access_address_id, status: statusParam(status) }, auth);
        return ok({
          access_address_id,
          count: rows.length,
          addresses: rows.map((r) => normaliseAddress(r, { includeAccessAddress: false })),
        });
      }),
  );

  server.registerTool(
    "dar_list_access_addresses",
    {
      title: "List access addresses by street, postcode or parcel",
      description: `List access addresses (husnumre) filtered by one of:
  - municipality_code + road_code (kommunekode + vejkode, both 4-digit strings), e.g. "0101" + "5240" = Oehlenschlægersgade, København
  - street_id (NavngivenVej UUID, from dar_get_street or an earlier result)
  - postcode_id (Postnummer UUID, from dar_get_postcode; NOT the 4-digit postcode)
  - cadastral_parcel_id (jordstykke id, from an earlier access-address result)

This is the anonymous way to enumerate a street when no API key is set. Paginated: page (1-based) and page_size (max ${MAX_PAGE_SIZE}). has_more is true when a full page came back; request the next page to continue. Results include coordinates (EPSG:25832 and WGS84).

Example: dar_list_access_addresses({ municipality_code: "0101", road_code: "5240", page_size: 50 }).

Does NOT search by street name. For that use dar_search_addresses (needs DATAFORDELER_API_KEY). Danish municipality codes are 4 digits with a leading zero (København 0101, Aarhus 0751, Odense 0461, Aalborg 0851).`,
      inputSchema: z.object({
        municipality_code: fourDigits("municipality_code").optional().describe("Kommunekode, 4 digits, e.g. \"0101\"."),
        road_code: fourDigits("road_code").optional().describe("Vejkode within the municipality, 4 digits, e.g. \"5240\"."),
        street_id: uuid.optional().describe("NavngivenVej UUID."),
        postcode_id: uuid.optional().describe("Postnummer UUID (not the 4-digit code)."),
        cadastral_parcel_id: z.string().min(1).optional().describe("Jordstykke id."),
        status: statusFilter,
        page: z.number().int().min(1).default(1).describe("1-based page number."),
        page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
      }),
      annotations: readOnly,
    },
    async (p) =>
      run(async () => {
        const hasRoad = Boolean(p.municipality_code && p.road_code);
        if (!hasRoad && !p.street_id && !p.postcode_id && !p.cadastral_parcel_id) {
          throw new DarError(
            "Provide municipality_code + road_code, or street_id, or postcode_id, or cadastral_parcel_id.",
            "bad_request",
          );
        }
        if ((p.municipality_code && !p.road_code) || (!p.municipality_code && p.road_code)) {
          throw new DarError("municipality_code and road_code must be given together.", "bad_request");
        }
        const rows = await restGet<Raw>(
          "husnummer",
          {
            kommunekode: p.municipality_code,
            vejkode: p.road_code,
            navngivenvej: p.street_id,
            postnummer: p.postcode_id,
            jordstykke: p.cadastral_parcel_id,
            status: statusParam(p.status),
            page: p.page,
            pagesize: p.page_size,
          },
          auth,
        );
        return ok({
          page: p.page,
          page_size: p.page_size,
          count: rows.length,
          has_more: rows.length >= p.page_size,
          access_addresses: rows.map(normaliseAccessAddress),
        });
      }),
  );

  server.registerTool(
    "dar_get_street",
    {
      title: "Get street (named road)",
      description: `Fetch a named road (NavngivenVej) by UUID, or by municipality_code + road_code.

Returns the street name, the municipality that administers it, its road codes per municipality (a street can span municipalities) and the postcodes it runs through.

Example: dar_get_street({ municipality_code: "0101", road_code: "5240" }) -> "Oehlenschlægersgade", København.

Does NOT search by name (see dar_search_addresses for text search, API key required).`,
      inputSchema: z.object({
        street_id: uuid.optional().describe("NavngivenVej UUID."),
        municipality_code: fourDigits("municipality_code").optional(),
        road_code: fourDigits("road_code").optional(),
      }),
      annotations: readOnly,
    },
    async ({ street_id, municipality_code, road_code }) =>
      run(async () => {
        if (!street_id && !(municipality_code && road_code)) {
          throw new DarError("Provide street_id, or municipality_code + road_code.", "bad_request");
        }
        const rows = await restGet<Raw>(
          "navngivenvej",
          street_id ? { id: street_id } : { kommunekode: municipality_code, vejkode: road_code },
          auth,
        );
        if (rows.length === 0) throw new DarError("No street matched.", "not_found");
        return ok({ count: rows.length, streets: rows.map(normaliseStreet) });
      }),
  );

  server.registerTool(
    "dar_get_postcode",
    {
      title: "Get postcode",
      description: `Fetch a Danish postcode (postnummer) by its 4-digit code or by UUID. Returns id, code, name and status.

Example: dar_get_postcode({ postcode: "1663" }) -> "København V", id d4a3a5ad-.... Use the returned id as postcode_id in dar_list_access_addresses to enumerate addresses in that postcode.`,
      inputSchema: z.object({
        postcode: fourDigits("postcode").optional().describe('4-digit postcode, e.g. "8000".'),
        postcode_id: uuid.optional().describe("Postnummer UUID."),
      }),
      annotations: readOnly,
    },
    async ({ postcode, postcode_id }) =>
      run(async () => {
        if (!postcode && !postcode_id) throw new DarError("Provide postcode or postcode_id.", "bad_request");
        const rows = await restGet<Raw>("postnummer", postcode_id ? { id: postcode_id } : { postnr: postcode }, auth);
        if (rows.length === 0) throw new DarError(`No postcode matched ${postcode ?? postcode_id}.`, "not_found");
        return ok({ count: rows.length, postcodes: rows.map(normalisePostcode) });
      }),
  );

  server.registerTool(
    "dar_search_addresses",
    {
      title: "Search streets and addresses by text prefix (API key)",
      description: `Find streets, access addresses or unit addresses whose official text starts with a prefix, via the Datafordeler GraphQL service. REQUIRES DATAFORDELER_API_KEY.

The service supports prefix matching only (startsWith): no fuzzy, substring or typo-tolerant search, and it is CASE-SENSITIVE. Write the prefix the way DAR writes it: "Vejnavn husnummer, postnr By". This tool upper-cases the first letter for you; the rest must match exactly, including Danish letters (æ, ø, å).

level:
  - "street": match street names (NavngivenVej), e.g. "Rentemester" -> Rentemestervej in København (0101) and Hvidovre. Returns street id, name and administering municipality code. Feed the id to dar_list_access_addresses({ street_id }) to enumerate house numbers.
  - "access_address" (default): match entrances, e.g. "Rentemestervej 8" -> Rentemestervej 8, 80, 82, ... Results are NOT ranked; an exact house number is one of several prefix matches, so add ", 2400" or pick by house_number.
  - "address": match unit addresses including floor/door, e.g. "Oehlenschlægersgade 35, st".

Returns ids and text only. Follow up with dar_get_access_address / dar_get_address for coordinates, municipality and postcode. Paginate with the returned next_cursor.

Example: dar_search_addresses({ query: "Rentemestervej 8, 2400", limit: 5 }).`,
      inputSchema: z.object({
        query: z.string().min(2).max(200).describe("Text prefix, e.g. \"Rentemestervej 8\" or, for level \"street\", \"Rentemester\"."),
        level: z.enum(["access_address", "address", "street"]).default("access_address"),
        limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(10),
        only_current: z.boolean().default(true).describe("Keep only status 3 (gældende) records."),
        after: z.string().optional().describe("Cursor from a previous result's next_cursor, for the next page."),
      }),
      annotations: readOnly,
    },
    async ({ query, level, limit, only_current, after }) =>
      run(async () => {
        const spec = {
          access_address: { entity: "DAR_Husnummer", textField: "adgangsadressebetegnelse", extra: "husnummertekst navngivenVej postnummer" },
          address: { entity: "DAR_Adresse", textField: "adressebetegnelse", extra: "husnummer etagebetegnelse doerbetegnelse" },
          street: { entity: "DAR_NavngivenVej", textField: "vejnavn", extra: "vejadresseringsnavn administreresAfKommune" },
        }[level];
        const { entity, textField } = spec;
        // DAR text starts with a capital letter and startsWith is case-sensitive.
        const prefix = query.trim().charAt(0).toLocaleUpperCase("da-DK") + query.trim().slice(1);
        // Both time arguments are needed to get the currently valid, currently registered version;
        // with virkningstid alone the service also returns superseded registrations.
        const now = new Date().toISOString();
        const where = [`${textField}: { startsWith: ${JSON.stringify(prefix)} }`];
        if (only_current) where.push(`status: { eq: "3" }`);
        const gql = `query {
  ${entity}(first: ${limit}${after ? `, after: ${JSON.stringify(after)}` : ""}, virkningstid: "${now}", registreringstid: "${now}", where: { ${where.join(", ")} }) {
    pageInfo { endCursor hasNextPage }
    nodes { id_lokalId ${textField} status ${spec.extra} }
  }
}`;
        const result = await graphql<Record<string, { pageInfo: { endCursor?: string; hasNextPage: boolean }; nodes: Raw[] }>>(
          gql,
          undefined,
          auth,
        );
        if (result.errors?.length) {
          throw new DarError(
            `GraphQL errors: ${result.errors.map((e) => e.message).join("; ")}. Query sent:\n${gql}\nInspect the schema with dar_get_graphql_schema({ filter: "${entity}" }).`,
            "bad_request",
          );
        }
        const page = result.data?.[entity];
        const nodes = page?.nodes ?? [];
        return ok({
          query: prefix,
          level,
          count: nodes.length,
          has_more: Boolean(page?.pageInfo?.hasNextPage),
          next_cursor: page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : undefined,
          results: nodes.map((n) => ({
            id: n.id_lokalId,
            text: n[textField],
            status_code: String(n.status),
            // access_address level
            house_number: n.husnummertekst,
            street_id: n.navngivenVej,
            postcode_id: n.postnummer,
            // address level
            access_address_id: level === "address" ? n.husnummer : undefined,
            floor: n.etagebetegnelse,
            door: n.doerbetegnelse,
            // street level
            addressing_name: n.vejadresseringsnavn,
            administered_by_municipality_code: n.administreresAfKommune,
          })),
          hint:
            nodes.length === 0
              ? "No prefix match. Matching is case-sensitive and exact: check spelling and Danish letters, shorten the prefix, or try level \"street\" with just the start of the street name."
              : undefined,
        });
      }),
  );

  server.registerTool(
    "dar_graphql",
    {
      title: "Run a raw DAR GraphQL query (API key)",
      description: `Send any GraphQL query to ${GRAPHQL_BASE}. REQUIRES DATAFORDELER_API_KEY.

Entities: DAR_Adresse, DAR_Husnummer, DAR_NavngivenVej, DAR_NavngivenVejKommunedel, DAR_NavngivenVejPostnummer, DAR_Postnummer, DAR_SupplerendeBynavn, DAR_Adressepunkt, DAR_Events.

Rules the service enforces:
  - Every entity query needs virkningstid and/or registreringstid (ISO timestamp), or a where filter on id_lokalId. Pass BOTH set to the current time to get the current state; with only one you also get superseded versions.
  - Filters: where: { field: { eq | in } }. startsWith exists only on adgangsadressebetegnelse, adressebetegnelse, vejnavn, postnr and navn, and is case-sensitive. Dates and ints also take gt/gte/lt/lte. Geometry fields take spatial filters (intersects, within, contains ...) with { wkt, crs: 25832 }.
  - Paging: first (max 1000, default 100) and after (cursor); read pageInfo { endCursor hasNextPage }.
  - References are ids, not nested objects: DAR_Husnummer.navngivenVej, .postnummer and .adgangspunkt hold UUIDs; fetch coordinates from DAR_Adressepunkt { position { wkt crs } }.
  - Field names with æ/ø/å use ae/oe/aa (doerbetegnelse, virkningsaktoer).

Example:
query { DAR_Husnummer(first: 5, virkningstid: "2026-10-01T12:00:00Z", registreringstid: "2026-10-01T12:00:00Z", where: { adgangsadressebetegnelse: { startsWith: "Rentemestervej 8" }, status: { eq: "3" } }) { pageInfo { endCursor hasNextPage } nodes { id_lokalId adgangsadressebetegnelse status } } }

Returns the raw { data, errors } envelope. Use dar_get_graphql_schema to discover fields.`,
      inputSchema: z.object({
        query: z.string().min(5).max(20_000).describe("GraphQL query document."),
        variables: z.record(z.string(), z.unknown()).optional().describe("Optional GraphQL variables object."),
      }),
      annotations: readOnly,
    },
    async ({ query, variables }) =>
      run(async () => {
        const result = await graphql(query, variables, auth);
        return ok({ ...result } as Record<string, unknown>);
      }),
  );

  server.registerTool(
    "dar_get_graphql_schema",
    {
      title: "Get DAR GraphQL schema (API key)",
      description: `Fetch the GraphQL schema (SDL) for DAR/v2. REQUIRES DATAFORDELER_API_KEY.

The full schema is about 80,000 characters, mostly Danish field documentation. By default the doc comments are stripped, which leaves a compact list of types, fields and filter inputs. Pass filter to keep only type/input/enum blocks whose name contains the text (case-insensitive), e.g. filter: "DAR_Husnummer" (type, filter input, connection) or filter: "OperationFilterInput" (available operators). Set include_docs: true to keep the field definitions and legal references. Output is truncated at ${CHARACTER_LIMIT} characters.`,
      inputSchema: z.object({
        filter: z.string().min(1).max(100).optional().describe("Substring of a type name to keep, e.g. \"DAR_Adresse\"."),
        include_docs: z.boolean().default(false).describe("Keep the \"\"\"doc comment\"\"\" blocks (Danish definitions, legal sources)."),
      }),
      annotations: readOnly,
    },
    async ({ filter, include_docs }) =>
      run(async () => {
        const raw = await graphqlSchema(auth);
        const sdl = include_docs ? raw : raw.replace(/[ \t]*"""[\s\S]*?"""\r?\n/g, "");
        let text = sdl;
        if (filter) {
          const needle = filter.toLowerCase();
          const blocks = sdl.split(/\n(?=(?:type|input|enum|scalar|interface|union|directive)\s)/);
          text = blocks.filter((b) => b.split("\n")[0]?.toLowerCase().includes(needle)).join("\n");
          if (!text) text = `No schema blocks whose first line contains "${filter}".`;
        }
        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + `\n... [truncated at ${CHARACTER_LIMIT} characters; use filter]`;
        }
        return { content: [{ type: "text", text }] };
      }),
  );

  return server;
}
