import type { Equal } from 'type-tests/utils.ts';
import { Expect } from 'type-tests/utils.ts';
import type { InferInsertModel, InferSelectModel } from '~/index.ts';
import { sql } from '~/index.ts';
import type {
	Geometry,
	GeometryCollection,
	LineString,
	MultiLineString,
	MultiPoint,
	MultiPolygon,
	PgGeographyBuilder,
	PgGeometryBuilder,
	PgGeometryObjectBuilder,
	PgGeometryTupleBuilder,
	Point,
	Polygon,
} from '~/pg-core/index.ts';
import { geography, geometry, pgTable } from '~/pg-core/index.ts';
import { db } from './db.ts';

// Builder selection by `type` and `mode`.
{
	Expect<Equal<ReturnType<typeof geometry>, PgGeometryBuilder<Geometry>>>;
	Expect<Equal<typeof geometry extends (name: string) => infer R ? R : never, PgGeometryBuilder<Geometry>>>;

	const any = geometry({ srid: 4326 });
	Expect<Equal<typeof any, PgGeometryBuilder<Geometry>>>;

	const explicitAny = geometry({ type: 'Geometry' });
	Expect<Equal<typeof explicitAny, PgGeometryBuilder<Geometry>>>;

	const point = geometry({ type: 'Point' });
	Expect<Equal<typeof point, PgGeometryBuilder<Point>>>;

	const lowercase = geometry({ type: 'multipolygon', srid: 4326 });
	Expect<Equal<typeof lowercase, PgGeometryBuilder<MultiPolygon>>>;

	const withZ = geometry('axis', { type: 'LineStringZ', srid: 3857 });
	Expect<Equal<typeof withZ, PgGeometryBuilder<LineString>>>;

	const withM = geometry({ type: 'MultiLineStringM' });
	Expect<Equal<typeof withM, PgGeometryBuilder<MultiLineString>>>;

	const withZM = geometry({ type: 'multipointzm' });
	Expect<Equal<typeof withZM, PgGeometryBuilder<MultiPoint>>>;

	const polygon = geometry({ type: 'Polygon' });
	Expect<Equal<typeof polygon, PgGeometryBuilder<Polygon>>>;

	const collection = geometry({ type: 'GeometryCollectionZ' });
	Expect<Equal<typeof collection, PgGeometryBuilder<GeometryCollection>>>;

	// Curve and surface subtypes are DDL-only.
	const curve = geometry({ type: 'CircularString' });
	Expect<Equal<typeof curve, PgGeometryBuilder<unknown>>>;
	const tin = geometry({ type: 'TIN' });
	Expect<Equal<typeof tin, PgGeometryBuilder<unknown>>>;
	const tinZ = geometry({ type: 'tinz' });
	Expect<Equal<typeof tinZ, PgGeometryBuilder<unknown>>>;

	// Unknown typmod strings fall back to the union.
	const unknown = geometry({ type: 'SomethingElse' });
	Expect<Equal<typeof unknown, PgGeometryBuilder<Geometry>>>;
	const dynamic = geometry({ type: 'Point' as string });
	Expect<Equal<typeof dynamic, PgGeometryBuilder<Geometry>>>;

	// Legacy point modes.
	const tuple = geometry({ type: 'Point', mode: 'tuple' });
	Expect<Equal<typeof tuple, PgGeometryTupleBuilder>>;
	const xy = geometry('geo', { type: 'point', mode: 'xy', srid: 4326 });
	Expect<Equal<typeof xy, PgGeometryObjectBuilder>>;
	const explicitGeoJSON = geometry({ type: 'Point', mode: 'geojson' });
	Expect<Equal<typeof explicitGeoJSON, PgGeometryBuilder<Point>>>;

	// Non-point subtypes have only the GeoJSON mode.
	// @ts-expect-error
	geometry({ type: 'Polygon', mode: 'tuple' });
	// @ts-expect-error
	geometry({ type: 'MultiPoint', mode: 'xy' });
	// @ts-expect-error
	geometry({ type: 'PointZ', mode: 'tuple' });
	// @ts-expect-error
	geometry({ mode: 'xy' });

	void [
		any,
		explicitAny,
		point,
		lowercase,
		withZ,
		withM,
		withZM,
		polygon,
		collection,
		curve,
		tin,
		tinZ,
		unknown,
		dynamic,
		tuple,
		xy,
		explicitGeoJSON,
	];
}

// `geography` mirrors `geometry` without the legacy modes.
{
	Expect<Equal<ReturnType<typeof geography>, PgGeographyBuilder<Geometry>>>;
	const place = geography({ type: 'Point' });
	Expect<Equal<typeof place, PgGeographyBuilder<Point>>>;
	const region = geography('region', { type: 'MultiPolygon', srid: 4326 });
	Expect<Equal<typeof region, PgGeographyBuilder<MultiPolygon>>>;
	// @ts-expect-error
	geography({ type: 'Point', mode: 'tuple' });
	void [place, region];
}

// Inferred models.
{
	const places = pgTable('places', {
		any: geometry(),
		footprint: geometry({ type: 'MultiPolygon', srid: 4326 }).notNull(),
		center: geometry({ type: 'Point', srid: 4326 }),
		legacyTuple: geometry({ type: 'Point', mode: 'tuple' }),
		legacyXy: geometry({ type: 'Point', mode: 'xy' }).notNull(),
		parts: geometry({ type: 'Polygon', srid: 4326 }).array(),
		grid: geometry({ type: 'Point' }).array('[][]'),
		place: geography({ type: 'Point' }),
		region: geography({ type: 'MultiPolygon' }).notNull(),
		curve: geometry({ type: 'CircularString' }),
		branded: geometry({ type: 'Point' }).$type<Point & { __brand: 'Center' }>(),
	});

	Expect<
		Equal<InferSelectModel<typeof places>, {
			any: Geometry | null;
			footprint: MultiPolygon;
			center: Point | null;
			legacyTuple: [number, number] | null;
			legacyXy: { x: number; y: number };
			parts: Polygon[] | null;
			grid: Point[][] | null;
			place: Point | null;
			region: MultiPolygon;
			curve: unknown;
			branded: (Point & { __brand: 'Center' }) | null;
		}>
	>;

	Expect<
		Equal<InferInsertModel<typeof places>, {
			any?: Geometry | null | undefined;
			footprint: MultiPolygon;
			center?: Point | null | undefined;
			legacyTuple?: [number, number] | null | undefined;
			legacyXy: { x: number; y: number };
			parts?: Polygon[] | null | undefined;
			grid?: Point[][] | null | undefined;
			place?: Point | null | undefined;
			region: MultiPolygon;
			curve?: unknown;
			branded?: (Point & { __brand: 'Center' }) | null | undefined;
		}>
	>;

	// Values accept `sql` as well as GeoJSON.
	db.insert(places).values({
		footprint: {
			type: 'MultiPolygon',
			coordinates: [[[[19.04, 47.49], [19.05, 47.49], [19.05, 47.5], [19.04, 47.49]]]],
		},
		legacyXy: { x: 1, y: 2 },
		center: sql`ST_SetSRID(ST_MakePoint(19.04, 47.49), 4326)`,
		region: sql`ST_GeomFromGeoJSON('{}')`,
	});

	// @ts-expect-error: a Polygon is not a MultiPolygon
	db.insert(places).values({
		footprint: { type: 'Polygon', coordinates: [] },
		legacyXy: { x: 1, y: 2 },
		region: sql``,
	});

	// Query results keep the column types, also through `mapWith`.
	const rows = db.select({
		footprint: places.footprint,
		buffered: sql<Geometry>`ST_Buffer(${places.footprint}, 1)`.mapWith(places.footprint),
		center: places.center,
	}).from(places);
	Expect<Equal<Awaited<typeof rows>, { footprint: MultiPolygon; buffered: MultiPolygon; center: Point | null }[]>>;

	// `.default()` takes the GeoJSON type of the column.
	const withDefault = pgTable('with_default', {
		center: geometry({ type: 'Point', srid: 4326 }).default({ type: 'Point', coordinates: [0, 0] }),
		// @ts-expect-error: a LineString is not a Point
		wrong: geometry({ type: 'Point' }).default({ type: 'LineString', coordinates: [] }),
	});
	void withDefault;
}
