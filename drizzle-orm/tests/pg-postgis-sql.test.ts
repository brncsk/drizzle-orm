import { describe, expect, test } from 'vitest';
import { getTableColumns } from '~/index.ts';
import {
	customType,
	geography,
	geometry,
	PgGeography,
	PgGeometry,
	PgGeometryObject,
	PgGeometryTuple,
	pgTable,
} from '~/pg-core';
import { drizzle } from '~/pglite';
import { defineRelations } from '~/relations';
import { sql } from '~/sql';

const db = drizzle.mock();

describe('DDL types', () => {
	test('geometry', () => {
		const t = pgTable('t', {
			bare: geometry(),
			anyWithSrid: geometry({ srid: 4326 }),
			explicitAny: geometry({ type: 'Geometry' }),
			explicitAnyWithSrid: geometry({ type: 'geometry', srid: 4326 }),
			multiPolygon: geometry({ type: 'MultiPolygon' }),
			multiPolygonWithSrid: geometry({ type: 'MultiPolygon', srid: 4326 }),
			pointZM: geometry({ type: 'PointZM', srid: 3857 }),
			lowercase: geometry({ type: 'linestringz' }),
			curve: geometry({ type: 'CircularString' }),
			tuple: geometry({ type: 'Point', mode: 'tuple' }),
			xy: geometry({ type: 'point', mode: 'xy', srid: 4326 }),
			array: geometry({ type: 'Polygon', srid: 4326 }).array(),
			matrix: geometry({ type: 'Point' }).array('[][]'),
		});
		const types = Object.fromEntries(
			Object.entries(getTableColumns(t)).map(([key, column]) => [key, column.getSQLType()]),
		);
		expect(types).toStrictEqual({
			bare: 'geometry',
			anyWithSrid: 'geometry(geometry,4326)',
			explicitAny: 'geometry',
			explicitAnyWithSrid: 'geometry(geometry,4326)',
			multiPolygon: 'geometry(multipolygon)',
			multiPolygonWithSrid: 'geometry(multipolygon,4326)',
			pointZM: 'geometry(pointzm,3857)',
			lowercase: 'geometry(linestringz)',
			curve: 'geometry(circularstring)',
			tuple: 'geometry(point)',
			xy: 'geometry(point,4326)',
			array: 'geometry(polygon,4326)',
			matrix: 'geometry(point)',
		});
		expect(t.array.dimensions).toBe(1);
		expect(t.matrix.dimensions).toBe(2);
	});

	test('geography', () => {
		const t = pgTable('t', {
			bare: geography(),
			point: geography({ type: 'Point' }),
			pointWithSrid: geography({ type: 'Point', srid: 4269 }),
			anyWithSrid: geography({ srid: 4326 }),
		});
		expect(t.bare.getSQLType()).toBe('geography');
		expect(t.point.getSQLType()).toBe('geography(point)');
		expect(t.pointWithSrid.getSQLType()).toBe('geography(point,4269)');
		expect(t.anyWithSrid.getSQLType()).toBe('geography(geometry,4326)');
	});
});

describe('column classes', () => {
	test('are selected by mode and expose their options', () => {
		const t = pgTable('t', {
			geojson: geometry({ type: 'MultiPolygon', srid: 4326 }),
			tuple: geometry({ type: 'Point', mode: 'tuple', srid: 4326 }),
			xy: geometry({ type: 'Point', mode: 'xy' }),
			geography: geography({ type: 'PointM' }),
		});
		expect(t.geojson).toBeInstanceOf(PgGeometry);
		expect(t.tuple).toBeInstanceOf(PgGeometryTuple);
		expect(t.xy).toBeInstanceOf(PgGeometryObject);
		expect(t.geography).toBeInstanceOf(PgGeography);

		expect([t.geojson.type, t.geojson.srid, t.geojson.mode, t.geojson.mOnly]).toStrictEqual([
			'MultiPolygon',
			4326,
			'geojson',
			false,
		]);
		expect([t.tuple.type, t.tuple.srid, t.tuple.mode]).toStrictEqual(['Point', 4326, 'tuple']);
		expect([t.xy.type, t.xy.srid, t.xy.mode]).toStrictEqual(['Point', undefined, 'object']);
		expect([t.geography.type, t.geography.srid, t.geography.mode, t.geography.mOnly]).toStrictEqual([
			'PointM',
			undefined,
			'geojson',
			true,
		]);

		expect(t.geojson.codec).toBe('geometry');
		expect(t.tuple.codec).toBe('geometry:tuple');
		expect(t.xy.codec).toBe('geometry:xy');
		expect(t.geography.codec).toBe('geography');
		expect(t.geojson.dataType).toBe('object geojson');
		expect(t.geography.dataType).toBe('object geojson');
	});

	test('reject the point modes for other subtypes', () => {
		expect(() => geometry({ type: 'Polygon', mode: 'tuple' } as never)).toThrow(
			/mode 'tuple' is only available with type 'Point' \(got 'Polygon'\)/,
		);
		expect(() => geometry({ mode: 'xy' } as never)).toThrow(
			/mode 'xy' is only available with type 'Point' \(got no type\)/,
		);
	});

	test('survive `toBuilder()`', () => {
		const t = pgTable('t', {
			geojson: geometry({ type: 'MultiPolygonZ', srid: 4326 }).notNull(),
			xy: geometry({ type: 'Point', mode: 'xy', srid: 3857 }),
			geography: geography({ type: 'Point' }).array(),
		});
		const clone = pgTable('clone', {
			geojson: t.geojson.toBuilder(),
			xy: t.xy.toBuilder(),
			geography: t.geography.toBuilder(),
		});
		expect(clone.geojson).toBeInstanceOf(PgGeometry);
		expect(clone.geojson.getSQLType()).toBe('geometry(multipolygonz,4326)');
		expect(clone.geojson.notNull).toBe(true);
		expect(clone.xy).toBeInstanceOf(PgGeometryObject);
		expect(clone.xy.getSQLType()).toBe('geometry(point,3857)');
		expect(clone.geography).toBeInstanceOf(PgGeography);
		expect(clone.geography.getSQLType()).toBe('geography(point)');
		expect(clone.geography.dimensions).toBe(1);
	});
});

describe('values written to the driver', () => {
	const t = pgTable('t', {
		id: geometry(),
		footprint: geometry({ type: 'MultiPolygon', srid: 4326 }),
		axis: geometry({ type: 'LineStringM', srid: 3857 }),
		tuple: geometry({ type: 'Point', mode: 'tuple', srid: 4326 }),
		xy: geometry({ type: 'Point', mode: 'xy' }),
		place: geography({ type: 'Point' }),
		parts: geometry({ type: 'Polygon', srid: 4326 }).array(),
	});

	test('GeoJSON becomes EWKT with the column SRID', () => {
		expect(t.id.mapToDriverValue({ type: 'Point', coordinates: [1, 2] })).toBe('POINT(1 2)');
		expect(
			t.footprint.mapToDriverValue({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] }),
		).toBe('SRID=4326;MULTIPOLYGON(((0 0,1 0,1 1,0 0)))');
		expect(t.axis.mapToDriverValue({ type: 'LineString', coordinates: [[0, 0, 5], [1, 1, 6]] })).toBe(
			'SRID=3857;LINESTRINGM(0 0 5,1 1 6)',
		);
		expect(t.place.mapToDriverValue({ type: 'Point', coordinates: [19.04, 47.49] })).toBe('POINT(19.04 47.49)');
	});

	test('point modes write EWKT points', () => {
		expect(t.tuple.mapToDriverValue([1.5, 2])).toBe('SRID=4326;POINT(1.5 2)');
		expect(t.xy.mapToDriverValue({ x: 1, y: -2 })).toBe('POINT(1 -2)');
	});

	test('strings pass through unchanged', () => {
		expect(t.footprint.mapToDriverValue('SRID=4326;MULTIPOLYGON EMPTY')).toBe('SRID=4326;MULTIPOLYGON EMPTY');
		expect(t.id.mapToDriverValue('0101000000000000000000f03f0000000000000040')).toBe(
			'0101000000000000000000f03f0000000000000040',
		);
	});

	test('arrays are written element by element', () => {
		expect(
			t.parts.mapToDriverValue([
				{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
				null,
				{ type: 'Polygon', coordinates: [] },
			]),
		).toStrictEqual(['SRID=4326;POLYGON((0 0,1 0,1 1,0 0))', null, 'SRID=4326;POLYGON EMPTY']);
	});

	test('insert and update parameters', () => {
		const insert = db.insert(t).values({
			footprint: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
			tuple: [1, 2],
			parts: [{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }],
		}).toSQL();
		expect(insert.sql).toBe(
			'insert into "t" ("id", "footprint", "axis", "tuple", "xy", "place", "parts") values (default, $1::geometry, default, $2::geometry, default, default, $3::geometry[])',
		);
		expect(insert.params).toStrictEqual([
			'SRID=4326;MULTIPOLYGON(((0 0,1 0,1 1,0 0)))',
			'SRID=4326;POINT(1 2)',
			'{"SRID=4326;POLYGON((0 0,1 0,1 1,0 0))"}',
		]);

		const update = db.update(t).set({ place: { type: 'Point', coordinates: [1, 2] } }).toSQL();
		expect(update.sql).toBe('update "t" set "place" = $1::geography');
		expect(update.params).toStrictEqual(['POINT(1 2)']);

		// Inlined parameters skip the codec hooks, so the EWKT text must be valid PostGIS input as it is.
		const inlined = db.dialect.sqlToQuery(db.insert(t).values({ xy: { x: 3, y: 4 } }).getSQL().inlineParams());
		expect(inlined.sql).toContain(`'POINT(3 4)'`);
		expect(inlined.params).toStrictEqual([]);
	});

	test('`sql` values bypass the mapping', () => {
		const query = db.insert(t).values({ footprint: sql`ST_GeomFromGeoJSON(${'{}'})` }).toSQL();
		expect(query.sql).toContain('ST_GeomFromGeoJSON($1)');
		expect(query.params).toStrictEqual(['{}']);
	});
});

describe('selection', () => {
	const places = pgTable('places', {
		id: geometry(),
		footprint: geometry({ type: 'MultiPolygon', srid: 4326 }),
		place: geography({ type: 'Point' }),
	});

	test('reads columns without a cast', () => {
		const query = db.select().from(places).toSQL();
		expect(query.sql).toBe('select "id", "footprint", "place" from "places"');
	});

	test('`mapWith(column)` inherits the column codec', () => {
		const buffered = sql`ST_Buffer(${places.footprint}, 1)`.mapWith(places.footprint);
		expect(buffered.decoder).toBe(places.footprint);
	});

	test('casts to text inside RQB JSON selections', () => {
		const owners = pgTable('owners', { id: geometry({ type: 'Point' }) });
		const relations = defineRelations({ places, owners }, (r) => ({
			owners: { places: r.many.places() },
			places: { owner: r.one.owners({ from: r.places.id, to: r.owners.id }) },
		}));
		const rqb = drizzle.mock({ relations });
		const { sql: text } = rqb.query.owners.findMany({ with: { places: true } }).toSQL();
		expect(text).toContain('"footprint"::text');
		expect(text).toContain('"place"::text');
	});

	test('`customType` with a typmod codec key decodes as GeoJSON', () => {
		const geom = customType<{ data: unknown }>({
			dataType: () => 'geometry(polygon,4326)',
			codec: 'geometry(polygon)',
		});
		const t = pgTable('t', { g: geom() });
		expect(t.g.codec).toBe('geometry');
		expect(db.dialect.codecs.get(t.g, 'normalize')).toBeTypeOf('function');
	});
});
