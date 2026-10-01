import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";

const LIVE = process.env.LIVE === "1";
// fileURLToPath, not URL.pathname: on Windows pathname is "/C:/..." and cannot be spawned.
const SERVER_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function connect(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, DATAFORDELER_API_KEY: "", DATAFORDELER_USERNAME: "", DATAFORDELER_PASSWORD: "", ...env },
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

test("server lists the expected tools over stdio", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "dar_get_access_address",
      "dar_get_address",
      "dar_get_graphql_schema",
      "dar_get_postcode",
      "dar_get_street",
      "dar_graphql",
      "dar_list_access_addresses",
      "dar_list_addresses",
      "dar_search_addresses",
      "dar_status",
    ]);
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 40, `${t.name} needs a description`);
      assert.equal(t.annotations?.readOnlyHint, true, `${t.name} should be read-only`);
    }
  } finally {
    await client.close();
  }
});

test("GraphQL tools fail with a configuration error when no API key is set", async () => {
  const client = await connect();
  try {
    const res = await client.callTool({ name: "dar_search_addresses", arguments: { query: "Rentemestervej 8" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /config: DATAFORDELER_API_KEY is not set/);
    assert.match(res.content[0].text, /datafordeler\.dk/);
  } finally {
    await client.close();
  }
});

test("argument validation rejects a malformed UUID", async () => {
  const client = await connect();
  try {
    const res = await client.callTool({ name: "dar_get_address", arguments: { address_id: "not-a-uuid" } });
    assert.equal(res.isError, true);
  } finally {
    await client.close();
  }
});

test("dar_list_access_addresses requires a filter", async () => {
  const client = await connect();
  try {
    const res = await client.callTool({ name: "dar_list_access_addresses", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Provide municipality_code \+ road_code/);
  } finally {
    await client.close();
  }
});

test("live: dar_get_address returns a normalised record", { skip: !LIVE && "set LIVE=1" }, async () => {
  const client = await connect();
  try {
    const res = await client.callTool({
      name: "dar_get_address",
      arguments: { address_id: "0a3f50a0-0000-32b8-e044-0003ba298018" },
    });
    assert.equal(res.isError, undefined);
    const out = res.structuredContent;
    assert.equal(out.address.text, "Oehlenschlægersgade 35, st. tv, 1663 København V");
    assert.equal(out.address.access_address.municipality.name, "København");
    assert.match(out.attribution, /CC BY 4\.0/);
  } finally {
    await client.close();
  }
});

test("live: street -> access addresses -> addresses chain", { skip: !LIVE && "set LIVE=1" }, async () => {
  const client = await connect();
  try {
    const street = await client.callTool({
      name: "dar_get_street",
      arguments: { municipality_code: "0101", road_code: "5240" },
    });
    assert.equal(street.structuredContent.streets[0].name, "Oehlenschlægersgade");

    const list = await client.callTool({
      name: "dar_list_access_addresses",
      arguments: { street_id: street.structuredContent.streets[0].id, page_size: 5 },
    });
    assert.equal(list.structuredContent.count, 5);
    assert.equal(list.structuredContent.has_more, true);

    const first = list.structuredContent.access_addresses[0];
    const units = await client.callTool({ name: "dar_list_addresses", arguments: { access_address_id: first.id } });
    assert.ok(units.structuredContent.count >= 1);

    const pc = await client.callTool({ name: "dar_get_postcode", arguments: { postcode: "1663" } });
    assert.equal(pc.structuredContent.postcodes[0].name, "København V");

    const missing = await client.callTool({
      name: "dar_get_address",
      arguments: { address_id: "00000000-0000-0000-0000-000000000000" },
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /not_found/);

    const status = await client.callTool({ name: "dar_status", arguments: {} });
    assert.equal(status.structuredContent.rest.reachable, true);
    assert.equal(status.structuredContent.graphql.api_key_configured, false);
  } finally {
    await client.close();
  }
});

// Keyed GraphQL tools. Run with LIVE=1 and DATAFORDELER_API_KEY set; skipped otherwise.
const KEY = process.env.DATAFORDELER_API_KEY;
const keyed = { skip: !(LIVE && KEY) && "set LIVE=1 and DATAFORDELER_API_KEY" };
const withKey = () => connect({ DATAFORDELER_API_KEY: KEY });

test("keyed: street search is prefix-based and fixes the first letter's case", keyed, async () => {
  const client = await withKey();
  try {
    const res = await client.callTool({
      name: "dar_search_addresses",
      arguments: { query: "rentemester", level: "street" },
    });
    assert.equal(res.isError, undefined, res.content[0].text);
    const out = res.structuredContent;
    assert.equal(out.query, "Rentemester");
    const cph = out.results.find((r) => r.administered_by_municipality_code === "0101");
    assert.ok(cph, "expected Rentemestervej in København (0101)");
    assert.equal(cph.text, "Rentemestervej");

    // The street id from GraphQL chains into the REST enumeration tool.
    const list = await client.callTool({
      name: "dar_list_access_addresses",
      arguments: { street_id: cph.id, page_size: 3 },
    });
    assert.equal(list.structuredContent.count, 3);
    assert.match(list.structuredContent.access_addresses[0].text, /^Rentemestervej /);
  } finally {
    await client.close();
  }
});

test("keyed: access-address and address search return current records", keyed, async () => {
  const client = await withKey();
  try {
    const acc = await client.callTool({
      name: "dar_search_addresses",
      arguments: { query: "Rentemestervej 8, 2400" },
    });
    assert.equal(acc.isError, undefined, acc.content[0].text);
    assert.equal(acc.structuredContent.count, 1);
    const hit = acc.structuredContent.results[0];
    assert.equal(hit.text, "Rentemestervej 8, 2400 København NV");
    assert.equal(hit.house_number, "8");
    assert.equal(hit.status_code, "3");

    const unit = await client.callTool({
      name: "dar_search_addresses",
      arguments: { query: "Oehlenschlægersgade 35, st", level: "address" },
    });
    assert.equal(unit.isError, undefined, unit.content[0].text);
    const texts = unit.structuredContent.results.map((r) => r.text);
    assert.ok(texts.includes("Oehlenschlægersgade 35, st. tv, 1663 København V"));
    assert.ok(unit.structuredContent.results.every((r) => r.access_address_id === "0a3f507a-d330-32b8-e044-0003ba298018"));

    const none = await client.callTool({
      name: "dar_search_addresses",
      arguments: { query: "Zzzzqqqq 999" },
    });
    assert.equal(none.structuredContent.count, 0);
    assert.match(none.structuredContent.hint, /case-sensitive/);
  } finally {
    await client.close();
  }
});

test("keyed: raw GraphQL and schema tools", keyed, async () => {
  const client = await withKey();
  try {
    const now = new Date().toISOString();
    const raw = await client.callTool({
      name: "dar_graphql",
      arguments: {
        query: `query { DAR_Postnummer(first: 1, virkningstid: "${now}", registreringstid: "${now}", where: { postnr: { eq: "8000" } }) { nodes { postnr navn } } }`,
      },
    });
    assert.equal(raw.isError, undefined, raw.content[0].text);
    assert.deepEqual(raw.structuredContent.data.DAR_Postnummer.nodes[0], { postnr: "8000", navn: "Aarhus C" });

    // A query without a time argument is rejected by the service; the error must reach the agent.
    const bad = await client.callTool({
      name: "dar_graphql",
      arguments: { query: "query { DAR_Postnummer(first: 1) { nodes { postnr } } }" },
    });
    assert.match(JSON.stringify(bad.structuredContent.errors), /virkningstid/);

    const schema = await client.callTool({
      name: "dar_get_graphql_schema",
      arguments: { filter: "DAR_Husnummer" },
    });
    const sdl = schema.content[0].text;
    assert.match(sdl, /input DAR_HusnummerFilterInput/);
    assert.match(sdl, /adgangsadressebetegnelse: DafSearchableStringOperationFilterInput/);
    assert.ok(!sdl.includes('"""'), "doc comments should be stripped by default");

    const status = await client.callTool({ name: "dar_status", arguments: {} });
    assert.equal(status.structuredContent.graphql.api_key_configured, true);
  } finally {
    await client.close();
  }
});
