import { entityKind } from '~/entity.ts';
import type { PgTable } from '~/pg-core/table.ts';
import { getColumnNameAndConfig } from '~/utils.ts';
import type { PgColumnBaseConfig } from '../common.ts';
import { PgColumn, PgColumnBuilder } from '../common.ts';
import { geoJSONToEWKT } from './ewkt.ts';
import type { Geometry } from './geojson.ts';
import type { GeoJSONFor, PgGeometryMode, PgGeometryModeFor, PgGeometryTypeInput } from './types.ts';
import {
	formatGeometrySqlType,
	isMOnlyGeometryType,
	isPointGeometryType,
	type PgGeometryRuntimeConfig,
} from './utils.ts';

/**
 * Options of {@link geometry}.
 *
 * @typeParam TType the `type` option; it selects the GeoJSON type of the column's values
 * @typeParam TMode the `mode` option; `'tuple'` and `'xy'` need `type: 'Point'`
 */
export interface PgGeometryConfig<
	TType extends PgGeometryTypeInput = PgGeometryTypeInput,
	TMode extends PgGeometryMode = PgGeometryMode,
> {
	/**
	 * PostGIS subtype, written into the typmod: `'Point'`, `'MultiPolygon'`,
	 * `'LineStringZ'`, `'PointZM'`, ... in PostGIS or lowercase casing.
	 * Omit it (or use `'Geometry'`) for a column that accepts every subtype.
	 * The value type follows: `'MultiPolygon'` reads and writes
	 * `MultiPolygon` objects, `'Geometry'` the `Geometry` union.
	 *
	 * Curve and surface subtypes (`'CircularString'`, `'TIN'`, ...) are
	 * accepted for the typmod only: their values type as `unknown` and
	 * reading one throws, because GeoJSON has no form for them.
	 */
	type?: TType;
	/**
	 * Spatial reference identifier, written into the typmod
	 * (`geometry(point,4326)`) and as an `SRID=n;` prefix on every value
	 * the column writes. Values read back carry no SRID member: GeoJSON is
	 * WGS 84 by definition (RFC 7946 section 4).
	 */
	srid?: number;
	/**
	 * Client-side representation. `'geojson'` (default) returns RFC 7946
	 * objects for every subtype. `'tuple'` (`[x, y]`) and `'xy'`
	 * (`{ x, y }`) are the pre-GeoJSON point shapes and need
	 * `type: 'Point'`.
	 */
	mode?: TMode;
}

/**
 * Builder of a PostGIS `geometry` column that reads and writes GeoJSON.
 *
 * @typeParam TGeom the GeoJSON type of the column's values
 */
export class PgGeometryBuilder<TGeom = Geometry> extends PgColumnBuilder<{
	dataType: 'object geojson';
	data: TGeom;
	driverParam: string;
}, PgGeometryRuntimeConfig> {
	static override readonly [entityKind]: string = 'PgGeometryBuilder';

	constructor(name: string, config: PgGeometryConfig | undefined) {
		super(name, 'object geojson', 'PgGeometry');
		this.config.type = config?.type;
		this.config.srid = config?.srid;
	}

	/** @internal */
	override build(table: PgTable<any>) {
		return new PgGeometry(table, this.config as any);
	}
}

/**
 * PostGIS `geometry` column that reads and writes GeoJSON.
 *
 * Reading is done by the `geometry` codec, which parses the hex EWKB that
 * PostGIS sends. Writing goes through {@link geoJSONToEWKT}, so a value
 * reaches PostGIS as `SRID=4326;MULTIPOLYGON(((...)))`, which PostGIS
 * accepts as a parameter, as an inlined literal and as a column default.
 */
export class PgGeometry
	extends PgColumn<'object geojson', PgColumnBaseConfig<'object geojson'>, PgGeometryRuntimeConfig>
{
	static override readonly [entityKind]: string = 'PgGeometry';

	/** @internal */
	override readonly codec = 'geometry';

	/** The `type` option as written; `undefined` means any subtype. */
	readonly type: string | undefined = this.config.type;
	/** The `srid` option as written. */
	readonly srid: number | undefined = this.config.srid;
	readonly mode = 'geojson';
	/** `true` for M-only subtypes: the third number of a position is written as M. */
	readonly mOnly: boolean = isMOnlyGeometryType(this.config.type);

	getSQLType(): string {
		return formatGeometrySqlType('geometry', this.type, this.srid);
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

/** Builder of a PostGIS `geometry(point)` column that reads and writes `[x, y]` tuples. */
export class PgGeometryTupleBuilder extends PgColumnBuilder<{
	dataType: 'array geometry';
	data: [number, number];
	driverParam: string;
}, PgGeometryRuntimeConfig> {
	static override readonly [entityKind]: string = 'PgGeometryTupleBuilder';

	constructor(name: string, config: PgGeometryConfig | undefined) {
		super(name, 'array geometry', 'PgGeometryTuple');
		this.config.type = config?.type;
		this.config.srid = config?.srid;
	}

	/** @internal */
	override build(table: PgTable<any>) {
		return new PgGeometryTuple(table, this.config as any);
	}
}

/**
 * PostGIS `geometry(point)` column that reads and writes `[x, y]` tuples
 * (`mode: 'tuple'`).
 */
export class PgGeometryTuple
	extends PgColumn<'array geometry', PgColumnBaseConfig<'array geometry'>, PgGeometryRuntimeConfig>
{
	static override readonly [entityKind]: string = 'PgGeometryTuple';

	/** @internal */
	override readonly codec = 'geometry:tuple';

	readonly type: string | undefined = this.config.type;
	readonly srid: number | undefined = this.config.srid;
	readonly mode = 'tuple';

	getSQLType(): string {
		return formatGeometrySqlType('geometry', this.type, this.srid);
	}

	override mapToDriverValue = (value: [number, number]): string => {
		return geoJSONToEWKT({ type: 'Point', coordinates: value }, { srid: this.srid });
	};
}

/** Builder of a PostGIS `geometry(point)` column that reads and writes `{ x, y }` objects. */
export class PgGeometryObjectBuilder extends PgColumnBuilder<{
	dataType: 'object geometry';
	data: { x: number; y: number };
	driverParam: string;
}, PgGeometryRuntimeConfig> {
	static override readonly [entityKind]: string = 'PgGeometryObjectBuilder';

	constructor(name: string, config: PgGeometryConfig | undefined) {
		super(name, 'object geometry', 'PgGeometryObject');
		this.config.type = config?.type;
		this.config.srid = config?.srid;
	}

	/** @internal */
	override build(table: PgTable<any>) {
		return new PgGeometryObject(table, this.config as any);
	}
}

/**
 * PostGIS `geometry(point)` column that reads and writes `{ x, y }` objects
 * (`mode: 'xy'`). Its `mode` property reads `'object'`, the name
 * drizzle-kit uses for this shape.
 */
export class PgGeometryObject
	extends PgColumn<'object geometry', PgColumnBaseConfig<'object geometry'>, PgGeometryRuntimeConfig>
{
	static override readonly [entityKind]: string = 'PgGeometryObject';

	/** @internal */
	override readonly codec = 'geometry:xy';

	readonly type: string | undefined = this.config.type;
	readonly srid: number | undefined = this.config.srid;
	readonly mode = 'object';

	getSQLType(): string {
		return formatGeometrySqlType('geometry', this.type, this.srid);
	}

	override mapToDriverValue = (value: { x: number; y: number }): string => {
		return geoJSONToEWKT({ type: 'Point', coordinates: [value.x, value.y] }, { srid: this.srid });
	};
}

/** The builder {@link geometry} returns for a `type` and `mode` pair. */
export type PgGeometryBuilderFor<TType extends string, TMode extends PgGeometryMode> = TMode extends 'tuple'
	? PgGeometryTupleBuilder
	: TMode extends 'xy' ? PgGeometryObjectBuilder
	: PgGeometryBuilder<GeoJSONFor<TType>>;

/**
 * PostGIS `geometry` column.
 *
 * Values are GeoJSON objects (RFC 7946) typed after the `type` option; the
 * `mode` option restores the `[x, y]` and `{ x, y }` point shapes. See
 * {@link PgGeometryConfig} for the options.
 *
 * @example
 * ```ts
 * const places = pgTable('places', {
 *   any: geometry(),                                            // geometry                    -> Geometry
 *   footprint: geometry({ type: 'MultiPolygon', srid: 4326 }),  // geometry(multipolygon,4326) -> MultiPolygon
 *   axis: geometry('axis', { type: 'LineStringZ', srid: 3857 }), // geometry(linestringz,3857) -> LineString
 *   legacy: geometry({ type: 'Point', mode: 'xy' }),            // geometry(point)             -> { x, y }
 *   parts: geometry({ type: 'Polygon', srid: 4326 }).array(),   // geometry(polygon,4326)[]    -> Polygon[]
 * });
 *
 * await db.insert(places).values({
 *   footprint: { type: 'MultiPolygon', coordinates: [[[[19.04, 47.49], [19.05, 47.49], [19.05, 47.5], [19.04, 47.49]]]] },
 * });
 * ```
 */
export function geometry(): PgGeometryBuilder<Geometry>;
export function geometry(name: string): PgGeometryBuilder<Geometry>;
export function geometry<
	TType extends PgGeometryTypeInput = 'Geometry',
	TMode extends PgGeometryModeFor<TType> = 'geojson',
>(config: PgGeometryConfig<TType, TMode>): PgGeometryBuilderFor<TType, TMode>;
export function geometry<
	TType extends PgGeometryTypeInput = 'Geometry',
	TMode extends PgGeometryModeFor<TType> = 'geojson',
>(name: string, config: PgGeometryConfig<TType, TMode>): PgGeometryBuilderFor<TType, TMode>;
export function geometry(a?: string | PgGeometryConfig, b?: PgGeometryConfig): any {
	const { name, config } = getColumnNameAndConfig<PgGeometryConfig | undefined>(a, b);
	const mode = config?.mode ?? 'geojson';
	if (mode === 'geojson') {
		return new PgGeometryBuilder(name, config);
	}
	if (!isPointGeometryType(config?.type)) {
		throw new Error(
			`geometry(): mode '${mode}' is only available with type 'Point' (got ${
				config?.type === undefined ? 'no type' : `'${config.type}'`
			}); use the default 'geojson' mode or set type: 'Point'`,
		);
	}
	return mode === 'tuple' ? new PgGeometryTupleBuilder(name, config) : new PgGeometryObjectBuilder(name, config);
}
