import { describe, expect, it } from 'vitest';
import { ewkbToGeoJSON, parseEWKB } from '../../src/utils/postgis/ewkb';
import { geoJSONToEWKT, parseEWKT } from '../../src/utils/postgis/ewkt';
import type { Geometry, Point } from '../../src/utils/postgis/geojson';

/**
 * A copy of `drizzle-orm/tests/postgis-ewkb.test.ts` run against the kit's
 * copy of the EWKB and EWKT code in `src/utils/postgis/`. The two copies
 * must stay equivalent; a vector added on one side belongs on the other.
 */

/**
 * Fixture vectors produced by PostGIS 3.4 with:
 *
 *   SELECT encode(ST_AsEWKB(wkt::geometry, 'NDR'), 'hex'),   -- ndr
 *          encode(ST_AsEWKB(wkt::geometry, 'XDR'), 'hex'),   -- xdr
 *          encode(ST_AsBinary(wkt::geometry, 'NDR'), 'hex')  -- iso (no SRID, ISO type codes)
 *
 * `ewkt` is the text the writer must produce for the parsed geometry so that
 * PostGIS reads back the same value (`ST_AsEWKT` output, minus its spacing).
 */
interface Vector {
	name: string;
	wkt: string;
	ndr: string;
	xdr: string;
	iso: string;
	srid: number | undefined;
	hasZ: boolean;
	hasM: boolean;
	geometry: Geometry;
	ewkt: string;
}

const vectors: Vector[] = [
	{
		name: 'point',
		wkt: 'POINT(1.5 -2.25)',
		ndr: '0101000000000000000000f83f00000000000002c0',
		xdr: '00000000013ff8000000000000c002000000000000',
		iso: '0101000000000000000000f83f00000000000002c0',
		srid: undefined,
		hasZ: false,
		hasM: false,
		geometry: { type: 'Point', coordinates: [1.5, -2.25] },
		ewkt: 'POINT(1.5 -2.25)',
	},
	{
		name: 'point with SRID',
		wkt: 'SRID=4326;POINT(19.0402 47.4979)',
		ndr: '0101000020e6100000984c158c4a0a3340d656ec2fbbbf4740',
		xdr: '0020000001000010e640330a4a8c154c984047bfbb2fec56d6',
		iso: '0101000000984c158c4a0a3340d656ec2fbbbf4740',
		srid: 4326,
		hasZ: false,
		hasM: false,
		geometry: { type: 'Point', coordinates: [19.0402, 47.4979] },
		ewkt: 'SRID=4326;POINT(19.0402 47.4979)',
	},
	{
		name: 'point Z',
		wkt: 'POINT Z (1 2 3)',
		ndr: '0101000080000000000000f03f00000000000000400000000000000840',
		xdr: '00800000013ff000000000000040000000000000004008000000000000',
		iso: '01e9030000000000000000f03f00000000000000400000000000000840',
		srid: undefined,
		hasZ: true,
		hasM: false,
		geometry: { type: 'Point', coordinates: [1, 2, 3] },
		ewkt: 'POINT(1 2 3)',
	},
	{
		name: 'point M',
		wkt: 'POINT M (1 2 4)',
		ndr: '0101000040000000000000f03f00000000000000400000000000001040',
		xdr: '00400000013ff000000000000040000000000000004010000000000000',
		iso: '01d1070000000000000000f03f00000000000000400000000000001040',
		srid: undefined,
		hasZ: false,
		hasM: true,
		geometry: { type: 'Point', coordinates: [1, 2, 4] },
		ewkt: 'POINTM(1 2 4)',
	},
	{
		name: 'point ZM',
		wkt: 'POINT ZM (1 2 3 4)',
		ndr: '01010000c0000000000000f03f000000000000004000000000000008400000000000001040',
		xdr: '00c00000013ff0000000000000400000000000000040080000000000004010000000000000',
		iso: '01b90b0000000000000000f03f000000000000004000000000000008400000000000001040',
		srid: undefined,
		hasZ: true,
		hasM: true,
		geometry: { type: 'Point', coordinates: [1, 2, 3, 4] },
		ewkt: 'POINT(1 2 3 4)',
	},
	{
		name: 'empty point',
		wkt: 'POINT EMPTY',
		ndr: '0101000000000000000000f87f000000000000f87f',
		xdr: '00000000017ff80000000000007ff8000000000000',
		iso: '0101000000000000000000f87f000000000000f87f',
		srid: undefined,
		hasZ: false,
		hasM: false,
		geometry: { type: 'Point', coordinates: [] },
		ewkt: 'POINT EMPTY',
	},
	{
		name: 'linestring',
		wkt: 'LINESTRING(0 0, 1 1, 2 0.5)',
		ndr:
			'01020000000300000000000000000000000000000000000000000000000000f03f000000000000f03f0000000000000040000000000000e03f',
		xdr:
			'000000000200000003000000000000000000000000000000003ff00000000000003ff000000000000040000000000000003fe0000000000000',
		iso:
			'01020000000300000000000000000000000000000000000000000000000000f03f000000000000f03f0000000000000040000000000000e03f',
		srid: undefined,
		hasZ: false,
		hasM: false,
		geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0.5]] },
		ewkt: 'LINESTRING(0 0,1 1,2 0.5)',
	},
	{
		name: 'linestring Z',
		wkt: 'LINESTRING Z (0 0 1, 1 1 2)',
		ndr:
			'01020000800200000000000000000000000000000000000000000000000000f03f000000000000f03f000000000000f03f0000000000000040',
		xdr:
			'008000000200000002000000000000000000000000000000003ff00000000000003ff00000000000003ff00000000000004000000000000000',
		iso:
			'01ea0300000200000000000000000000000000000000000000000000000000f03f000000000000f03f000000000000f03f0000000000000040',
		srid: undefined,
		hasZ: true,
		hasM: false,
		geometry: { type: 'LineString', coordinates: [[0, 0, 1], [1, 1, 2]] },
		ewkt: 'LINESTRING(0 0 1,1 1 2)',
	},
	{
		name: 'empty linestring',
		wkt: 'LINESTRING EMPTY',
		ndr: '010200000000000000',
		xdr: '000000000200000000',
		iso: '010200000000000000',
		srid: undefined,
		hasZ: false,
		hasM: false,
		geometry: { type: 'LineString', coordinates: [] },
		ewkt: 'LINESTRING EMPTY',
	},
	{
		name: 'polygon with a hole',
		wkt: 'POLYGON((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 2 1, 2 2, 1 2, 1 1))',
		ndr:
			'01030000000200000005000000000000000000000000000000000000000000000000001040000000000000000000000000000010400000000000001040000000000000000000000000000010400000000000000000000000000000000005000000000000000000f03f000000000000f03f0000000000000040000000000000f03f00000000000000400000000000000040000000000000f03f0000000000000040000000000000f03f000000000000f03f',
		xdr:
			'000000000300000002000000050000000000000000000000000000000040100000000000000000000000000000401000000000000040100000000000000000000000000000401000000000000000000000000000000000000000000000000000053ff00000000000003ff000000000000040000000000000003ff0000000000000400000000000000040000000000000003ff000000000000040000000000000003ff00000000000003ff0000000000000',
		iso:
			'01030000000200000005000000000000000000000000000000000000000000000000001040000000000000000000000000000010400000000000001040000000000000000000000000000010400000000000000000000000000000000005000000000000000000f03f000000000000f03f0000000000000040000000000000f03f00000000000000400000000000000040000000000000f03f0000000000000040000000000000f03f000000000000f03f',
		srid: undefined,
		hasZ: false,
		hasM: false,
		geometry: {
			type: 'Polygon',
			coordinates: [
				[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
				[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]],
			],
		},
		ewkt: 'POLYGON((0 0,4 0,4 4,0 4,0 0),(1 1,2 1,2 2,1 2,1 1))',
	},
	{
		name: 'empty polygon',
		wkt: 'POLYGON EMPTY',
		ndr: '010300000000000000',
		xdr: '000000000300000000',
		iso: '010300000000000000',
		srid: undefined,
		hasZ: false,
		hasM: false,
		geometry: { type: 'Polygon', coordinates: [] },
		ewkt: 'POLYGON EMPTY',
	},
	{
		name: 'multipoint',
		wkt: 'MULTIPOINT((0 0), (1 2))',
		ndr: '0104000000020000000101000000000000000000000000000000000000000101000000000000000000f03f0000000000000040',
		xdr: '00000000040000000200000000010000000000000000000000000000000000000000013ff00000000000004000000000000000',
		iso: '0104000000020000000101000000000000000000000000000000000000000101000000000000000000f03f0000000000000040',
		srid: undefined,
		hasZ: false,
		hasM: false,
		geometry: { type: 'MultiPoint', coordinates: [[0, 0], [1, 2]] },
		ewkt: 'MULTIPOINT((0 0),(1 2))',
	},
	{
		name: 'multilinestring',
		wkt: 'MULTILINESTRING((0 0, 1 1), (2 2, 3 3, 4 4))',
		ndr:
			'01050000000200000001020000000200000000000000000000000000000000000000000000000000f03f000000000000f03f010200000003000000000000000000004000000000000000400000000000000840000000000000084000000000000010400000000000001040',
		xdr:
			'000000000500000002000000000200000002000000000000000000000000000000003ff00000000000003ff0000000000000000000000200000003400000000000000040000000000000004008000000000000400800000000000040100000000000004010000000000000',
		iso:
			'01050000000200000001020000000200000000000000000000000000000000000000000000000000f03f000000000000f03f010200000003000000000000000000004000000000000000400000000000000840000000000000084000000000000010400000000000001040',
		srid: undefined,
		hasZ: false,
		hasM: false,
		geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 4]]] },
		ewkt: 'MULTILINESTRING((0 0,1 1),(2 2,3 3,4 4))',
	},
	{
		name: 'multipolygon with SRID',
		wkt:
			'SRID=3857;MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)), ((10 10, 11 10, 11 11, 10 10), (10.2 10.2, 10.4 10.2, 10.4 10.4, 10.2 10.2)))',
		ndr:
			'0106000020110f0000020000000103000000010000000400000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000f03f0000000000000000000000000000000001030000000200000004000000000000000000244000000000000024400000000000002640000000000000244000000000000026400000000000002640000000000000244000000000000024400400000066666666666624406666666666662440cdcccccccccc24406666666666662440cdcccccccccc2440cdcccccccccc244066666666666624406666666666662440',
		xdr:
			'002000000600000f110000000200000000030000000100000004000000000000000000000000000000003ff000000000000000000000000000003ff00000000000003ff000000000000000000000000000000000000000000000000000000300000002000000044024000000000000402400000000000040260000000000004024000000000000402600000000000040260000000000004024000000000000402400000000000000000004402466666666666640246666666666664024cccccccccccd40246666666666664024cccccccccccd4024cccccccccccd40246666666666664024666666666666',
		iso:
			'0106000000020000000103000000010000000400000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000f03f0000000000000000000000000000000001030000000200000004000000000000000000244000000000000024400000000000002640000000000000244000000000000026400000000000002640000000000000244000000000000024400400000066666666666624406666666666662440cdcccccccccc24406666666666662440cdcccccccccc2440cdcccccccccc244066666666666624406666666666662440',
		srid: 3857,
		hasZ: false,
		hasM: false,
		geometry: {
			type: 'MultiPolygon',
			coordinates: [
				[[[0, 0], [1, 0], [1, 1], [0, 0]]],
				[
					[[10, 10], [11, 10], [11, 11], [10, 10]],
					[[10.2, 10.2], [10.4, 10.2], [10.4, 10.4], [10.2, 10.2]],
				],
			],
		},
		ewkt:
			'SRID=3857;MULTIPOLYGON(((0 0,1 0,1 1,0 0)),((10 10,11 10,11 11,10 10),(10.2 10.2,10.4 10.2,10.4 10.4,10.2 10.2)))',
	},
	{
		name: 'empty multipolygon',
		wkt: 'MULTIPOLYGON EMPTY',
		ndr: '010600000000000000',
		xdr: '000000000600000000',
		iso: '010600000000000000',
		srid: undefined,
		hasZ: false,
		hasM: false,
		geometry: { type: 'MultiPolygon', coordinates: [] },
		ewkt: 'MULTIPOLYGON EMPTY',
	},
	{
		name: 'nested collection',
		wkt: 'GEOMETRYCOLLECTION(POINT(1 2), LINESTRING(0 0, 1 1), GEOMETRYCOLLECTION(POINT(3 4)))',
		ndr:
			'0107000000030000000101000000000000000000f03f000000000000004001020000000200000000000000000000000000000000000000000000000000f03f000000000000f03f010700000001000000010100000000000000000008400000000000001040',
		xdr:
			'00000000070000000300000000013ff00000000000004000000000000000000000000200000002000000000000000000000000000000003ff00000000000003ff0000000000000000000000700000001000000000140080000000000004010000000000000',
		iso:
			'0107000000030000000101000000000000000000f03f000000000000004001020000000200000000000000000000000000000000000000000000000000f03f000000000000f03f010700000001000000010100000000000000000008400000000000001040',
		srid: undefined,
		hasZ: false,
		hasM: false,
		geometry: {
			type: 'GeometryCollection',
			geometries: [
				{ type: 'Point', coordinates: [1, 2] },
				{ type: 'LineString', coordinates: [[0, 0], [1, 1]] },
				{ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [3, 4] }] },
			],
		},
		ewkt: 'GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,1 1),GEOMETRYCOLLECTION(POINT(3 4)))',
	},
	{
		name: 'collection ZM with SRID',
		wkt: 'SRID=4326;GEOMETRYCOLLECTION ZM (POINT ZM (1 2 3 4), POLYGON ZM ((0 0 0 0, 1 0 0 1, 1 1 0 2, 0 0 0 0)))',
		ndr:
			'01070000e0e61000000200000001010000c0000000000000f03f00000000000000400000000000000840000000000000104001030000c001000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000f03f00000000000000000000000000000000000000000000f03f000000000000f03f000000000000f03f000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000',
		xdr:
			'00e0000007000010e60000000200c00000013ff000000000000040000000000000004008000000000000401000000000000000c0000003000000010000000400000000000000000000000000000000000000000000000000000000000000003ff0000000000000000000000000000000000000000000003ff00000000000003ff00000000000003ff0000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000',
		iso:
			'01bf0b00000200000001b90b0000000000000000f03f00000000000000400000000000000840000000000000104001bb0b000001000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000f03f00000000000000000000000000000000000000000000f03f000000000000f03f000000000000f03f000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000',
		srid: 4326,
		hasZ: true,
		hasM: true,
		geometry: {
			type: 'GeometryCollection',
			geometries: [
				{ type: 'Point', coordinates: [1, 2, 3, 4] },
				{ type: 'Polygon', coordinates: [[[0, 0, 0, 0], [1, 0, 0, 1], [1, 1, 0, 2], [0, 0, 0, 0]]] },
			],
		},
		ewkt: 'SRID=4326;GEOMETRYCOLLECTION(POINT(1 2 3 4),POLYGON((0 0 0 0,1 0 0 1,1 1 0 2,0 0 0 0)))',
	},
	{
		name: 'empty collection',
		wkt: 'GEOMETRYCOLLECTION EMPTY',
		ndr: '010700000000000000',
		xdr: '000000000700000000',
		iso: '010700000000000000',
		srid: undefined,
		hasZ: false,
		hasM: false,
		geometry: { type: 'GeometryCollection', geometries: [] },
		ewkt: 'GEOMETRYCOLLECTION EMPTY',
	},
	{
		name: 'extreme magnitudes',
		wkt: 'POINT(1e21 -1e-7)',
		ndr: '010100000050efe2d6e41a4b4448afbc9af2d77abe',
		xdr: '0000000001444b1ae4d6e2ef50be7ad7f29abcaf48',
		iso: '010100000050efe2d6e41a4b4448afbc9af2d77abe',
		srid: undefined,
		hasZ: false,
		hasM: false,
		geometry: { type: 'Point', coordinates: [1e21, -1e-7] },
		ewkt: 'POINT(1e+21 -1e-7)',
	},
];

describe('parseEWKB', () => {
	for (const vector of vectors) {
		describe(vector.name, () => {
			it('parses little-endian EWKB', () => {
				expect(parseEWKB(vector.ndr)).toEqual({
					srid: vector.srid,
					geometry: vector.geometry,
					hasZ: vector.hasZ,
					hasM: vector.hasM,
				});
			});

			it('parses big-endian EWKB', () => {
				expect(parseEWKB(vector.xdr)).toEqual({
					srid: vector.srid,
					geometry: vector.geometry,
					hasZ: vector.hasZ,
					hasM: vector.hasM,
				});
			});

			it('parses ISO WKB type codes', () => {
				expect(parseEWKB(vector.iso)).toEqual({
					srid: undefined,
					geometry: vector.geometry,
					hasZ: vector.hasZ,
					hasM: vector.hasM,
				});
			});

			it('accepts upper-case hex', () => {
				expect(ewkbToGeoJSON(vector.ndr.toUpperCase())).toEqual(vector.geometry);
			});
		});
	}

	it('accepts a `\\x` prefix and raw bytes', () => {
		const point = vectors[0]!;
		expect(ewkbToGeoJSON(`\\x${point.ndr}`)).toEqual(point.geometry);
		const bytes = new Uint8Array(point.ndr.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
		expect(ewkbToGeoJSON(bytes)).toEqual(point.geometry);
	});

	it('reads the M ordinate of an M-only linestring as the third number', () => {
		// SELECT encode(ST_AsEWKB('LINESTRINGM(1 2 3,4 5 6)'::geometry), 'hex')
		const hex =
			'010200004002000000000000000000f03f00000000000000400000000000000840000000000000104000000000000014400000000000001840';
		expect(parseEWKB(hex)).toEqual({
			srid: undefined,
			hasZ: false,
			hasM: true,
			geometry: { type: 'LineString', coordinates: [[1, 2, 3], [4, 5, 6]] },
		});
	});

	it('parses a collection whose children use a different byte order than the parent', () => {
		// Big-endian collection header holding the little-endian point from the fixtures.
		const point = vectors[0]!;
		const hex = '00' + '00000007' + '00000001' + point.ndr;
		expect(ewkbToGeoJSON(hex)).toEqual({ type: 'GeometryCollection', geometries: [point.geometry] });
	});

	it('drops an SRID flag on a child geometry', () => {
		const parent = vectors[1]!;
		const hex = '01' + '04000000' + '01000000' + parent.ndr;
		expect(parseEWKB(hex)).toEqual({
			srid: undefined,
			hasZ: false,
			hasM: false,
			geometry: { type: 'MultiPoint', coordinates: [(parent.geometry as Point).coordinates] },
		});
	});

	it('rejects curve and surface types with a descriptive error', () => {
		// SELECT encode(ST_AsEWKB('CIRCULARSTRING(0 0,1 1,2 0)'::geometry), 'hex')
		expect(() =>
			ewkbToGeoJSON(
				'01080000000300000000000000000000000000000000000000000000000000f03f000000000000f03f00000000000000400000000000000000',
			)
		).toThrow(/Unsupported PostGIS geometry type CircularString \(8\)/);
		// SELECT encode(ST_AsEWKB('TIN(((0 0 0,0 0 1,0 1 0,0 0 0)))'::geometry), 'hex')
		expect(() =>
			ewkbToGeoJSON(
				'0110000080010000000111000080010000000400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f0000000000000000000000000000000000000000000000000000000000000000',
			)
		).toThrow(/Unsupported PostGIS geometry type TIN \(16\)/);
	});

	it('rejects malformed input', () => {
		expect(() => parseEWKB('0101')).toThrow(/unexpected end of data/);
		expect(() => parseEWKB('010')).toThrow(/odd number of digits/);
		expect(() => parseEWKB('zz01000000')).toThrow(/unexpected character/);
		expect(() => parseEWKB('0201000000')).toThrow(/unknown byte order marker 2/);
		expect(() => parseEWKB('0163000000')).toThrow(/unknown geometry type code 99/);
		// A MultiPoint whose child is a LineString.
		expect(() => parseEWKB('010400000001000000' + vectors[8]!.ndr)).toThrow(/expected a Point inside a MultiPoint/);
	});
});

describe('geoJSONToEWKT', () => {
	for (const vector of vectors) {
		it(`writes ${vector.name}`, () => {
			expect(geoJSONToEWKT(vector.geometry, { srid: vector.srid, mOnly: vector.hasM && !vector.hasZ })).toBe(
				vector.ewkt,
			);
		});
	}

	it('writes empty parts inside multi geometries and collections', () => {
		expect(geoJSONToEWKT({ type: 'MultiPoint', coordinates: [[1, 2], []] })).toBe('MULTIPOINT((1 2),EMPTY)');
		expect(geoJSONToEWKT({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], []] })).toBe(
			'MULTILINESTRING((0 0,1 1),EMPTY)',
		);
		expect(geoJSONToEWKT({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], []] })).toBe(
			'MULTIPOLYGON(((0 0,1 0,1 1,0 0)),EMPTY)',
		);
		expect(
			geoJSONToEWKT({
				type: 'GeometryCollection',
				geometries: [{ type: 'Point', coordinates: [] }, { type: 'GeometryCollection', geometries: [] }],
			}),
		).toBe('GEOMETRYCOLLECTION(POINT EMPTY,GEOMETRYCOLLECTION EMPTY)');
	});

	it('applies the M suffix to every geometry of a collection', () => {
		expect(
			geoJSONToEWKT(
				{
					type: 'GeometryCollection',
					geometries: [
						{ type: 'Point', coordinates: [1, 2, 3] },
						{ type: 'LineString', coordinates: [[0, 0, 0], [1, 1, 1]] },
					],
				},
				{ srid: 4326, mOnly: true },
			),
		).toBe('SRID=4326;GEOMETRYCOLLECTIONM(POINTM(1 2 3),LINESTRINGM(0 0 0,1 1 1))');
	});

	it('writes SRID 0 when it is given explicitly', () => {
		expect(geoJSONToEWKT({ type: 'Point', coordinates: [1, 2] }, { srid: 0 })).toBe('SRID=0;POINT(1 2)');
	});

	it('ignores bbox', () => {
		expect(geoJSONToEWKT({ type: 'Point', coordinates: [1, 2], bbox: [1, 2, 1, 2] })).toBe('POINT(1 2)');
	});

	it('rejects non-finite ordinates and unknown types', () => {
		expect(() => geoJSONToEWKT({ type: 'Point', coordinates: [Number.NaN, 1] })).toThrow(/finite/);
		expect(() => geoJSONToEWKT({ type: 'Point', coordinates: [1, Number.POSITIVE_INFINITY] })).toThrow(/finite/);
		expect(() => geoJSONToEWKT({ type: 'Point', coordinates: ['1' as unknown as number, 2] })).toThrow(/finite/);
		expect(() => geoJSONToEWKT({ type: 'Circle', coordinates: [1, 2] } as unknown as Geometry)).toThrow(
			/type Circle/,
		);
	});
});

describe('parseEWKT', () => {
	for (const vector of vectors) {
		it(`reads ${vector.name}`, () => {
			expect(parseEWKT(vector.ewkt)).toStrictEqual({
				srid: vector.srid,
				geometry: vector.geometry,
				hasZ: vector.hasZ,
				hasM: vector.hasM,
			});
		});
	}

	it('accepts PostGIS spacing, casing and bare multipoint positions', () => {
		expect(parseEWKT('SRID=4326; point z ( 1 2 3 )')).toStrictEqual({
			srid: 4326,
			geometry: { type: 'Point', coordinates: [1, 2, 3] },
			hasZ: true,
			hasM: false,
		});
		expect(parseEWKT('POINT M (1 2 4)')).toStrictEqual({
			srid: undefined,
			geometry: { type: 'Point', coordinates: [1, 2, 4] },
			hasZ: false,
			hasM: true,
		});
		expect(parseEWKT('MULTIPOINT(1 2, 3 4, EMPTY)').geometry).toStrictEqual({
			type: 'MultiPoint',
			coordinates: [[1, 2], [3, 4], []],
		});
		expect(parseEWKT('GEOMETRYCOLLECTIONM(POINTM(1 2 3),LINESTRINGM(0 0 0,1 1 1))')).toStrictEqual({
			srid: undefined,
			hasZ: false,
			hasM: true,
			geometry: {
				type: 'GeometryCollection',
				geometries: [
					{ type: 'Point', coordinates: [1, 2, 3] },
					{ type: 'LineString', coordinates: [[0, 0, 0], [1, 1, 1]] },
				],
			},
		});
		expect(parseEWKT('POINT(1e+21 -1e-7)').geometry).toStrictEqual({ type: 'Point', coordinates: [1e21, -1e-7] });
	});

	it('rejects malformed text', () => {
		expect(() => parseEWKT('CIRCULARSTRING(0 0,1 1,2 0)')).toThrow(/expected a geometry type keyword/);
		expect(() => parseEWKT('POINT(1)')).toThrow(/expected a number/);
		expect(() => parseEWKT('POINT(1 2')).toThrow(/expected '\)'/);
		expect(() => parseEWKT('POINT(1 2) trailing')).toThrow(/unexpected trailing text/);
		expect(() => parseEWKT('POINT(1 2 3 4 5)')).toThrow(/too many ordinates/);
	});
});
