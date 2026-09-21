import { entityKind } from '~/entity.ts';
import type { PgFunction } from './functions.ts';
import type { PgTable } from './table.ts';

/** When a trigger fires: `BEFORE INSERT OR UPDATE`, `AFTER DELETE`, `INSTEAD OF INSERT`, ... */
export type PgTriggerWhen = string;

export interface PgTriggerConfig {
	/** The table the trigger is bound to: the declared table, or its name (`schema.table` when not in `public`). */
	on: PgTable | string;
	/** `BEFORE INSERT OR UPDATE`, `AFTER DELETE`, ... */
	when: PgTriggerWhen;
	/** `ROW` (the default) fires once per row; `STATEMENT` once per statement. */
	level?: 'ROW' | 'STATEMENT';
	/** The trigger function: the declared function, or its qualified name. It takes no parameters and returns `trigger`. */
	function: PgFunction | string;
	/** The comment the trigger carries in the database (`COMMENT ON TRIGGER`). */
	comment?: string;
}

/**
 * A trigger of a table, as the schema declares it: when it fires, at which
 * level, and the function it calls. drizzle-kit creates it after its table
 * and its function exist, replaces it in place when it changes, and drops
 * it before the function it calls is dropped.
 */
export class PgTrigger {
	static readonly [entityKind]: string = 'PgTrigger';

	readonly name: string;
	readonly on: PgTable | string;
	readonly when: PgTriggerWhen;
	readonly level: 'ROW' | 'STATEMENT';
	readonly function: PgFunction | string;
	readonly comment: string | undefined;

	constructor(name: string, config: PgTriggerConfig) {
		if (!name) {
			throw new Error('A trigger must have a name');
		}
		if (!config.when) {
			throw new Error(`Trigger "${name}" must declare when it fires`);
		}
		this.name = name;
		this.on = config.on;
		this.when = config.when;
		this.level = config.level ?? 'ROW';
		this.function = config.function;
		this.comment = config.comment;
	}
}

/**
 * Declares a trigger. Export it from a schema file and drizzle-kit keeps
 * the trigger in step with the declaration.
 *
 * ```ts
 * export const usersAudit = pgTrigger('users_audit', {
 * 	on: users,
 * 	when: 'AFTER INSERT OR UPDATE',
 * 	function: auditRow,
 * });
 * ```
 */
export function pgTrigger(name: string, config: PgTriggerConfig): PgTrigger {
	return new PgTrigger(name, config);
}
