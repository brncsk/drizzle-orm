import { entityKind } from '~/entity.ts';
import type { PgTable } from '~/pg-core/table.ts';
import { getColumnNameAndConfig } from '~/utils.ts';
import type { PgColumnBaseConfig } from '../common.ts';
import { PgColumn, PgColumnBuilder } from '../common.ts';
import { geoJSONToEWKT } from './ewkt.ts';
import type { Geometry } from './geojson.ts';
import type { GeoJSONFor, PgGeometryTypeInput } from './types.ts';
import { formatGeometrySqlType, isMOnlyGeometryType, type PgGeometryRuntimeConfig } from './utils.ts';

/**
 * Options of {@link geography}.
 *
 * @typeParam TType the `type` option; it selects the GeoJSON type of the column's values
 */
export interface PgGeographyConfig<TType extends PgGeometryTypeInput = PgGeometryTypeInput> {
	/**
	 * PostGIS subtype, written into the typmod: `'Point'`, `'MultiPolygon'`,
	 * `'LineStringZ'`, ... in PostGIS or lowercase casing. Omit it (or use
	 * `'Geometry'`) for a column that accepts every subtype. The value type
	 * follows the subtype as for {@link geometry}.
	 */
	type?: TType;
	/**
	 * Spatial reference identifier. PostGIS applies 4326 (WGS 84) to a
	 * `geography` column with a subtype and no SRID, so
	 * `geography({ type: 'Point' })` and `geography({ type: 'Point', srid: 4326 })`
	 * are the same column.
	 */
	srid?: number;
}

/**
 * Builder of a PostGIS `geography` column that reads and writes GeoJSON.
 *
 * @typeParam TGeom the GeoJSON type of the column's values
 */
export class PgGeographyBuilder<TGeom = Geometry> extends PgColumnBuilder<{
	dataType: 'object geojson';
	data: TGeom;
	driverParam: string;
}, PgGeometryRuntimeConfig> {
	static override readonly [entityKind]: string = 'PgGeographyBuilder';

	constructor(name: string, config: PgGeographyConfig | undefined) {
		super(name, 'object geojson', 'PgGeography');
		this.config.type = config?.type;
		this.config.srid = config?.srid;
	}

	/** @internal */
	override build(table: PgTable<any>) {
		return new PgGeography(table, this.config as any);
	}
}

/**
 * PostGIS `geography` column that reads and writes GeoJSON. PostGIS sends
 * `geography` values in the same hex EWKB form as `geometry`, so reading and
 * writing work exactly as for {@link PgGeometry}.
 */
export class PgGeography
	extends PgColumn<'object geojson', PgColumnBaseConfig<'object geojson'>, PgGeometryRuntimeConfig>
{
	static override readonly [entityKind]: string = 'PgGeography';

	/** @internal */
	override readonly codec = 'geography';

	/** The `type` option as written; `undefined` means any subtype. */
	readonly type: string | undefined = this.config.type;
	/** The `srid` option as written. */
	readonly srid: number | undefined = this.config.srid;
	readonly mode = 'geojson';
	/** `true` for M-only subtypes: the third number of a position is written as M. */
	readonly mOnly: boolean = isMOnlyGeometryType(this.config.type);

	getSQLType(): string {
		return formatGeometrySqlType('geography', this.type, this.srid);
	}

	/**
	 * GeoJSON to EWKT with the column's SRID. A string is passed through
	 * unchanged, so WKT, EWKT and hex EWKB text can be used as values.
	 */
	override mapToDriverValue = (value: Geometry | string): string => {
		if (typeof value === 'string') return value;
		return geoJSONToEWKT(value, { srid: this.srid, mOnly: this.mOnly });
	};
}

/**
 * PostGIS `geography` column.
 *
 * Values are GeoJSON objects (RFC 7946) typed after the `type` option. See
 * {@link PgGeographyConfig} for the options.
 *
 * @example
 * ```ts
 * const places = pgTable('places', {
 *   any: geography(),                                    // geography                     -> Geometry
 *   place: geography({ type: 'Point' }),                 // geography(point)              -> Point
 *   region: geography({ type: 'MultiPolygon', srid: 4326 }), // geography(multipolygon,4326) -> MultiPolygon
 * });
 * ```
 */
export function geography(): PgGeographyBuilder<Geometry>;
export function geography(name: string): PgGeographyBuilder<Geometry>;
export function geography<TType extends PgGeometryTypeInput = 'Geometry'>(
	config: PgGeographyConfig<TType>,
): PgGeographyBuilder<GeoJSONFor<TType>>;
export function geography<TType extends PgGeometryTypeInput = 'Geometry'>(
	name: string,
	config: PgGeographyConfig<TType>,
): PgGeographyBuilder<GeoJSONFor<TType>>;
export function geography(a?: string | PgGeographyConfig, b?: PgGeographyConfig): any {
	const { name, config } = getColumnNameAndConfig<PgGeographyConfig | undefined>(a, b);
	return new PgGeographyBuilder(name, config);
}
