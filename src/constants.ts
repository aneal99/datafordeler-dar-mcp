export const SERVER_NAME = "datafordeler-dar-mcp";
export const SERVER_VERSION = "0.1.1";

/** Legacy REST service. Anonymous access works until the sunset date below. */
export const REST_BASE = "https://services.datafordeler.dk/DAR/DAR/3.0.0/rest";

/** Modernised GraphQL service. Always requires an API key (query parameter `apiKey`). */
export const GRAPHQL_BASE = "https://graphql.datafordeler.dk/DAR/v2";

/**
 * Klimadatastyrelsen: "Efter 15. januar 2027 kan anvenderne udelukkende hente
 * data med autentifikation som API-key eller OAuth på Datafordeleren."
 * (datafordeler.dk front page, read 2026-10-01)
 */
export const REST_SUNSET = "2027-01-15";

export const ATTRIBUTION =
  "Indeholder data fra Danmarks Adresseregister (DAR) via Datafordeleren, Klimadatastyrelsen. Licens: CC BY 4.0.";

export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;
export const CHARACTER_LIMIT = 60_000;

export const API_KEY_HELP =
  "DATAFORDELER_API_KEY is not set. The GraphQL service, and every Datafordeler service after " +
  REST_SUNSET +
  ", needs an API key. Create a free account at https://datafordeler.dk (Datafordeler Administration -> " +
  "IT-system -> API key) and set the DATAFORDELER_API_KEY environment variable. Until then use " +
  "dar_list_access_addresses with municipality_code + road_code, or the dar_get_* tools by id.";
