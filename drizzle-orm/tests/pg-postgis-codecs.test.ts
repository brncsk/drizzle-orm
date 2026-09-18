import { describe, expect, test } from 'vitest';
import { nodePgCodecs } from '~/node-postgres/codecs';
import { customType, PgDialect, pgTable } from '~/pg-core';
import { genericPgCodecs, resolvePgTypeAlias } from '~/pg-core/codecs';
import { postgresJsCodecs } from '~/postgres-js/codecs';
import { sql, type SQLChunk } from '~/sql';

// SELECT encode(ST_AsEWKB('SRID=4326;POINT(19.0402 47.4979)'::geometry), 'hex')
const POINT_HEX = '0101000020e6100000984c158c4a0a3340d656ec2fbbbf4740';
// SELECT encode(ST_AsEWKB('LINESTRING(0 0,1 1)'::geometry), 'hex')
const LINE_HEX = '01020000000200000000000000000000000000000000000000000000000000f03f000000000000f03f';

const point = { type: 'Point', coordinates: [19.0402, 47.4979] };
const line = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };

describe('resolvePgTypeAlias', () => {
	test('maps every PostGIS typmod key to the GeoJSON codec', () => {
		expect(resolvePgTypeAlias('geometry')).toBe('geometry');
		expect(resolvePgTypeAlias('geometry(point)')).toBe('geometry');
		expect(resolvePgTypeAlias('geometry(multipolygonzm)')).toBe('geometry');
		expect(resolvePgTypeAlias('geometry(MultiPolygon,4326)')).toBe('geometry');
		expect(resolvePgTypeAlias('Geometry(Point, 3857)')).toBe('geometry');
		expect(resolvePgTypeAlias('geography')).toBe('geography');
		expect(resolvePgTypeAlias('geography(point)')).toBe('geography');
		expect(resolvePgTypeAlias('geography(Polygon,4326)')).toBe('geography');
	});

	test('keeps the point-only modes', () => {
		expect(resolvePgTypeAlias('geometry:tuple')).toBe('geometry:tuple');
		expect(resolvePgTypeAlias('geometry(point):tuple')).toBe('geometry:tuple');
		expect(resolvePgTypeAlias('geometry(point,4326):xy')).toBe('geometry:xy');
		expect(resolvePgTypeAlias('GEOMETRY(POINT):XY')).toBe('geometry:xy');
	});

	test('leaves static aliases and unknown keys alone', () => {
		expect(resolvePgTypeAlias('int4')).toBe('int');
		expect(resolvePgTypeAlias('character varying')).toBe('varchar');
		expect(resolvePgTypeAlias('geometric')).toBe('geometric');
		expect(resolvePgTypeAlias('geometry_dump')).toBe('geometry_dump');
	});
});

describe('custom columns', () => {
	test('resolve a typmod codec key to the GeoJSON codec', () => {
		const geom = customType<{ data: unknown }>({
			dataType: () => 'geometry(polygon,4326)',
			codec: 'geometry(polygon)',
		});
		const geog = customType<{ data: unknown }>({
			dataType: () => 'geography(point)',
			codec: 'geography(point)',
		});
		const tuple = customType<{ data: unknown }>({
			dataType: () => 'geometry(point)',
			codec: 'geometry(point):tuple',
		});
		const t = pgTable('t', { geom: geom(), geog: geog(), tuple: tuple() });
		expect(t.geom.codec).toBe('geometry');
		expect(t.geog.codec).toBe('geography');
		expect(t.tuple.codec).toBe('geometry:tuple');
	});
});

describe('driver codecs', () => {
	test('decode hex EWKB to GeoJSON for `geometry` and `geography`', () => {
		for (const codecs of [nodePgCodecs, postgresJsCodecs]) {
			expect(codecs.geometry!.normalize!(POINT_HEX)).toStrictEqual(point);
			expect(codecs.geography!.normalize!(LINE_HEX)).toStrictEqual(line);
			expect(codecs['geometry:tuple']!.normalize!(POINT_HEX)).toStrictEqual([19.0402, 47.4979]);
			expect(codecs['geometry:xy']!.normalize!(POINT_HEX)).toStrictEqual({ x: 19.0402, y: 47.4979 });
		}
	});

	test('decode `:`-delimited geometry array text', () => {
		expect(nodePgCodecs.geometry!.normalizeArray!(`{${POINT_HEX}:${LINE_HEX}}`, 1)).toStrictEqual([point, line]);
		// PostGIS uses `:` between elements at every depth of a geometry array.
		expect(nodePgCodecs.geography!.normalizeArray!(`{{${POINT_HEX}}:{${LINE_HEX}}}`, 2)).toStrictEqual([[point], [
			line,
		]]);
		// postgres.js splits the array itself.
		expect(postgresJsCodecs.geometry!.normalizeArray!([POINT_HEX, LINE_HEX], 1)).toStrictEqual([point, line]);
	});

	test('write geometry arrays with the `:` delimiter', () => {
		expect(nodePgCodecs.geometry!.normalizeParamArray!(['POINT(1 2)', 'POINT(3 4)'], 1)).toBe(
			'{"POINT(1 2)":"POINT(3 4)"}',
		);
	});

	test('cast to text inside JSON so PostGIS does not apply its implicit json cast', () => {
		const name = sql.identifier('geom');
		const render = (chunk: SQLChunk) => new PgDialect().sqlToQuery(sql`${chunk}`).sql;
		expect(render(genericPgCodecs.geometry.castInJson(name))).toBe('"geom"::text');
		expect(render(genericPgCodecs.geography.castArrayInJson(name, 2))).toBe('"geom"::text[][]');
		expect(genericPgCodecs.geometry.normalizeInJson(POINT_HEX)).toStrictEqual(point);
		expect(genericPgCodecs.geography.normalizeArrayInJson([LINE_HEX], 1)).toStrictEqual([line]);
	});
});
