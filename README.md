# datafordeler-dar-mcp

MCP server for Danish addresses from **Danmarks Adresseregister (DAR)** on
**Datafordeleren**, the official national data distributor.

DAWA (`dawa.aws.dk`, `api.dataforsyningen.dk`) closed on **1 October 2026**
and now returns HTTP 410. Every address tool that was built on it is dead.
Klimadatastyrelsen's replacement is Datafordeleren, which is keyed, bitemporal
and GraphQL-first. This server gives AI agents (Claude, Cursor, VS Code, any
MCP client) the DAR data through ten small, documented tools, with the
coordinates converted to WGS84 and the DAR UUIDs that DAWA also used.

Status: **v0.1, a probe.** It exists to find out whether anyone wants a
maintained MCP layer over Danish public data. Stars, npm downloads and
issues are the signal. It is deliberately thin: no caching, no metering,
one source.

## What it does

| Tool | Needs API key | Purpose |
|---|---|---|
| `dar_status` | no | Connectivity check, configured access paths, sunset countdown |
| `dar_get_address` | no | One unit address (floor/door) by UUID |
| `dar_get_access_address` | no | One access address (entrance / husnummer) by UUID |
| `dar_list_addresses` | no | Units at one access address |
| `dar_list_access_addresses` | no | Enumerate a street (municipality + road code), a postcode or a cadastral parcel, paginated |
| `dar_get_street` | no | Named road by UUID or municipality + road code |
| `dar_get_postcode` | no | Postcode by 4-digit code or UUID |
| `dar_search_addresses` | **yes** | Prefix search on street names, access addresses and unit addresses |
| `dar_graphql` | **yes** | Raw GraphQL passthrough to `DAR/v2` |
| `dar_get_graphql_schema` | **yes** | Fetch the GraphQL schema, compacted and filterable |

Every result carries `attribution` (CC BY 4.0, Klimadatastyrelsen), DAR
status codes with English labels, and points in both EPSG:25832 and WGS84.
Errors are typed (`config`, `bad_request`, `auth`, `not_found`,
`rate_limited`, `upstream`, `timeout`, `network`) and say what to do next.

## Install

Requires Node.js 20 or newer.

Claude Code:

```bash
claude mcp add datafordeler-dar -- npx -y datafordeler-dar-mcp
```

Claude Desktop, Cursor, VS Code and other clients (`mcp.json` /
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "datafordeler-dar": {
      "command": "npx",
      "args": ["-y", "datafordeler-dar-mcp"],
      "env": { "DATAFORDELER_API_KEY": "your-key-here" }
    }
  }
}
```

## Getting an API key, and why you will need one

Anonymous access to the legacy REST service works today, which is why the
seven lookup tools need no key. Klimadatastyrelsen has announced that
**after 15 January 2027 Datafordeleren only serves authenticated requests**
(API key or OAuth). Text search already needs a key because it runs on the
GraphQL service.

1. Create a free account at <https://datafordeler.dk> (Datafordeler
   Administration). An e-mail user is enough; MitID Erhverv is optional.
2. Create an IT-system and add an API key to it.
3. Set `DATAFORDELER_API_KEY`.

No approval step is needed for DAR. A new key takes up to 15 minutes to
activate; until then the service answers 401 "Unrecognized Authentication
key". Rate limits are not published; the server surfaces HTTP 429 as
`rate_limited`.

Optional legacy credentials (`DATAFORDELER_USERNAME`, `DATAFORDELER_PASSWORD`)
are passed through to the REST service if set.

## Examples an agent can chain

```
dar_get_postcode({ postcode: "1663" })
  -> postcodes[0].id = d4a3a5ad-...
dar_list_access_addresses({ postcode_id: "d4a3a5ad-...", page_size: 50 })
  -> entrances with lat/lon
dar_list_addresses({ access_address_id: "0a3f507a-d330-32b8-e044-0003ba298018" })
  -> 12 units at Oehlenschlægersgade 35
dar_get_address({ address_id: "0a3f50a0-0000-32b8-e044-0003ba298018" })
  -> "Oehlenschlægersgade 35, st. tv, 1663 København V", municipality 0101, parish Vesterbro
```

With a key:

```
dar_search_addresses({ query: "rentemester", level: "street" })
  -> Rentemestervej, København (0101), id 831a760e-...
dar_list_access_addresses({ street_id: "831a760e-4e3f-42e8-a9a5-0b771f72880a" })
  -> every house number on the street, with lat/lon
dar_search_addresses({ query: "Rentemestervej 8, 2400" })
  -> "Rentemestervej 8, 2400 København NV"
dar_search_addresses({ query: "Oehlenschlægersgade 35, st", level: "address" })
  -> st. tv and st. th
```

### What the GraphQL service actually does

Verified against the live service on 2026-10-01. Several points differ
from Datafordeleren's published transition guide (v2.3, January 2025):

- DAR is served at **`/DAR/v2`**. `/DAR/v1`, which the guide documents,
  returns 404.
- Every entity query must carry `virkningstid` and/or `registreringstid`,
  or filter on `id_lokalId`. Pass **both** set to now for the current
  state; with `virkningstid` alone you also get superseded registrations.
- `startsWith` exists only on `adgangsadressebetegnelse`,
  `adressebetegnelse`, `vejnavn`, `postnr` and `navn`, and is
  **case-sensitive**. Everything else takes `eq` and `in`. There is no
  fuzzy, substring or ranked search, and no autocomplete.
- References are ids. A `DAR_Husnummer` holds the UUIDs of its street,
  postcode and access point; coordinates live on `DAR_Adressepunkt`.
- Field names transliterate æ/ø/å as ae/oe/aa (`doerbetegnelse`).
- Paging is forward-only: `first` (max 1000) and `after`.
- Responses are fast: 30 to 150 ms per query in testing.

`dar_search_addresses` handles the time arguments, the status filter and
the first letter's case for you. `dar_graphql` passes queries through
untouched and returns the service's errors verbatim.

## Data, licence and attribution

Source: Danmarks Adresseregister via Datafordeleren, Klimadatastyrelsen.
Licence: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) per
Datafordeleren's terms of use. You must credit Klimadatastyrelsen "på et
passende sted"; the `attribution` field in every response is there to be
passed on. Addresses are not personal data. The server stores nothing and
logs nothing.

Known limits of the legacy REST service this version leans on: no text
search, no reverse geocoding, no autocomplete, pagination by page number
only, and a scheduled shutdown on 15 January 2027. The replacement for all
of those is the GraphQL service behind the three keyed tools.

## Development

```bash
npm install
npm test          # build + unit tests + stdio integration tests (offline)
npm run test:live # also hits services.datafordeler.dk
```

With `DATAFORDELER_API_KEY` set, `test:live` also exercises the three
GraphQL tools; without it those tests are skipped.

Layout: `src/client.ts` (REST and GraphQL fetch, typed errors),
`src/normalise.ts` (flattening, status labels, UTM32 to WGS84),
`src/server.ts` (tool registrations), `src/index.ts` (stdio entry point).
Tests use fixtures captured from the live service on 2026-10-01.

## Feedback

If this is useful to you, or missing something you need (other registers,
reverse geocoding, a hosted endpoint), please open an issue. Issues and
stars are how this project decides what to build next.

## Licence

MIT. See `LICENSE`.
