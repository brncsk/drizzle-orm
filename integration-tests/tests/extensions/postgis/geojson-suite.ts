import { eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { PgAsyncDatabase, PgQueryResultHKT, PgTable } from 'drizzle-orm/pg-core';
import {
	customType,
	geography,
	type Geometry,
	geometry,
	integer,
	type LineString,
	type MultiPolygon,
	parseEWKB,
	pgTable,
	pgView,
	type Point,
	type Polygon,
} from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, test } from 'vitest';

type AnyPgDb = PgAsyncDatabase<PgQueryResultHKT, any>;

/** `CREATE TABLE` from a drizzle table, so the tests exercise the SQL types the columns emit. */
async function createTable(db: AnyPgDb, table: PgTable) {
	const columns = Object.values(getTableColumns(table)).map((column) => {
		const dims = '[]'.repeat(column.dimensions);
		const constraints = `${column.primary ? ' primary key' : ''}${column.notNull ? ' not null' : ''}`;
		return `"${column.name}" ${column.getSQLType()}${dims}${constraints}`;
	});
	const name = getTableName(table);
	await db.execute(sql.raw(`drop table if exists "${name}" cascade`));
	await db.execute(sql.raw(`create table "${name}" (${columns.join(', ')})`));
}

const square: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
const squareWithHole: Polygon = {
	type: 'Polygon',
	coordinates: [
		[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
		[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]],
	],
};
const twoSquares: MultiPolygon = {
	type: 'MultiPolygon',
	coordinates: [square.coordinates, [[[10, 10], [11, 10], [11, 11], [10, 10]]]],
};

/**
 * Round trips and query shapes that every driver must pass. The driver test
 * file connects and passes a getter, because the database is created in
 * `beforeAll`.
 */
export function defineGeoJSONTests(getDb: () => AnyPgDb) {
	describe('GeoJSON geometry columns', () => {
		test('round trip of every representable subtype', async () => {
			const db = getDb();
			const shapes = pgTable('geo_shapes', {
				id: integer('id').primaryKey(),
				any: geometry('any'),
				point: geometry('point', { type: 'Point', srid: 4326 }),
				multiPoint: geometry('multi_point', { type: 'MultiPoint' }),
				lineString: geometry('line_string', { type: 'LineString', srid: 3857 }),
				multiLineString: geometry('multi_line_string', { type: 'MultiLineString' }),
				polygon: geometry('polygon', { type: 'Polygon', srid: 4326 }),
				multiPolygon: geometry('multi_polygon', { type: 'MultiPolygon', srid: 4326 }),
				collection: geometry('collection', { type: 'GeometryCollection' }),
				pointZ: geometry('point_z', { type: 'PointZ', srid: 4326 }),
				lineStringZ: geometry('line_string_z', { type: 'linestringz' }),
			});
			await createTable(db, shapes);

			const row = {
				id: 1,
				any: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } as Geometry,
				point: { type: 'Point', coordinates: [19.0402, 47.4979] } as Point,
				multiPoint: { type: 'MultiPoint', coordinates: [[0, 0], [1, 2]] },
				lineString: { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0.5]] } as LineString,
				multiLineString: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 4]]] },
				polygon: squareWithHole,
				multiPolygon: twoSquares,
				collection: {
					type: 'GeometryCollection',
					geometries: [
						{ type: 'Point', coordinates: [1, 2] },
						{ type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[0, 0], [1, 1]] }] },
					],
				},
				pointZ: { type: 'Point', coordinates: [1, 2, 3] } as Point,
				lineStringZ: { type: 'LineString', coordinates: [[0, 0, 1], [1, 1, 2]] } as LineString,
			} satisfies typeof shapes.$inferInsert;

			const inserted = await db.insert(shapes).values(row).returning();
			expect(inserted).toStrictEqual([row]);

			const selected = await db.select().from(shapes);
			expect(selected).toStrictEqual([row]);
			expectTypeOf(selected[0]!.multiPolygon).toEqualTypeOf<MultiPolygon | null>();
			expectTypeOf(selected[0]!.any).toEqualTypeOf<Geometry | null>();

			const updated = await db.update(shapes).set({ polygon: square, any: null }).where(eq(shapes.id, 1)).returning({
				polygon: shapes.polygon,
				any: shapes.any,
			});
			expect(updated).toStrictEqual([{ polygon: square, any: null }]);

			// The SRID prefix reaches PostGIS.
			const srids = await db.select({
				point: sql<number>`ST_SRID(${shapes.point})`,
				lineString: sql<number>`ST_SRID(${shapes.lineString})`,
				multiPoint: sql<number>`ST_SRID(${shapes.multiPoint})`,
			}).from(shapes);
			expect(srids).toStrictEqual([{ point: 4326, lineString: 3857, multiPoint: 0 }]);
		});

		test('empty geometries', async () => {
			const db = getDb();
			const empties = pgTable('geo_empties', {
				id: integer('id').primaryKey(),
				point: geometry('point', { type: 'Point' }),
				polygon: geometry('polygon', { type: 'Polygon' }),
				multiPoint: geometry('multi_point', { type: 'MultiPoint' }),
				collection: geometry('collection', { type: 'GeometryCollection' }),
			});
			await createTable(db, empties);
			const row = {
				id: 1,
				point: { type: 'Point', coordinates: [] } as Point,
				polygon: { type: 'Polygon', coordinates: [] } as Polygon,
				multiPoint: { type: 'MultiPoint', coordinates: [[1, 2], []] },
				collection: { type: 'GeometryCollection', geometries: [] },
			} satisfies typeof empties.$inferInsert;
			await db.insert(empties).values(row);
			expect(await db.select().from(empties)).toStrictEqual([row]);
			const text = await db.select({ point: sql<string>`ST_AsText(${empties.point})` }).from(empties);
			expect(text).toStrictEqual([{ point: 'POINT EMPTY' }]);
		});

		test('SRID of the value and of the column', async () => {
			const db = getDb();
			const srids = pgTable('geo_srids', {
				id: integer('id').primaryKey(),
				any: geometry('any'),
				anyWithSrid: geometry('any_with_srid', { srid: 3857 }),
				typed: geometry('typed', { type: 'Point', srid: 4326 }),
			});
			await createTable(db, srids);
			const point: Point = { type: 'Point', coordinates: [1, 2] };
			await db.insert(srids).values({ id: 1, any: point, anyWithSrid: point, typed: point });
			// An SRID that differs from the typmod is rejected by PostGIS.
			await expect(
				db.insert(srids).values({ id: 2, typed: sql`ST_SetSRID(ST_MakePoint(1, 2), 3857)` }),
			).rejects.toSatisfy((error: Error & { cause?: Error }) =>
				/Geometry SRID \(3857\) does not match column SRID \(4326\)/.test(error.cause?.message ?? error.message)
			);
			// A typmod-less column keeps whatever SRID the value carries.
			await db.insert(srids).values({ id: 3, any: sql`ST_SetSRID(ST_MakePoint(1, 2), 3857)` });

			const result = await db.select({
				id: srids.id,
				any: sql<number>`ST_SRID(${srids.any})`,
				anyWithSrid: sql<number>`ST_SRID(${srids.anyWithSrid})`,
				typed: sql<number>`ST_SRID(${srids.typed})`,
			}).from(srids).orderBy(srids.id);
			expect(result).toStrictEqual([
				{ id: 1, any: 0, anyWithSrid: 3857, typed: 4326 },
				{ id: 3, any: 3857, anyWithSrid: null, typed: null },
			]);

			// `parseEWKB` exposes the stored SRID for code that needs it.
			const raw = await db.select({ ewkb: sql<string>`${srids.typed}::text` }).from(srids).where(eq(srids.id, 1));
			expect(parseEWKB(raw[0]!.ewkb)).toStrictEqual({ srid: 4326, geometry: point, hasZ: false, hasM: false });
		});

		test('M ordinates pass through', async () => {
			const db = getDb();
			const measured = pgTable('geo_measured', {
				id: integer('id').primaryKey(),
				pointM: geometry('point_m', { type: 'PointM' }),
				lineStringZM: geometry('line_string_zm', { type: 'LineStringZM', srid: 4326 }),
			});
			await createTable(db, measured);
			const row = {
				id: 1,
				pointM: { type: 'Point', coordinates: [1, 2, 7] } as Point,
				lineStringZM: { type: 'LineString', coordinates: [[0, 0, 1, 10], [1, 1, 2, 20]] } as LineString,
			};
			await db.insert(measured).values(row);
			expect(await db.select().from(measured)).toStrictEqual([row]);
			const text = await db.select({
				pointM: sql<string>`ST_AsEWKT(${measured.pointM})`,
				lineStringZM: sql<string>`ST_AsEWKT(${measured.lineStringZM})`,
			}).from(measured);
			expect(text).toStrictEqual([{
				pointM: 'POINTM(1 2 7)',
				lineStringZM: 'SRID=4326;LINESTRING(0 0 1 10,1 1 2 20)',
			}]);
		});

		test('arrays', async () => {
			const db = getDb();
			const arrays = pgTable('geo_arrays_geojson', {
				id: integer('id').primaryKey(),
				polygons: geometry('polygons', { type: 'Polygon', srid: 4326 }).array(),
				grid: geometry('grid', { type: 'Point' }).array('[][]'),
				places: geography('places', { type: 'Point' }).array(),
			});
			await createTable(db, arrays);
			const row = {
				id: 1,
				polygons: [square, squareWithHole],
				grid: [
					[{ type: 'Point', coordinates: [0, 0] }, { type: 'Point', coordinates: [1, 0] }],
					[{ type: 'Point', coordinates: [0, 1] }, { type: 'Point', coordinates: [1, 1] }],
				] as Point[][],
				places: [{ type: 'Point', coordinates: [19.04, 47.49] }, {
					type: 'Point',
					coordinates: [16.37, 48.2],
				}] as Point[],
			};
			const inserted = await db.insert(arrays).values(row).returning();
			expect(inserted).toStrictEqual([row]);
			expect(await db.select().from(arrays)).toStrictEqual([row]);
			expectTypeOf(inserted[0]!.polygons).toEqualTypeOf<Polygon[] | null>();

			await db.insert(arrays).values({ id: 2, polygons: [], grid: null });
			const second = await db.select().from(arrays).where(eq(arrays.id, 2));
			expect(second).toStrictEqual([{ id: 2, polygons: [], grid: null, places: null }]);
		});

		test('`mapWith`, `sql` extras, subqueries, unions and views', async () => {
			const db = getDb();
			const places = pgTable('geo_places', {
				id: integer('id').primaryKey(),
				footprint: geometry('footprint', { type: 'Polygon', srid: 4326 }).notNull(),
			});
			await createTable(db, places);
			await db.insert(places).values([{ id: 1, footprint: square }, { id: 2, footprint: squareWithHole }]);

			const derived = await db.select({
				id: places.id,
				centroid: sql`ST_Centroid(${places.footprint})`.mapWith(places.footprint),
				asGeoJSON: sql<Geometry>`ST_AsGeoJSON(${places.footprint})::jsonb`,
				area: sql<number>`ST_Area(${places.footprint})::float8`,
			}).from(places).where(eq(places.id, 1));
			expect(derived).toStrictEqual([{
				id: 1,
				centroid: { type: 'Point', coordinates: [0.5, 0.5] },
				asGeoJSON: square,
				area: 1,
			}]);
			expectTypeOf(derived[0]!.centroid).toEqualTypeOf<Polygon>();

			const sq = db.select({ id: places.id, footprint: places.footprint }).from(places).as('sq');
			const fromSubquery = await db.select({ footprint: sq.footprint }).from(sq).where(eq(sq.id, 2));
			expect(fromSubquery).toStrictEqual([{ footprint: squareWithHole }]);

			const union = await db.select({ footprint: places.footprint }).from(places).where(eq(places.id, 1))
				.union(db.select({ footprint: places.footprint }).from(places).where(eq(places.id, 2)));
			expect(union).toHaveLength(2);
			expect(union.map((r) => r.footprint.type)).toStrictEqual(['Polygon', 'Polygon']);

			const view = pgView('geo_places_view').as((qb) => qb.select().from(places));
			await db.execute(sql`drop view if exists "geo_places_view"`);
			await db.execute(sql`create view "geo_places_view" as select * from "geo_places"`);
			const fromView = await db.select().from(view).where(eq(view.id, 1));
			expect(fromView).toStrictEqual([{ id: 1, footprint: square }]);
			await db.execute(sql`drop view "geo_places_view"`);
		});

		test('geography', async () => {
			const db = getDb();
			const cities = pgTable('geo_cities', {
				id: integer('id').primaryKey(),
				location: geography('location', { type: 'Point' }).notNull(),
				area: geography('area', { type: 'MultiPolygon', srid: 4326 }),
				any: geography('any'),
			});
			await createTable(db, cities);
			const budapest: Point = { type: 'Point', coordinates: [19.0402, 47.4979] };
			const vienna: Point = { type: 'Point', coordinates: [16.3738, 48.2082] };
			const rows = [
				{
					id: 1,
					location: budapest,
					area: twoSquares,
					any: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } as Geometry,
				},
				{ id: 2, location: vienna, area: null, any: null },
			];
			const inserted = await db.insert(cities).values(rows).returning();
			expect(inserted).toStrictEqual(rows);
			expect(await db.select().from(cities).orderBy(cities.id)).toStrictEqual(rows);
			expectTypeOf(inserted[0]!.location).toEqualTypeOf<Point>();

			// `sql.param(value, column)` encodes a GeoJSON parameter like the column would.
			const [distance] = await db.select({
				meters: sql<number>`ST_Distance(${cities.location}, ${sql.param(vienna, cities.location)})::float8`,
				srid: sql<number>`ST_SRID(${cities.location})`,
			}).from(cities).where(eq(cities.id, 1));
			expect(distance!.srid).toBe(4326);
			expect(distance!.meters).toBeGreaterThan(210_000);
			expect(distance!.meters).toBeLessThan(220_000);
		});

		test('curve columns can be declared but not read as GeoJSON', async () => {
			const db = getDb();
			const curves = pgTable('geo_curves', {
				id: integer('id').primaryKey(),
				arc: geometry('arc', { type: 'CircularString' }),
			});
			await createTable(db, curves);
			await db.insert(curves).values({ id: 1, arc: sql`'CIRCULARSTRING(0 0,1 1,2 0)'::geometry` });
			expectTypeOf<typeof curves.$inferSelect>().toEqualTypeOf<{ id: number; arc: unknown }>();
			// Some drivers surface decoding errors wrapped in a `DrizzleQueryError`.
			await expect(db.select().from(curves)).rejects.toSatisfy((error: Error & { cause?: Error }) =>
				/Unsupported PostGIS geometry type CircularString \(8\)/.test(error.cause?.message ?? error.message)
			);
			const text = await db.select({ arc: sql<string>`ST_AsText(${curves.arc})` }).from(curves);
			expect(text).toStrictEqual([{ arc: 'CIRCULARSTRING(0 0,1 1,2 0)' }]);
		});

		test('`customType` with a geometry codec key decodes GeoJSON', async () => {
			const db = getDb();
			const shape = customType<{ data: Polygon; driverData: string }>({
				dataType: () => 'geometry(polygon,4326)',
				codec: 'geometry(polygon)',
				toDriver: (value) => sql`ST_GeomFromGeoJSON(${JSON.stringify(value)})`,
			});
			const any = customType<{ data: Geometry; driverData: string }>({
				dataType: () => 'geometry',
				codec: 'geometry',
			});
			const custom = pgTable('geo_custom', {
				id: integer('id').primaryKey(),
				shape: shape('shape'),
				any: any('any'),
			});
			await createTable(db, custom);
			await db.insert(custom).values({ id: 1, shape: square, any: sql`'POINT(1 2)'::geometry` });
			expect(await db.select().from(custom)).toStrictEqual([{
				id: 1,
				shape: square,
				any: { type: 'Point', coordinates: [1, 2] },
			}]);
		});

		test('WKT, EWKT and hex EWKB strings are written as they are', async () => {
			const db = getDb();
			const raw = pgTable('geo_raw', {
				id: integer('id').primaryKey(),
				geom: geometry('geom', { type: 'Point', srid: 4326 }),
			});
			await createTable(db, raw);
			await db.insert(raw).values([
				{ id: 1, geom: 'POINT(1 2)' as unknown as Point },
				{ id: 2, geom: 'SRID=4326;POINT(3 4)' as unknown as Point },
				{ id: 3, geom: '0101000020e610000000000000000014400000000000001840' as unknown as Point },
			]);
			const rows = await db.select().from(raw).orderBy(raw.id);
			expect(rows).toStrictEqual([
				{ id: 1, geom: { type: 'Point', coordinates: [1, 2] } },
				{ id: 2, geom: { type: 'Point', coordinates: [3, 4] } },
				{ id: 3, geom: { type: 'Point', coordinates: [5, 6] } },
			]);
		});
	});
}
