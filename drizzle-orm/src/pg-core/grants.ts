import { entityKind } from '~/entity.ts';
import type { PgRole } from './roles.ts';
import type { PgSchema } from './schema.ts';
import type { PgTable } from './table.ts';
import type { PgMaterializedView, PgView } from './view.ts';

/** What a role may do with a table or a view. */
export type PgTablePrivilege =
	| 'all'
	| 'select'
	| 'insert'
	| 'update'
	| 'delete'
	| 'truncate'
	| 'references'
	| 'trigger';

/** What a role may do with a schema. */
export type PgSchemaPrivilege = 'all' | 'usage' | 'create';

export type PgPrivilege = PgTablePrivilege | PgSchemaPrivilege;

/** What a grant is given on: a table, a view, a materialized view or a schema. */
export type PgGrantTarget = PgTable | PgView | PgMaterializedView | PgSchema;

/** What a grant is given to: a declared role, or the name of a role; `public`, in any spelling, is the `PUBLIC` pseudo-role every role is in. */
export type PgGranteeOption = PgRole | (string & {});

export interface PgGrantConfig<
	TTarget extends PgGrantTarget = PgGrantTarget,
	TPrivilege extends PgPrivilege = PgPrivilege,
> {
	/** The table, view or schema the role may reach. */
	on: TTarget;
	/** The role that may reach it. */
	to: PgGranteeOption;
	/** The privileges the role holds. Each one is a `GRANT` of its own. */
	privileges: [TPrivilege, ...TPrivilege[]];
	/** Whether the role may grant these privileges to other roles. */
	withGrantOption?: boolean;
}

/**
 * One or more privileges on one object. drizzle-kit writes a `GRANT` per
 * privilege, and revokes a privilege that the schema no longer declares.
 */
export class PgGrant {
	static readonly [entityKind]: string = 'PgGrant';

	readonly on: PgGrantTarget;
	readonly to: PgGranteeOption;
	readonly privileges: readonly PgPrivilege[];
	readonly withGrantOption: boolean;

	constructor(config: PgGrantConfig) {
		if (config.privileges.length === 0) {
			throw new Error('A grant must list at least one privilege');
		}
		this.on = config.on;
		this.to = config.to;
		this.privileges = config.privileges;
		this.withGrantOption = config.withGrantOption ?? false;
	}
}

/**
 * Declares what a role may do with a table, a view or a schema. Export it
 * from a schema file and drizzle-kit keeps the database's privileges in
 * step with it.
 *
 * ```ts
 * export const appRole = pgRole('app');
 * export const appReadsUsers = pgGrant({ on: users, to: appRole, privileges: ['select'] });
 * export const appUsesAuth = pgGrant({ on: authSchema, to: appRole, privileges: ['usage'] });
 * ```
 */
export function pgGrant<TTarget extends PgSchema>(
	config: PgGrantConfig<TTarget, PgSchemaPrivilege>,
): PgGrant;
export function pgGrant<TTarget extends PgTable | PgView | PgMaterializedView>(
	config: PgGrantConfig<TTarget, PgTablePrivilege>,
): PgGrant;
export function pgGrant(config: PgGrantConfig): PgGrant {
	return new PgGrant(config);
}
