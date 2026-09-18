/**
 * PostGIS EWKB reader.
 *
 * This file is a copy of `drizzle-orm/src/pg-core/columns/postgis_extension/ewkb.ts`
 * without the `entityKind` tag, which the kit does not use. The postgres
 * grammar turns the EWKB hex that `pg_attrdef` stores back into a default
 * on the static import path of `drizzle-kit/api`, and that path must not
 * load `drizzle-orm` at runtime (see `tests/other/bin.test.ts`), so the kit
 * carries its own copy. Keep the two files in step.
 */
import type { Geometry, LineString, Point, Polygon, Position } from './geojson';

/**
 * Result of {@link parseEWKB}.
 */
export interface ParsedEWKB {
	/** SRID from the EWKB header, or `undefined` when the header has none. */
	srid: number | undefined;
	/** The geometry as GeoJSON. */
	geometry: Geometry;
	/** `true` when the positions carry a Z ordinate. */
	hasZ: boolean;
	/** `true` when the positions carry an M ordinate. */
	hasM: boolean;
}

/** EWKB type flag: the positions carry a Z ordinate. */
const EWKB_Z = 0x80000000;
/** EWKB type flag: the positions carry an M ordinate. */
const EWKB_M = 0x40000000;
/** EWKB type flag: an SRID follows the type word. */
const EWKB_SRID = 0x20000000;

/** WKB base type codes, as the OGC specification assigns them. */
const WKB_POINT = 1;
const WKB_LINESTRING = 2;
const WKB_POLYGON = 3;
const WKB_MULTIPOINT = 4;
const WKB_MULTILINESTRING = 5;
const WKB_MULTIPOLYGON = 6;
const WKB_GEOMETRYCOLLECTION = 7;

/**
 * Names of the WKB type codes that GeoJSON cannot represent. They are only
 * used in error messages.
 */
const UNSUPPORTED_WKB_TYPES: Record<number, string> = {
	8: 'CircularString',
	9: 'CompoundCurve',
	10: 'CurvePolygon',
	11: 'MultiCurve',
	12: 'MultiSurface',
	13: 'Curve',
	14: 'Surface',
	15: 'PolyhedralSurface',
	16: 'TIN',
	17: 'Triangle',
};

/** Value of one hex digit by character code; `-1` for every other character. */
const HEX_DIGITS = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; i++) HEX_DIGITS[48 + i] = i;
for (let i = 0; i < 6; i++) {
	HEX_DIGITS[65 + i] = 10 + i;
	HEX_DIGITS[97 + i] = 10 + i;
}

/**
 * Decodes a hex string into bytes. It accepts upper and lower case digits
 * and an optional `\x` or `0x` prefix. It does not use `Buffer`, so it runs
 * in browsers and edge runtimes.
 */
function hexToBytes(hex: string): Uint8Array {
	let start = 0;
	if (hex.length >= 2 && (hex[0] === '\\' || hex[0] === '0') && (hex[1] === 'x' || hex[1] === 'X')) {
		start = 2;
	}
	const digits = hex.length - start;
	if (digits % 2 !== 0) {
		throw new Error(`Invalid EWKB hex string: odd number of digits (${digits})`);
	}
	const bytes = new Uint8Array(digits / 2);
	for (let i = 0, j = start; i < bytes.length; i++, j += 2) {
		const hi = HEX_DIGITS[hex.charCodeAt(j)] ?? -1;
		const lo = HEX_DIGITS[hex.charCodeAt(j + 1)] ?? -1;
		if (hi < 0 || lo < 0) {
			throw new Error(`Invalid EWKB hex string: unexpected character at position ${j}`);
		}
		bytes[i] = (hi << 4) | lo;
	}
	return bytes;
}

/** Sequential reader over a byte array. */
class EwkbReader {
	private readonly view: DataView;
	private offset = 0;

	constructor(private readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	private ensure(length: number): void {
		if (this.offset + length > this.bytes.byteLength) {
			throw new Error(
				`Invalid EWKB: unexpected end of data at byte ${this.offset} (need ${length} more, have ${
					this.bytes.byteLength - this.offset
				})`,
			);
		}
	}

	uint8(): number {
		this.ensure(1);
		return this.bytes[this.offset++]!;
	}

	uint32(littleEndian: boolean): number {
		this.ensure(4);
		const value = this.view.getUint32(this.offset, littleEndian);
		this.offset += 4;
		return value;
	}

	float64(littleEndian: boolean): number {
		this.ensure(8);
		const value = this.view.getFloat64(this.offset, littleEndian);
		this.offset += 8;
		return value;
	}
}

/** Header of one WKB record, shared by the top level and every child. */
interface EwkbHeader {
	littleEndian: boolean;
	type: number;
	hasZ: boolean;
	hasM: boolean;
	srid: number | undefined;
}

/**
 * Reads the byte order byte, the type word and the optional SRID.
 *
 * The type word can use the PostGIS flag bits (`0x80000000` Z, `0x40000000`
 * M, `0x20000000` SRID) or the ISO WKB offsets (`1000` Z, `2000` M,
 * `3000` ZM). Both are accepted, and both can appear in one stream, because
 * a collection written by one producer can contain children from another.
 */
function readHeader(reader: EwkbReader): EwkbHeader {
	const byteOrder = reader.uint8();
	if (byteOrder !== 0 && byteOrder !== 1) {
		throw new Error(`Invalid EWKB: unknown byte order marker ${byteOrder}`);
	}
	const littleEndian = byteOrder === 1;
	const typeWord = reader.uint32(littleEndian);

	let hasZ = (typeWord & EWKB_Z) !== 0;
	let hasM = (typeWord & EWKB_M) !== 0;
	const hasSrid = (typeWord & EWKB_SRID) !== 0;

	let type = typeWord & 0x0fffffff;
	if (type >= 3000 && type < 4000) {
		hasZ = true;
		hasM = true;
		type -= 3000;
	} else if (type >= 2000 && type < 3000) {
		hasM = true;
		type -= 2000;
	} else if (type >= 1000 && type < 2000) {
		hasZ = true;
		type -= 1000;
	}

	const srid = hasSrid ? reader.uint32(littleEndian) : undefined;
	return { littleEndian, type, hasZ, hasM, srid };
}

function readPosition(reader: EwkbReader, header: EwkbHeader): Position {
	const x = reader.float64(header.littleEndian);
	const y = reader.float64(header.littleEndian);
	if (!header.hasZ && !header.hasM) return [x, y];
	const third = reader.float64(header.littleEndian);
	if (header.hasZ && header.hasM) {
		return [x, y, third, reader.float64(header.littleEndian)];
	}
	return [x, y, third];
}

function readPositions(reader: EwkbReader, header: EwkbHeader): Position[] {
	const count = reader.uint32(header.littleEndian);
	const positions: Position[] = new Array(count);
	for (let i = 0; i < count; i++) {
		positions[i] = readPosition(reader, header);
	}
	return positions;
}

function readPoint(reader: EwkbReader, header: EwkbHeader): Point {
	const position = readPosition(reader, header);
	// PostGIS stores `POINT EMPTY` as a point whose ordinates are all NaN.
	let empty = true;
	for (const ordinate of position) {
		if (!Number.isNaN(ordinate)) {
			empty = false;
			break;
		}
	}
	return { type: 'Point', coordinates: empty ? [] : position };
}

function readLineString(reader: EwkbReader, header: EwkbHeader): LineString {
	return { type: 'LineString', coordinates: readPositions(reader, header) };
}

function readPolygon(reader: EwkbReader, header: EwkbHeader): Polygon {
	const ringCount = reader.uint32(header.littleEndian);
	const rings: Position[][] = new Array(ringCount);
	for (let i = 0; i < ringCount; i++) {
		rings[i] = readPositions(reader, header);
	}
	return { type: 'Polygon', coordinates: rings };
}

/**
 * Reads the children of a multi geometry or collection. Every child is a
 * full WKB record with its own byte order byte and type word; an SRID flag
 * on a child is read and dropped.
 */
function readChildren(reader: EwkbReader, header: EwkbHeader, expected: Geometry['type'] | undefined): Geometry[] {
	const count = reader.uint32(header.littleEndian);
	const children: Geometry[] = new Array(count);
	for (let i = 0; i < count; i++) {
		const child = readGeometry(reader);
		if (expected !== undefined && child.type !== expected) {
			throw new Error(`Invalid EWKB: expected a ${expected} inside a Multi${expected}, got ${child.type}`);
		}
		children[i] = child;
	}
	return children;
}

function readBody(reader: EwkbReader, header: EwkbHeader): Geometry {
	switch (header.type) {
		case WKB_POINT:
			return readPoint(reader, header);
		case WKB_LINESTRING:
			return readLineString(reader, header);
		case WKB_POLYGON:
			return readPolygon(reader, header);
		case WKB_MULTIPOINT:
			return {
				type: 'MultiPoint',
				coordinates: (readChildren(reader, header, 'Point') as Point[]).map((point) => point.coordinates),
			};
		case WKB_MULTILINESTRING:
			return {
				type: 'MultiLineString',
				coordinates: (readChildren(reader, header, 'LineString') as LineString[]).map((line) => line.coordinates),
			};
		case WKB_MULTIPOLYGON:
			return {
				type: 'MultiPolygon',
				coordinates: (readChildren(reader, header, 'Polygon') as Polygon[]).map((polygon) => polygon.coordinates),
			};
		case WKB_GEOMETRYCOLLECTION:
			return { type: 'GeometryCollection', geometries: readChildren(reader, header, undefined) };
		default: {
			const name = UNSUPPORTED_WKB_TYPES[header.type];
			if (name !== undefined) {
				throw new Error(
					`Unsupported PostGIS geometry type ${name} (${header.type}): only GeoJSON-representable types can be read as GeoJSON; use customType or $type()`,
				);
			}
			throw new Error(`Invalid EWKB: unknown geometry type code ${header.type}`);
		}
	}
}

function readGeometry(reader: EwkbReader): Geometry {
	return readBody(reader, readHeader(reader));
}

/**
 * Parses PostGIS EWKB (or ISO WKB) into GeoJSON.
 *
 * PostGIS sends `geometry` and `geography` values as hex-encoded EWKB. The
 * function accepts that text, or the raw bytes, and returns the geometry
 * together with the SRID and the dimension flags from the header. Use
 * {@link ewkbToGeoJSON} when only the geometry is needed.
 *
 * Both byte orders are accepted, per record, so a collection can mix them.
 * `POINT EMPTY` (all ordinates NaN) becomes `coordinates: []`; an empty
 * line, polygon, multi geometry or collection becomes an empty array.
 * Z is returned as the third number of a position. M is returned as the
 * third number of an M-only geometry and as the fourth number of a ZM
 * geometry; RFC 7946 has no M, so this is an extension.
 *
 * Curve, surface, TIN and triangle types have no GeoJSON form. Parsing one
 * throws an error that names the type.
 *
 * @param input hex string (`0101000000...`, optionally prefixed with `\x`) or bytes
 */
export function parseEWKB(input: string | Uint8Array): ParsedEWKB {
	const reader = new EwkbReader(typeof input === 'string' ? hexToBytes(input) : input);
	const header = readHeader(reader);
	const geometry = readBody(reader, header);
	return { srid: header.srid, geometry, hasZ: header.hasZ, hasM: header.hasM };
}

/**
 * Parses PostGIS EWKB (or ISO WKB) into a GeoJSON geometry. See
 * {@link parseEWKB} for the format rules. This is the function the column
 * codecs use.
 */
export function ewkbToGeoJSON(input: string | Uint8Array): Geometry {
	return parseEWKB(input).geometry;
}
