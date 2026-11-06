import { entityKind, is } from '~/entity.ts';
import type { PgFunction } from './functions.ts';
import type { PgTable } from './table.ts';

/** When a trigger fires: `BEFORE INSERT OR UPDATE`, `AFTER DELETE`, `INSTEAD OF INSERT`, ... */
export type PgTriggerWhen = string;

/**
 * Makes a trigger a constraint trigger (`CREATE CONSTRAINT TRIGGER`). A
 * constraint trigger is an `AFTER ... FOR EACH ROW` trigger whose calls
 * can wait until the end of the transaction. With `initiallyDeferred`,
 * Postgres queues the call of each row and runs the calls at `COMMIT` (or
 * at `SET CONSTRAINTS ... IMMEDIATE`), so the function sees the final
 * state of the transaction, and an error refuses the commit.
 */
export interface PgConstraintTriggerConfig {
	/** The calls can wait until the end of the transaction (`DEFERRABLE`). `NOT DEFERRABLE` when left out. */
	deferrable?: boolean;
	/** The calls wait until the end of the transaction unless `SET CONSTRAINTS` says otherwise (`INITIALLY DEFERRED`). It needs `deferrable`. `INITIALLY IMMEDIATE` when left out. */
	initiallyDeferred?: boolean;
}

/**
 * The transition tables of an `AFTER` trigger (`REFERENCING OLD TABLE AS
 * ... NEW TABLE AS ...`): the rows of the statement before it ran and after
 * it ran, under the names that the function's queries use. A
 * statement-level trigger reads the rows of the whole statement this way,
 * in one query, instead of one call per row.
 */
export interface PgTriggerTransitionTables {
	/** The name of the rows as they were before the statement. Only an `UPDATE` or `DELETE` trigger has it. */
	oldTable?: string;
	/** The name of the rows as they are after the statement. Only an `INSERT` or `UPDATE` trigger has it. */
	newTable?: string;
}

export interface PgTriggerConfig {
	/** The table the trigger is bound to: the declared table, or its name (`schema.table` when not in `public`). */
	on: PgTable | string;
	/** `BEFORE INSERT OR UPDATE`, `AFTER DELETE`, ... */
	when: PgTriggerWhen;
	/** `ROW` (the default) fires once per row; `STATEMENT` once per statement. */
	level?: 'ROW' | 'STATEMENT';
	/**
	 * The `WHEN` condition: a boolean SQL expression over `OLD` and `NEW`,
	 * without the parentheses around it. Postgres calls the function only
	 * for a row that satisfies it. On an `AFTER` trigger, a row that fails
	 * it queues no event, so the function is not entered at all.
	 */
	condition?: string;
	/**
	 * Makes the trigger a constraint trigger, with its deferral. Postgres
	 * accepts a constraint trigger only at `AFTER` and at the `ROW` level.
	 * A plain trigger when left out.
	 */
	constraint?: PgConstraintTriggerConfig;
	/**
	 * The transition tables of the trigger, at least one of the two.
	 * Postgres accepts them only on a plain `AFTER` trigger with one event
	 * and no column list (`AFTER INSERT`, not `AFTER INSERT OR UPDATE` or
	 * `AFTER UPDATE OF name`). None when left out.
	 */
	referencing?: PgTriggerTransitionTables;
	/** The trigger function: the declared function, or its qualified name. It takes no parameters and returns `trigger`. */
	function: PgFunction | string;
	/** The comment the trigger carries in the database (`COMMENT ON TRIGGER`). */
	comment?: string;
}

/**
 * Refuses the transition tables that Postgres refuses: none named, on a
 * trigger that is not a plain `AFTER` trigger, on more than one event or
 * on a column list, and a table that the event does not have (an old
 * table of an `INSERT`, a new table of a `DELETE`).
 */
function checkTransitionTables(name: string, config: PgTriggerConfig): void {
	const { oldTable, newTable } = config.referencing ?? {};
	if (!oldTable && !newTable) {
		throw new Error(`Trigger "${name}" declares transition tables, so it names an old table, a new table or both`);
	}
	const timing = /^\s*AFTER\s+(?<events>.+)$/is.exec(config.when);
	if (!timing?.groups || config.constraint) {
		throw new Error(`Trigger "${name}" has transition tables, so it is a plain AFTER trigger`);
	}
	const events = timing.groups['events']!.trim();
	if (/\s+OR\s+/i.test(events) || /\s+OF\s+/i.test(events)) {
		throw new Error(`Trigger "${name}" has transition tables, so it fires on one event, without a column list`);
	}
	const event = events.toUpperCase();
	if (oldTable && event !== 'UPDATE' && event !== 'DELETE') {
		throw new Error(`Trigger "${name}" has an old table, so it fires AFTER UPDATE or AFTER DELETE`);
	}
	if (newTable && event !== 'INSERT' && event !== 'UPDATE') {
		throw new Error(`Trigger "${name}" has a new table, so it fires AFTER INSERT or AFTER UPDATE`);
	}
}

/**
 * A trigger of a table, as the schema declares it: when it fires, at which
 * level, on which condition, whether it is a constraint trigger, its
 * transition tables, and the function it calls. drizzle-kit creates it after its table and its
 * function exist, replaces it in place when it changes (a constraint
 * trigger is dropped and created again, since Postgres cannot replace
 * one), and drops it before the function it calls is dropped.
 */
export class PgTrigger {
	static readonly [entityKind]: string = 'PgTrigger';
	static [Symbol.hasInstance](value: unknown): boolean {
		return is(value, this);
	}

	readonly name: string;
	readonly on: PgTable | string;
	readonly when: PgTriggerWhen;
	readonly level: 'ROW' | 'STATEMENT';
	readonly condition: string | undefined;
	readonly constraint: Required<PgConstraintTriggerConfig> | undefined;
	readonly referencing: PgTriggerTransitionTables | undefined;
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
		this.condition = config.condition;
		if (config.constraint && (!/^\s*AFTER\b/i.test(config.when) || this.level !== 'ROW')) {
			throw new Error(`Trigger "${name}" is a constraint trigger, so it fires AFTER and FOR EACH ROW`);
		}
		if (config.constraint?.initiallyDeferred && !config.constraint.deferrable) {
			throw new Error(`Trigger "${name}" is initially deferred, so it must be deferrable`);
		}
		this.constraint = config.constraint
			? {
				deferrable: config.constraint.deferrable ?? false,
				initiallyDeferred: config.constraint.initiallyDeferred ?? false,
			}
			: undefined;
		if (config.referencing) {
			checkTransitionTables(name, config);
		}
		this.referencing = config.referencing;
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
 *
 * // one call per statement, which reads the inserted rows as `added`
 * export const ordersAdded = pgTrigger('orders_added', {
 * 	on: orders,
 * 	when: 'AFTER INSERT',
 * 	level: 'STATEMENT',
 * 	referencing: { newTable: 'added' },
 * 	function: countOrders,
 * });
 *
 * // checked at COMMIT, against the final state of the transaction
 * export const ordersBalanced = pgTrigger('orders_balanced', {
 * 	on: orders,
 * 	when: 'AFTER INSERT OR UPDATE',
 * 	constraint: { deferrable: true, initiallyDeferred: true },
 * 	function: checkBalance,
 * });
 * ```
 */
export function pgTrigger(name: string, config: PgTriggerConfig): PgTrigger {
	return new PgTrigger(name, config);
}
