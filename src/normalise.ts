/**
 * Flatten Datafordeler DAR records into small, stable, English-keyed objects.
 * Identifiers are the DAR UUIDs (`id_lokalId`), which are the same ids DAWA used.
 * Deliberately thin: this is a probe, not the product.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Raw = Record<string, any>;

/** DAR life-cycle status codes (same values DAWA exposed). */
const STATUS_LABELS: Record<string, string> = {
  "2": "preliminary",
  "3": "current",
  "4": "discontinued",
  "5": "cancelled",
};

export function statusLabel(code: unknown): string | undefined {
  return typeof code === "string" ? STATUS_LABELS[code] : undefined;
}

export interface Point {
  x: number;
  y: number;
  crs: "EPSG:25832";
  lat: number;
  lon: number;
  accuracy_class?: string;
  source?: string;
}

export function parseWktPoint(wkt: unknown): { x: number; y: number } | undefined {
  if (typeof wkt !== "string") return undefined;
  const m = /^POINT\s*\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)/.exec(wkt.trim());
  if (!m) return undefined;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

/**
 * Inverse transverse Mercator (Snyder 1987, formulas 8-17 to 8-25) for
 * ETRS89 / UTM zone 32N (EPSG:25832) -> geographic degrees. ETRS89 and
 * WGS84 differ by well under a metre in Denmark, so lat/lon can be used
 * directly with web maps. Accurate to centimetres across mainland Denmark
 * and to about 15 cm on Bornholm (400 km east of the central meridian).
 */
export function utm32ToLatLon(x: number, y: number): { lat: number; lon: number } {
  const a = 6378137.0;
  const f = 1 / 298.257222101; // GRS80 (ETRS89)
  const k0 = 0.9996;
  const lon0 = (9 * Math.PI) / 180; // zone 32 central meridian
  const e2 = 2 * f - f * f;
  const ep2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

  const xr = x - 500000;
  const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
  const T1 = tanPhi1 * tanPhi1;
  const C1 = ep2 * cosPhi1 * cosPhi1;
  const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
  const D = xr / (N1 * k0);

  const lat =
    phi1 -
    ((N1 * tanPhi1) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon =
    lon0 +
    (D -
      ((1 + 2 * T1 + C1) * D ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) /
      cosPhi1;

  const round = (v: number) => Math.round(v * 1e7) / 1e7;
  return { lat: round((lat * 180) / Math.PI), lon: round((lon * 180) / Math.PI) };
}

function point(p: Raw | undefined): Point | undefined {
  if (!p) return undefined;
  const xy = parseWktPoint(p.position);
  if (!xy) return undefined;
  const ll = utm32ToLatLon(xy.x, xy.y);
  return {
    x: xy.x,
    y: xy.y,
    crs: "EPSG:25832",
    lat: ll.lat,
    lon: ll.lon,
    accuracy_class: p["oprindelse_nøjagtighedsklasse"] ?? p.oprindelse_noejagtighedsklasse,
    source: p.oprindelse_kilde,
  };
}

function roadCodeFromVejmidte(vejmidte: unknown): { municipality_code: string; road_code: string } | undefined {
  if (typeof vejmidte !== "string") return undefined;
  const m = /^(\d{4})-(\d{4})$/.exec(vejmidte);
  return m ? { municipality_code: m[1], road_code: m[2] } : undefined;
}

export interface Postcode {
  id?: string;
  code?: string;
  name?: string;
  status?: string;
  status_code?: string;
}

export function normalisePostcode(p: Raw): Postcode {
  return {
    id: p.id_lokalId,
    code: p.postnr,
    name: p.navn,
    status: statusLabel(p.status),
    status_code: p.status,
  };
}

export interface Street {
  id?: string;
  name?: string;
  addressing_name?: string;
  spoken_name?: string;
  administered_by_municipality_code?: string;
  status?: string;
  status_code?: string;
  road_codes?: Array<{ municipality_code?: string; road_code?: string; status?: string }>;
  postcodes?: Postcode[];
  registered_from?: string;
  valid_from?: string;
  updated_at?: string;
}

export function normaliseStreet(n: Raw): Street {
  const kommunedele: Raw[] = Array.isArray(n.navngivenVejKommunedelList) ? n.navngivenVejKommunedelList : [];
  const postnumre: Raw[] = Array.isArray(n.postnummerList) ? n.postnummerList : [];
  return {
    id: n.id_lokalId,
    name: n.vejnavn,
    addressing_name: n.vejadresseringsnavn,
    spoken_name: n.udtaltVejnavn,
    administered_by_municipality_code: n.administreresAfKommune,
    status: statusLabel(n.status),
    status_code: n.status,
    road_codes: kommunedele
      .map((e) => e.navngivenVejKommunedel ?? e)
      .map((k: Raw) => ({ municipality_code: k.kommune, road_code: k.vejkode, status: statusLabel(k.status) })),
    postcodes: postnumre.map((e) => (e.postnummer ? normalisePostcode(e.postnummer) : { id: e.id_lokalId })),
    registered_from: n.registreringFra,
    valid_from: n.virkningFra,
    updated_at: n.datafordelerOpdateringstid,
  };
}

export interface AccessAddress {
  id?: string;
  text?: string;
  house_number?: string;
  status?: string;
  status_code?: string;
  street?: { id?: string; name?: string; addressing_name?: string };
  road_code?: { municipality_code: string; road_code: string };
  municipality?: { code?: string; name?: string };
  postcode?: Postcode;
  supplementary_town_name?: string;
  parish?: { code?: string; name?: string };
  cadastral_parcel_id?: string;
  building_id?: string;
  access_point?: Point;
  road_point?: Point;
  registered_from?: string;
  valid_from?: string;
  updated_at?: string;
}

export function normaliseAccessAddress(h: Raw): AccessAddress {
  const nv: Raw | undefined = typeof h.navngivenVej === "object" ? h.navngivenVej : undefined;
  return {
    id: h.id_lokalId,
    text: h.adgangsadressebetegnelse,
    house_number: h.husnummertekst,
    status: statusLabel(h.status),
    status_code: h.status,
    street: nv
      ? { id: nv.id_lokalId, name: nv.vejnavn, addressing_name: nv.vejadresseringsnavn }
      : typeof h.navngivenVej === "string"
        ? { id: h.navngivenVej }
        : undefined,
    road_code: roadCodeFromVejmidte(h.vejmidte),
    municipality: h.kommuneinddeling ? { code: h.kommuneinddeling.kommunekode, name: h.kommuneinddeling.navn } : undefined,
    postcode: typeof h.postnummer === "object" && h.postnummer ? normalisePostcode(h.postnummer) : undefined,
    supplementary_town_name: typeof h.supplerendeBynavn === "object" && h.supplerendeBynavn ? h.supplerendeBynavn.navn : undefined,
    parish: h.sogneinddeling ? { code: h.sogneinddeling.sognekode, name: h.sogneinddeling.navn } : undefined,
    cadastral_parcel_id: h.jordstykke,
    building_id: h.geoDanmarkBygning,
    access_point: point(h.adgangspunkt),
    road_point: point(h.vejpunkt),
    registered_from: h.registreringFra,
    valid_from: h.virkningFra,
    updated_at: h.datafordelerOpdateringstid,
  };
}

export interface Address {
  id?: string;
  text?: string;
  floor?: string;
  door?: string;
  status?: string;
  status_code?: string;
  access_address_id?: string;
  access_address?: AccessAddress;
  registered_from?: string;
  valid_from?: string;
  updated_at?: string;
}

export function normaliseAddress(a: Raw, opts: { includeAccessAddress?: boolean } = {}): Address {
  const includeAccess = opts.includeAccessAddress ?? true;
  const hn = a.husnummer;
  return {
    id: a.id_lokalId,
    text: a.adressebetegnelse,
    floor: a.etagebetegnelse,
    door: a["dørbetegnelse"] ?? a.doerbetegnelse,
    status: statusLabel(a.status),
    status_code: a.status,
    access_address_id: typeof hn === "string" ? hn : hn?.id_lokalId,
    access_address: includeAccess && hn && typeof hn === "object" ? normaliseAccessAddress(hn) : undefined,
    registered_from: a.registreringFra,
    valid_from: a.virkningFra,
    updated_at: a.datafordelerOpdateringstid,
  };
}

/** Drop undefined values so JSON output stays compact. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as unknown as T;
  if (value && typeof value === "object") {
    const out: Raw = {};
    for (const [k, v] of Object.entries(value as Raw)) {
      if (v === undefined) continue;
      out[k] = compact(v);
    }
    return out as T;
  }
  return value;
}
