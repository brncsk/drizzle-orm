import type { Geometry, Position } from './geojson.ts';

/**
 * Options of {@link geoJSONToEWKT}.
 */
export interface GeoJSONToEWKTOptions {
	/**
	 * SRID to write as an `SRID=n;` prefix. When omitted, the text has no
	 * prefix and PostGIS assigns the column's SRID (or `0`).
	 */
	srid?: number | undefined;
	/**
	 * Treat the third number of a position as M instead of Z, and write the
	 * `M` type suffix (`POINTM(x y m)`). Positions with four numbers are
	 * always written as ZM.
	 */
	mOnly?: boolean | undefined;
}

function formatOrdinate(value: number): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`Cannot write ${String(value)} as an EWKT coordinate: ordinates must be finite numbers`);
	}
	// `String()` gives the shortest text that reads back as the same double.
	// It can use exponent notation (`1e+21`); the PostGIS WKT lexer accepts it.
	return String(value);
}

function formatPosition(position: Position): string {
	let out = '';
	for (let i = 0; i < position.length; i++) {
		if (i > 0) out += ' ';
		out += formatOrdinate(position[i]!);
	}
	return out;
}

/** `(x y,x y,...)` for a line or ring; `EMPTY` when there are no positions. */
function formatPositions(positions: Position[]): string {
	if (positions.length === 0) return 'EMPTY';
	let out = '(';
	for (let i = 0; i < positions.length; i++) {
		if (i > 0) out += ',';
		out += formatPosition(positions[i]!);
	}
	return out + ')';
}

/** `((ring),(ring))` for a polygon; `EMPTY` when there are no rings. */
function formatRings(rings: Position[][]): string {
	if (rings.length === 0) return 'EMPTY';
	let out = '(';
	for (let i = 0; i < rings.length; i++) {
		if (i > 0) out += ',';
		out += formatPositions(rings[i]!);
	}
	return out + ')';
}

function formatList(parts: string[]): string {
	return parts.length === 0 ? 'EMPTY' : `(${parts.join(',')})`;
}

/**
 * Joins the type keyword and its body: `POINT(1 2)`, `POINT EMPTY`. The
 * keyword gets the `M` suffix for M-only geometries.
 */
function tagged(name: string, mOnly: boolean, body: string): string {
	const keyword = mOnly ? `${name}M` : name;
	return body === 'EMPTY' ? `${keyword} EMPTY` : `${keyword}${body}`;
}

function formatGeometry(geometry: Geometry, mOnly: boolean): string {
	switch (geometry.type) {
		case 'Point':
			return tagged(
				'POINT',
				mOnly,
				geometry.coordinates.length === 0 ? 'EMPTY' : `(${formatPosition(geometry.coordinates)})`,
			);
		case 'MultiPoint':
			return tagged(
				'MULTIPOINT',
				mOnly,
				formatList(
					geometry.coordinates.map((position) => position.length === 0 ? 'EMPTY' : `(${formatPosition(position)})`),
				),
			);
		case 'LineString':
			return tagged('LINESTRING', mOnly, formatPositions(geometry.coordinates));
		case 'MultiLineString':
			return tagged('MULTILINESTRING', mOnly, formatList(geometry.coordinates.map(formatPositions)));
		case 'Polygon':
			return tagged('POLYGON', mOnly, formatRings(geometry.coordinates));
		case 'MultiPolygon':
			return tagged('MULTIPOLYGON', mOnly, formatList(geometry.coordinates.map(formatRings)));
		case 'GeometryCollection':
			return tagged(
				'GEOMETRYCOLLECTION',
				mOnly,
				formatList(geometry.geometries.map((child) => formatGeometry(child, mOnly))),
			);
		default:
			throw new Error(`Cannot write geometry of type ${String((geometry as { type: unknown }).type)} as EWKT`);
	}
}

/**
 * Writes a GeoJSON geometry as PostGIS EWKT, for example
 * `SRID=4326;MULTIPOLYGON(((19.04 47.49,...)))`.
 *
 * PostGIS reads EWKT directly, so the text works as a bound parameter, as an
 * inlined literal and as a column default. Positions with three numbers are
 * written as Z, or as M when `mOnly` is set; four numbers are ZM. Empty
 * coordinate arrays become `<TYPE> EMPTY` (or `EMPTY` inside a multi
 * geometry). Nothing is validated against the column type: PostGIS reports
 * a mismatch with a message that names it.
 *
 * Every ordinate must be a finite number; anything else throws.
 */
export function geoJSONToEWKT(geometry: Geometry, options: GeoJSONToEWKTOptions = {}): string {
	const body = formatGeometry(geometry, options.mOnly === true);
	return options.srid === undefined ? body : `SRID=${options.srid};${body}`;
}
