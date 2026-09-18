/** Runtime configuration shared by the `geometry` and `geography` column builders. */
export interface PgGeometryRuntimeConfig {
	/** The `type` option as written; `undefined` means any subtype. */
	type: string | undefined;
	/** The `srid` option as written. */
	srid: number | undefined;
}

/**
 * Builds the SQL type of a `geometry` or `geography` column.
 *
 * The typmod is written in lowercase; PostGIS accepts any casing and
 * drizzle-kit compares typmods case-insensitively. A column with no `type`
 * (or `type: 'Geometry'`) and no `srid` has no typmod at all, which is how
 * PostGIS reports such a column back through `format_type`.
 *
 * @example
 * formatGeometrySqlType('geometry', undefined, undefined)        // geometry
 * formatGeometrySqlType('geometry', 'MultiPolygon', 4326)        // geometry(multipolygon,4326)
 * formatGeometrySqlType('geometry', 'Geometry', 4326)            // geometry(geometry,4326)
 * formatGeometrySqlType('geography', 'Point', undefined)         // geography(point)
 */
export function formatGeometrySqlType(
	base: 'geometry' | 'geography',
	type: string | undefined,
	srid: number | undefined,
): string {
	const typmod = type === undefined ? 'geometry' : type.toLowerCase();
	if (typmod === 'geometry' && srid === undefined) return base;
	return srid === undefined ? `${base}(${typmod})` : `${base}(${typmod},${srid})`;
}

/**
 * `true` when the `type` option names an M-only subtype (`PointM`,
 * `linestringm`, ...). Such a column writes the third number of a position
 * as M, not Z.
 */
export function isMOnlyGeometryType(type: string | undefined): boolean {
	if (type === undefined) return false;
	const lower = type.toLowerCase();
	return lower.endsWith('m') && !lower.endsWith('zm');
}

/** `true` when the `type` option names the Point subtype (2D, any casing). */
export function isPointGeometryType(type: string | undefined): boolean {
	return type !== undefined && type.toLowerCase() === 'point';
}
