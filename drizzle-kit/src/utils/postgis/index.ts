/**
 * PostGIS value helpers for the postgres grammar: GeoJSON types, the EWKB
 * reader and the EWKT writer and parser.
 *
 * The files in this folder are copies of their namesakes in
 * `drizzle-orm/src/pg-core/columns/postgis_extension/`. The kit reaches
 * `drizzle-orm` at runtime only behind `await import()`, because
 * `drizzle-orm` is not one of its dependencies and `tests/other/bin.test.ts`
 * keeps it off the static import graph of the CLI, `drizzle-kit/api`, studio
 * and mover. The grammar's default codecs are synchronous and sit on that
 * graph, so they cannot load the orm's copy. Keep the two sides in step;
 * `tests/other/postgis-ewkb.test.ts` runs the orm's vectors against this copy.
 */
export { ewkbToGeoJSON, parseEWKB } from './ewkb';
export type { ParsedEWKB } from './ewkb';
export { geoJSONToEWKT, parseEWKT } from './ewkt';
export type { GeoJSONToEWKTOptions, ParsedEWKT } from './ewkt';
export type {
	BBox,
	Geometry,
	GeometryCollection,
	GeometryType,
	LineString,
	MultiLineString,
	MultiPoint,
	MultiPolygon,
	Point,
	Polygon,
	Position,
} from './geojson';

/**
 * `true` when the `type` option names an M-only subtype (`PointM`,
 * `linestringm`, ...). Such a column writes the third number of a position
 * as M, not Z. A copy of the function of the same name in
 * `drizzle-orm/src/pg-core/columns/postgis_extension/utils.ts`.
 */
export function isMOnlyGeometryType(type: string | undefined): boolean {
	if (type === undefined) return false;
	const lower = type.toLowerCase();
	return lower.endsWith('m') && !lower.endsWith('zm');
}
