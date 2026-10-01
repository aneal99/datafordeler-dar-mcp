import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compact,
  normaliseAccessAddress,
  normaliseAddress,
  normalisePostcode,
  normaliseStreet,
  parseWktPoint,
  statusLabel,
  utm32ToLatLon,
} from "../dist/normalise.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"))[0];

test("utm32ToLatLon matches pyproj EPSG:25832 -> EPSG:4326", () => {
  // Reference values computed with pyproj 3.x (always_xy=True).
  // Tolerance: 1e-6 deg (~6 cm) inside the zone; 5e-6 deg (~30 cm) for the
  // Bornholm-like case 400 km east of the central meridian, where the series
  // expansion loses accuracy. Both are far below address-point precision.
  const cases = [
    [723244.19, 6175012.23, 55.669509431980245, 12.550075700574176, 1e-6],
    [590573.6531541426, 6135883.243767985, 55.36090710501665, 10.42881502600987, 1e-6],
    [500000, 6200000, 55.9453750028629, 9.0, 1e-6],
    [900000, 6400000, 57.5646880909765, 15.692672815989576, 5e-6],
  ];
  for (const [x, y, lat, lon, tol] of cases) {
    const got = utm32ToLatLon(x, y);
    assert.ok(Math.abs(got.lat - lat) < tol, `lat ${got.lat} vs ${lat}`);
    assert.ok(Math.abs(got.lon - lon) < tol, `lon ${got.lon} vs ${lon}`);
  }
});

test("parseWktPoint and statusLabel", () => {
  assert.deepEqual(parseWktPoint("POINT(723244.19 6175012.23)"), { x: 723244.19, y: 6175012.23 });
  assert.equal(parseWktPoint("MULTILINESTRING((1 2,3 4))"), undefined);
  assert.equal(parseWktPoint(undefined), undefined);
  assert.equal(statusLabel("3"), "current");
  assert.equal(statusLabel("4"), "discontinued");
  assert.equal(statusLabel("8"), undefined);
});

test("normaliseAddress flattens a REST adresse record", () => {
  const a = normaliseAddress(fixture("adresse"));
  assert.equal(a.id, "0a3f50a0-0000-32b8-e044-0003ba298018");
  assert.equal(a.text, "Oehlenschlægersgade 35, st. tv, 1663 København V");
  assert.equal(a.floor, "st");
  assert.equal(a.door, "tv");
  assert.equal(a.status, "current");
  assert.equal(a.access_address_id, "0a3f507a-d330-32b8-e044-0003ba298018");
  assert.equal(a.access_address.street.name, "Oehlenschlægersgade");
  assert.equal(a.access_address.municipality.code, "0101");
  assert.deepEqual(a.access_address.road_code, { municipality_code: "0101", road_code: "5240" });
  assert.equal(a.access_address.access_point.crs, "EPSG:25832");
  assert.ok(Math.abs(a.access_address.access_point.lat - 55.6695094) < 1e-5);
  assert.ok(Math.abs(a.access_address.access_point.lon - 12.5500757) < 1e-5);
  const slim = normaliseAddress(fixture("adresse"), { includeAccessAddress: false });
  assert.equal(slim.access_address, undefined);
  assert.equal(slim.access_address_id, "0a3f507a-d330-32b8-e044-0003ba298018");
});

test("normaliseAccessAddress flattens a REST husnummer record", () => {
  const h = normaliseAccessAddress(fixture("husnummer"));
  assert.equal(h.text, "Oehlenschlægersgade 35, 1663 København V");
  assert.equal(h.house_number, "35");
  assert.equal(h.postcode.code, "1663");
  assert.equal(h.postcode.name, "København V");
  assert.equal(h.parish.name, "Vesterbro");
  assert.equal(h.cadastral_parcel_id, "10429534");
  assert.equal(h.access_point.accuracy_class, "A");
  assert.ok(h.road_point.lat > 55 && h.road_point.lat < 56);
});

test("normaliseStreet and normalisePostcode", () => {
  const s = normaliseStreet(fixture("navngivenvej"));
  assert.equal(s.name, "Oehlenschlægersgade");
  assert.deepEqual(s.road_codes[0], { municipality_code: "0101", road_code: "5240", status: "current" });
  assert.ok(s.postcodes.some((p) => p.code === "1663"));
  const p = normalisePostcode(fixture("postnummer"));
  assert.equal(p.code, "1663");
  assert.equal(p.name, "København V");
});

test("compact drops undefined recursively", () => {
  assert.deepEqual(compact({ a: 1, b: undefined, c: { d: undefined, e: [1, { f: undefined }] } }), {
    a: 1,
    c: { e: [1, {}] },
  });
});
