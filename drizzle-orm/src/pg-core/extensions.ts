import { entityKind } from '~/entity.ts';

export interface PgExtensionConfig {
	/** The schema the extension's objects are installed in; the default schema when left out. */
	schema?: string;
	/** The version to install; the default version when left out. */
	version?: string;
	/** Whether the extensions this one depends on are installed with it (`CASCADE`). */
	cascade?: boolean;
}

/**
 * An extension the database has installed, as the schema declares it.
 * drizzle-kit creates it before every other object, since types, functions
 * and operators of the schema may come from it, and drops it last.
 */
export class PgExtension {
	static readonly [entityKind]: string = 'PgExtension';

	readonly name: string;
	readonly schema: string | undefined;
	readonly version: string | undefined;
	readonly cascade: boolean;

	constructor(name: string, config: PgExtensionConfig = {}) {
		if (!name) {
			throw new Error('An extension must have a name');
		}
		this.name = name;
		this.schema = config.schema;
		this.version = config.version;
		this.cascade = config.cascade ?? false;
	}
}

/**
 * Declares an extension. Export it from a schema file and drizzle-kit
 * creates it with `CREATE EXTENSION IF NOT EXISTS`.
 *
 * ```ts
 * export const postgis = pgExtension('postgis');
 * export const search = pgExtension('pg_search', { cascade: true });
 * ```
 */
export function pgExtension(name: string, config?: PgExtensionConfig): PgExtension {
	return new PgExtension(name, config);
}
