/**
 * GeoJSON geometry types (RFC 7946, section 3.1).
 *
 * The `geometry()` and `geography()` columns read and write these shapes.
 * They are defined here so that `drizzle-orm` stays free of runtime and
 * type dependencies. Each type has the same members as its counterpart in
 * `@types/geojson`, so values are assignable in both directions.
 *
 * Extension to the RFC: a position can carry a fourth number. PostGIS stores
 * a measure (M) ordinate next to Z, and the column passes it through instead
 * of dropping it. An M-only geometry has three numbers per position.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7946#section-3.1
 */

/**
 * Bounding box of a geometry: `[west, south, east, north]` in 2D, with
 * minimum and maximum elevation added in 3D.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7946#section-5
 */
export type BBox = [number, number, number, number] | [number, number, number, number, number, number];

/**
 * One coordinate: `[x, y]`, `[x, y, z]`, `[x, y, m]` for M-only geometries,
 * or `[x, y, z, m]`. The RFC allows only two or three elements; PostGIS
 * columns can add M.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7946#section-3.1.1
 */
export type Position = number[];

/**
 * Members that every geometry object has.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7946#section-3
 */
export interface GeometryObjectBase {
	/** The geometry type name. */
	type: GeometryType;
	/**
	 * Optional bounding box. The column never sets it on read and ignores it
	 * on write; it is kept so that values from other GeoJSON producers stay
	 * assignable.
	 */
	bbox?: BBox | undefined;
}

/**
 * Point geometry object.
 *
 * `coordinates` is empty for `POINT EMPTY`.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7946#section-3.1.2
 */
export interface Point extends GeometryObjectBase {
	type: 'Point';
	coordinates: Position;
}

/**
 * MultiPoint geometry object.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7946#section-3.1.3
 */
export interface MultiPoint extends GeometryObjectBase {
	type: 'MultiPoint';
	coordinates: Position[];
}

/**
 * LineString geometry object.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7946#section-3.1.4
 */
export interface LineString extends GeometryObjectBase {
	type: 'LineString';
	coordinates: Position[];
}

/**
 * MultiLineString geometry object.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7946#section-3.1.5
 */
export interface MultiLineString extends GeometryObjectBase {
	type: 'MultiLineString';
	coordinates: Position[][];
}

/**
 * Polygon geometry object: an array of linear rings. The first ring is the
 * exterior ring; the others are holes.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7946#section-3.1.6
 */
export interface Polygon extends GeometryObjectBase {
	type: 'Polygon';
	coordinates: Position[][];
}

/**
 * MultiPolygon geometry object.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7946#section-3.1.7
 */
export interface MultiPolygon extends GeometryObjectBase {
	type: 'MultiPolygon';
	coordinates: Position[][][];
}

/**
 * GeometryCollection geometry object.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7946#section-3.1.8
 */
export interface GeometryCollection<G extends Geometry = Geometry> extends GeometryObjectBase {
	type: 'GeometryCollection';
	geometries: G[];
}

/**
 * Union of every GeoJSON geometry object.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7946#section-3.1
 */
export type Geometry =
	| Point
	| MultiPoint
	| LineString
	| MultiLineString
	| Polygon
	| MultiPolygon
	| GeometryCollection;

/**
 * The valid values of the `type` member of a geometry object.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7946#section-1.4
 */
export type GeometryType = Geometry['type'];
