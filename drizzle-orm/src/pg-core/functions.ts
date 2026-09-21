import { entityKind } from '~/entity.ts';
import { SQL, sql, type SQLWrapper } from '~/sql/sql.ts';

/** One parameter of a function: its name and its SQL type. */
export interface PgFunctionArg {
	name: string;
	type: string;
}

export interface PgFunctionConfig {
	/** The parameters, in order, by name: `{ role: 'uuid', keys: 'jsonb' }`. None when left out. */
	args?: Record<string, string>;
	/** The SQL return type: `void`, `jsonb`, `uuid[]`, `TABLE (id uuid, name text)`, `trigger`. */
	returns: string;
	/** The language the body is written in: `sql`, `plpgsql`, `pljs`, ... */
	language: string;
	/** The body, as it stands between the dollar quotes: text, or a statement drizzle renders. */
	body: string | SQL;
	/** Volatility, strictness, security and parallel safety, as written after `LANGUAGE`: `IMMUTABLE STRICT PARALLEL SAFE`. */
	attributes?: string;
	/** The comment the function carries in the database (`COMMENT ON FUNCTION`). */
	comment?: string;
}

/**
 * A function of the database, as the schema declares it: its signature,
 * its language, its body and its comment. drizzle-kit creates it, replaces
 * it in place when its body, its attributes or its comment change, and
 * drops and recreates it when its signature changes. Interpolated into
 * `sql`, it is its qualified name, so `sql\`SELECT ${fn}(1)\`` calls it.
 */
export class PgFunction implements SQLWrapper {
	static readonly [entityKind]: string = 'PgFunction';

	readonly schema: string | undefined;
	readonly name: string;
	readonly args: readonly PgFunctionArg[];
	readonly returns: string;
	readonly language: string;
	readonly body: string | SQL;
	readonly attributes: string | undefined;
	readonly comment: string | undefined;

	constructor(name: string, config: PgFunctionConfig, schema?: string) {
		if (!name) {
			throw new Error('A function must have a name');
		}
		if (!config.returns) {
			throw new Error(`Function "${name}" must declare what it returns`);
		}
		if (!config.language) {
			throw new Error(`Function "${name}" must declare its language`);
		}
		this.schema = schema;
		this.name = name;
		this.args = Object.entries(config.args ?? {}).map(([argName, type]) => ({ name: argName, type }));
		this.returns = config.returns;
		this.language = config.language;
		this.body = config.body;
		this.attributes = config.attributes;
		this.comment = config.comment;
	}

	/** The qualified name, as a call names it. */
	getSQL(): SQL {
		return this.schema === undefined
			? new SQL([sql.identifier(this.name)])
			: new SQL([sql.identifier(this.schema), sql.raw('.'), sql.identifier(this.name)]);
	}

	shouldOmitSQLParens(): boolean {
		return true;
	}
}

/**
 * Declares a function of the database. Export it from a schema file and
 * drizzle-kit keeps the function in step with the declaration.
 *
 * ```ts
 * export const total = pgFunction('total', {
 * 	args: { a: 'integer', b: 'integer' },
 * 	returns: 'integer',
 * 	language: 'sql',
 * 	attributes: 'IMMUTABLE STRICT',
 * 	body: 'SELECT $1 + $2',
 * 	comment: 'The sum of two integers.',
 * });
 * ```
 */
export function pgFunction(name: string, config: PgFunctionConfig): PgFunction {
	return new PgFunction(name, config);
}

/** @internal */
export function pgFunctionWithSchema(name: string, config: PgFunctionConfig, schema: string | undefined): PgFunction {
	return new PgFunction(name, config, schema);
}

export type PgFunctionFn = (name: string, config: PgFunctionConfig) => PgFunction;
