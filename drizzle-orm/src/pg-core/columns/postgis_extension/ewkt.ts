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

/**
 * Result of {@link parseEWKT}.
 */
export interface ParsedEWKT {
	/** SRID from the `SRID=n;` prefix, or `undefined` when there is none. */
	srid: number | undefined;
	/** The geometry as GeoJSON. */
	geometry: Geometry;
	/** `true` when the positions carry a Z ordinate. */
	hasZ: boolean;
	/** `true` when the positions carry an M ordinate. */
	hasM: boolean;
}

const EWKT_KEYWORD =
	/^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\s*(ZM|Z|M)?\b/i;
const EWKT_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;

/**
 * Parses PostGIS EWKT (or WKT) into GeoJSON: the inverse of
 * {@link geoJSONToEWKT}.
 *
 * It reads the seven GeoJSON-representable types, an optional `SRID=n;`
 * prefix, the `Z`, `M` and `ZM` keyword suffixes (attached or separated by
 * a space), `EMPTY` at any level and both point forms inside a MultiPoint
 * (`MULTIPOINT((1 2),(3 4))` and `MULTIPOINT(1 2,3 4)`). Without a suffix,
 * three numbers per position are X, Y and Z, and four are X, Y, Z and M,
 * as in PostGIS. Curve types throw.
 */
export function parseEWKT(text: string): ParsedEWKT {
	let pos = 0;
	const skipSpace = () => {
		while (pos < text.length && /\s/.test(text[pos]!)) pos++;
	};
	const fail = (what: string): never => {
		throw new Error(`Invalid EWKT: ${what} at position ${pos} in ${JSON.stringify(text)}`);
	};
	const expect = (char: string) => {
		skipSpace();
		if (text[pos] !== char) fail(`expected '${char}'`);
		pos++;
	};
	const peek = (char: string): boolean => {
		skipSpace();
		return text[pos] === char;
	};
	const isEmpty = (): boolean => {
		skipSpace();
		if (text.slice(pos, pos + 5).toUpperCase() === 'EMPTY') {
			pos += 5;
			return true;
		}
		return false;
	};

	let hasZ = false;
	let hasM = false;
	/** Dimension mode of the geometry being read: set by a keyword suffix, else by the first position. */
	let mode: 'z' | 'm' | 'zm' | undefined;

	const readNumber = (): number => {
		skipSpace();
		const match = EWKT_NUMBER.exec(text.slice(pos));
		if (!match) fail('expected a number');
		pos += match![0].length;
		return Number(match![0]);
	};
	const readPosition = (): Position => {
		const position: Position = [readNumber(), readNumber()];
		while (!peek(',') && !peek(')') && pos < text.length) position.push(readNumber());
		if (position.length > 4) fail('too many ordinates in a position');
		if (mode === undefined && position.length === 3) mode = 'z';
		if (mode === undefined && position.length === 4) mode = 'zm';
		if (position.length === 3) {
			if (mode === 'm') hasM = true;
			else hasZ = true;
		} else if (position.length === 4) {
			hasZ = true;
			hasM = true;
		}
		return position;
	};
	const readList = <T>(item: () => T): T[] => {
		const items: T[] = [];
		expect('(');
		items.push(item());
		while (peek(',')) {
			pos++;
			items.push(item());
		}
		expect(')');
		return items;
	};
	const readPositions = (): Position[] => isEmpty() ? [] : readList(readPosition);
	const readRings = (): Position[][] => isEmpty() ? [] : readList(readPositions);
	const readPointPart = (): Position => {
		if (isEmpty()) return [];
		if (peek('(')) {
			pos++;
			const position = readPosition();
			expect(')');
			return position;
		}
		return readPosition();
	};

	const readGeometry = (): Geometry => {
		skipSpace();
		const match = EWKT_KEYWORD.exec(text.slice(pos));
		if (!match) fail('expected a geometry type keyword');
		pos += match![0].length;
		const keyword = match![1]!.toUpperCase();
		const suffix = match![2]?.toUpperCase();
		if (suffix === 'M') mode = 'm';
		else if (suffix === 'Z') mode = 'z';
		else if (suffix === 'ZM') mode = 'zm';

		switch (keyword) {
			case 'POINT':
				return { type: 'Point', coordinates: isEmpty() ? [] : readList(readPosition)[0]! };
			case 'LINESTRING':
				return { type: 'LineString', coordinates: readPositions() };
			case 'POLYGON':
				return { type: 'Polygon', coordinates: readRings() };
			case 'MULTIPOINT':
				return { type: 'MultiPoint', coordinates: isEmpty() ? [] : readList(readPointPart) };
			case 'MULTILINESTRING':
				return { type: 'MultiLineString', coordinates: isEmpty() ? [] : readList(readPositions) };
			case 'MULTIPOLYGON':
				return { type: 'MultiPolygon', coordinates: isEmpty() ? [] : readList(readRings) };
			default:
				return { type: 'GeometryCollection', geometries: isEmpty() ? [] : readList(readGeometry) };
		}
	};

	let srid: number | undefined;
	skipSpace();
	const sridMatch = /^SRID\s*=\s*(\d+)\s*;/i.exec(text.slice(pos));
	if (sridMatch) {
		srid = Number(sridMatch[1]);
		pos += sridMatch[0].length;
	}
	const geometry = readGeometry();
	skipSpace();
	if (pos !== text.length) fail('unexpected trailing text');
	return { srid, geometry, hasZ, hasM };
}
