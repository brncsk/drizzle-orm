import { entityKind, is } from '~/entity.ts';
import { Table } from '~/table.ts';
import type { PgColumn } from './columns/common.ts';
import { PgSchema } from './schema.ts';
import { PgTable } from './table.ts';

/** A change a publication sends: `insert`, `update`, `delete` or `truncate`. */
export type PgPublicationAction = 'insert' | 'update' | 'delete' | 'truncate';

/** The four changes, in the order Postgres prints them; a publication sends all of them unless it says otherwise. */
export const pgPublicationActions: readonly PgPublicationAction[] = ['insert', 'update', 'delete', 'truncate'];

/** A table a publication sends with only some of its columns. */
export interface PgPublicationTableColumns {
	table: PgTable;
	/** The columns the publication sends. Postgres sends no other column of the table, in a new row or in an old one. */
	columns: [PgColumn, ...PgColumn[]];
}

/** A table in a publication: the table alone (every column), or the table with a list of its columns. */
export type PgPublicationTable = PgTable | PgPublicationTableColumns;

export interface PgPublicationConfig {
	/** The tables the publication sends (`FOR TABLE`), each with every column or with a list of columns. */
	tables?: PgPublicationTable[];
	/**
	 * The schemas whose every table the publication sends, the tables created
	 * later included (`FOR TABLES IN SCHEMA`): a declared schema, or the name
	 * of a schema (`'public'`). Postgres refuses a column list in a
	 * publication that names a schema.
	 */
	schemas?: (PgSchema | string)[];
	/** Whether the publication sends every table of the database, the tables created later included (`FOR ALL TABLES`). It takes no `tables` and no `schemas`. */
	allTables?: boolean;
	/** The changes the publication sends. All four when not given. */
	publish?: [PgPublicationAction, ...PgPublicationAction[]];
	/** Whether a change to a partition is sent as a change to its partitioned table (`publish_via_partition_root`). */
	publishViaPartitionRoot?: boolean;
}

/** A table in a publication, resolved: the table, and the columns it is sent with (`null` for every column). */
export interface PgPublicationMember {
	readonly table: PgTable;
	readonly columns: readonly PgColumn[] | null;
}

/**
 * A publication: the changes of which tables logical replication sends
 * to a subscriber or a replication slot. drizzle-kit creates it after
 * the tables and the columns it names, adds and drops its tables to
 * match the declaration, and changes its options in place.
 */
export class PgPublication {
	static readonly [entityKind]: string = 'PgPublication';

	readonly name: string;
	readonly tables: readonly PgPublicationMember[];
	readonly schemas: readonly string[];
	readonly allTables: boolean;
	readonly publish: readonly PgPublicationAction[];
	readonly publishViaPartitionRoot: boolean;

	constructor(name: string, config: PgPublicationConfig) {
		if (!name) {
			throw new Error('A publication must have a name');
		}
		const tables = (config.tables ?? []).map((it): PgPublicationMember =>
			is(it, PgTable) ? { table: it, columns: null } : { table: it.table, columns: it.columns }
		);
		const schemas = (config.schemas ?? []).map((it) => is(it, PgSchema) ? it.schemaName : it);
		const allTables = config.allTables ?? false;

		if (allTables && (tables.length > 0 || schemas.length > 0)) {
			throw new Error(`Publication "${name}" sends every table, so it takes no tables and no schemas`);
		}
		for (const { table, columns } of tables) {
			if (columns === null) continue;
			if (columns.length === 0) {
				throw new Error(`Publication "${name}" lists no column of table "${table[Table.Symbol.Name]}"`);
			}
			const foreign = columns.find((column) => column.table !== table);
			if (foreign) {
				throw new Error(
					`Publication "${name}" lists column "${foreign.name}" with table "${
						table[Table.Symbol.Name]
					}", which does not have it`,
				);
			}
			if (schemas.length > 0) {
				throw new Error(
					`Publication "${name}" names a schema, and Postgres takes no column list in such a publication`,
				);
			}
		}
		if (config.publish && config.publish.length === 0) {
			throw new Error(`Publication "${name}" must publish at least one change`);
		}

		this.name = name;
		this.tables = tables;
		this.schemas = schemas;
		this.allTables = allTables;
		// the order Postgres prints them in, so that a declaration and the database compare equal
		this.publish = pgPublicationActions.filter((it) => (config.publish ?? pgPublicationActions).includes(it));
		this.publishViaPartitionRoot = config.publishViaPartitionRoot ?? false;
	}
}

/**
 * Declares a publication. Export it from a schema file and drizzle-kit
 * keeps the publication in step with the declaration.
 *
 * ```ts
 * export const changes = pgPublication('changes', {
 * 	tables: [users, { table: posts, columns: [posts.id, posts.authorId] }],
 * 	publish: ['insert', 'update', 'delete'],
 * });
 * ```
 */
export function pgPublication(name: string, config: PgPublicationConfig): PgPublication {
	return new PgPublication(name, config);
}

/** How a table names an old row in an update or a delete that logical replication sends. */
export type PgReplicaIdentityKind = 'default' | 'full' | 'nothing';

/**
 * The replica identity of a table: what an update or a delete on it
 * carries of the old row (`ALTER TABLE ... REPLICA IDENTITY`). Return it
 * from the table's extra config, beside the indexes. See `replicaIdentity()`.
 */
export class PgReplicaIdentity {
	static readonly [entityKind]: string = 'PgReplicaIdentity';

	/** `index` when the identity is a unique index, named by `index`. */
	readonly kind: PgReplicaIdentityKind | 'index';
	/** The name of the unique index, when `kind` is `index`. */
	readonly index: string | null;

	constructor(identity: PgReplicaIdentityKind | { index: string }) {
		if (typeof identity === 'string') {
			this.kind = identity;
			this.index = null;
		} else {
			if (!identity.index) {
				throw new Error('A replica identity index must be named');
			}
			this.kind = 'index';
			this.index = identity.index;
		}
	}
}

/**
 * Declares the replica identity of a table, in its extra config:
 *
 * - `'default'` (what a table has when it declares none): the primary key.
 * - `'full'`: the whole old row.
 * - `'nothing'`: no old row. Postgres refuses an update or a delete on
 *   such a table once a publication that sends them includes it.
 * - `{ index: name }`: the columns of a unique index of the table, named
 *   as the index is named in the same extra config. Its columns must be
 *   `NOT NULL`, and the index must not be partial or deferrable.
 *
 * ```ts
 * export const objects = pgTable('objects', { id: uuid().notNull(), type: text().notNull() }, (t) => [
 * 	uniqueIndex('objects_id_type').on(t.id, t.type),
 * 	replicaIdentity({ index: 'objects_id_type' }),
 * ]);
 * export const grants = pgTable('grants', { ... }, () => [replicaIdentity('full')]);
 * ```
 */
export function replicaIdentity(identity: PgReplicaIdentityKind | { index: string }): PgReplicaIdentity {
	return new PgReplicaIdentity(identity);
}
