import { entityKind } from '~/entity.ts';
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
	/** The trigger function: the declared function, or its qualified name. It takes no parameters and returns `trigger`. */
	function: PgFunction | string;
	/** The comment the trigger carries in the database (`COMMENT ON TRIGGER`). */
	comment?: string;
}

/**
 * A trigger of a table, as the schema declares it: when it fires, at which
 * level, on which condition, whether it is a constraint trigger, and the
 * function it calls. drizzle-kit creates it after its table and its
 * function exist, replaces it in place when it changes (a constraint
 * trigger is dropped and created again, since Postgres cannot replace
 * one), and drops it before the function it calls is dropped.
 */
export class PgTrigger {
	static readonly [entityKind]: string = 'PgTrigger';

	readonly name: string;
	readonly on: PgTable | string;
	readonly when: PgTriggerWhen;
	readonly level: 'ROW' | 'STATEMENT';
	readonly condition: string | undefined;
	readonly constraint: Required<PgConstraintTriggerConfig> | undefined;
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
