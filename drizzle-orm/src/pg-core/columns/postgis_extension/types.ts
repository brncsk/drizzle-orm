import type {
	Geometry,
	GeometryCollection,
	LineString,
	MultiLineString,
	MultiPoint,
	MultiPolygon,
	Point,
	Polygon,
} from './geojson.ts';

/** PostGIS subtypes that GeoJSON can represent. */
export type PgGeoJSONTypeName =
	| 'Point'
	| 'MultiPoint'
	| 'LineString'
	| 'MultiLineString'
	| 'Polygon'
	| 'MultiPolygon'
	| 'GeometryCollection';

/**
 * PostGIS subtypes that GeoJSON cannot represent. A column of one of these
 * types can be declared and migrated, but its values type as `unknown` and
 * reading one through the GeoJSON codec throws.
 */
export type PgCurveTypeName =
	| 'CircularString'
	| 'CompoundCurve'
	| 'CurvePolygon'
	| 'MultiCurve'
	| 'MultiSurface'
	| 'PolyhedralSurface'
	| 'TIN'
	| 'Triangle';

type PgDimensionSuffix = '' | 'Z' | 'M' | 'ZM';

/**
 * Every PostGIS typmod subtype, in PostGIS casing: `'MultiPolygon'`,
 * `'PointZM'`, `'Geometry'` (any subtype), `'CircularString'`, ...
 */
export type PgGeometryType = `${PgGeoJSONTypeName | 'Geometry' | PgCurveTypeName}${PgDimensionSuffix}`;

/**
 * What the `type` option accepts: a {@link PgGeometryType} in PostGIS casing
 * or in lowercase, or any other string for a typmod this union does not know.
 * Unknown strings type their values as {@link Geometry}.
 */
export type PgGeometryTypeInput = PgGeometryType | Lowercase<PgGeometryType> | (string & {});

/**
 * Client-side representation of a `geometry` column.
 *
 * - `'geojson'` (default): RFC 7946 objects for every subtype.
 * - `'tuple'`: `[x, y]`; Point columns only.
 * - `'xy'`: `{ x, y }`; Point columns only.
 */
export type PgGeometryMode = 'geojson' | 'tuple' | 'xy';

/** Lowercases the name and removes a `z`, `m` or `zm` suffix. `TIN` is safe: `tin` ends in `n`. */
type PgBaseTypeName<T extends string> = Lowercase<T> extends `${infer B}zm` ? B
	: Lowercase<T> extends `${infer B}z` ? B
	: Lowercase<T> extends `${infer B}m` ? B
	: Lowercase<T>;

type GeoJSONForBase<T extends string> = T extends 'point' ? Point
	: T extends 'multipoint' ? MultiPoint
	: T extends 'linestring' ? LineString
	: T extends 'multilinestring' ? MultiLineString
	: T extends 'polygon' ? Polygon
	: T extends 'multipolygon' ? MultiPolygon
	: T extends 'geometrycollection' ? GeometryCollection
	: T extends Lowercase<PgCurveTypeName> ? unknown
	: Geometry;

/**
 * The GeoJSON type of a `geometry` or `geography` column with the given
 * `type` option: `'MultiPolygon'` and `'multipolygonz'` give
 * {@link MultiPolygon}; `'Geometry'`, an unknown string or a plain `string`
 * give the {@link Geometry} union; a curve or surface type gives `unknown`.
 */
export type GeoJSONFor<T extends string> = string extends T ? Geometry : GeoJSONForBase<PgBaseTypeName<T>>;

/** `true` when `T` names the Point subtype in any casing (`'Point'`, `'point'`, not `'PointZ'`). */
export type IsPgPointType<T extends string> = string extends T ? false : Lowercase<T> extends 'point' ? true : false;

/** The modes a column with the given `type` option accepts: all three for Point, `'geojson'` for the rest. */
export type PgGeometryModeFor<T extends string> = IsPgPointType<T> extends true ? PgGeometryMode : 'geojson';
