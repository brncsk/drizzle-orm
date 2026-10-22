import { is, isSQLWrapper, Param, SQL, Subquery, Table as DrizzleTable } from 'drizzle-orm';
import {
	type CockroachMaterializedView,
	type CockroachSchema,
	type CockroachView,
	getMaterializedViewConfig as crdbMatViewConfig,
	getViewConfig as crdbViewConfig,
} from 'drizzle-orm/cockroach-core';
import { getViewConfig as mssqlViewConfig, type MsSqlSchema, type MsSqlView } from 'drizzle-orm/mssql-core';
import { getViewConfig as mysqlViewConfig, type MySqlView } from 'drizzle-orm/mysql-core';
import {
	getMaterializedViewConfig as pgMatViewConfig,
	getViewConfig as pgViewConfig,
	type PgGrant,
	type PgMaterializedView,
	type PgPublication,
	type PgRole,
	type PgSchema,
	type PgView,
} from 'drizzle-orm/pg-core';
import { getViewConfig as sqliteViewConfig, type SQLiteView } from 'drizzle-orm/sqlite-core';
import type { Schema, Table } from './pull-utils';
import type { EntityKey } from './utils';

export const extractPostgresExisting = (
	schemas: PgSchema[],
	views: PgView[],
	matViews: PgMaterializedView[],
): (Schema | Table)[] => {
	const existingSchemas = schemas.filter((x) => x.isExisting).map<Schema>((x) => ({
		type: 'schema',
		name: x.schemaName,
	}));
	const existingViews = views.map((x) => pgViewConfig(x)).filter((x) => x.isExisting).map<Table>((x) => ({
		type: 'table',
		schema: x.schema ?? 'public',
		name: x.name,
	}));
	const existingMatViews = matViews.map((x) => pgMatViewConfig(x)).filter((x) => x.isExisting).map<Table>((
		x,
	) => ({
		type: 'table',
		schema: x.schema ?? 'public',
		name: x.name,
	}));

	return [...existingSchemas, ...existingViews, ...existingMatViews];
};

/**
 * The roles a drizzle schema names: declared with `pgRole`, or granted to
 * with `pgGrant`. Their privileges in the database are the schema's to
 * manage, whatever the roles filter says; a privilege held by any other
 * role is left alone, so `push` never revokes what it did not grant.
 */
export const declaredRoles = (schema: { roles: PgRole[]; grants: PgGrant[] }): string[] => {
	const names = new Set<string>();
	for (const role of schema.roles) names.add(role.name);
	for (const grant of schema.grants) names.add(granteeName(grant.to));
	return [...names];
};

/** The names of the publications the schema declares: the only ones a push manages. */
export const declaredPublications = (schema: { publications: PgPublication[] }): string[] =>
	schema.publications.map((it) => it.name);

/** The grantee as the database reports it: `PUBLIC`, the pseudo-role every role is in, in any spelling, or the role's name. */
export const granteeName = (to: PgGrant['to']): string => {
	const name = typeof to === 'string' ? to : to.name;
	return name.toUpperCase() === 'PUBLIC' ? 'PUBLIC' : name;
};

export const extractCrdbExisting = (
	schemas: CockroachSchema[],
	views: CockroachView[],
	matViews: CockroachMaterializedView[],
): (Schema | Table)[] => {
	const existingSchemas = schemas.filter((x) => x.isExisting).map<Schema>((x) => ({
		type: 'schema',
		name: x.schemaName,
	}));
	const existingViews = views.map((x) => crdbViewConfig(x)).filter((x) => x.isExisting).map<Table>((x) => ({
		type: 'table',
		schema: x.schema ?? 'public',
		name: x.name,
	}));

	const existingMatViews = matViews.map((x) => crdbMatViewConfig(x)).filter((x) => x.isExisting).map<Table>((
		x,
	) => ({
		type: 'table',
		schema: x.schema ?? 'public',
		name: x.name,
	}));

	return [...existingSchemas, ...existingViews, ...existingMatViews];
};

export const extractMssqlExisting = (
	schemas: MsSqlSchema[],
	views: MsSqlView[],
): (Schema | Table)[] => {
	const existingSchemas = schemas.filter((x) => x.isExisting).map<Schema>((x) => ({
		type: 'schema',
		name: x.schemaName,
	}));
	const existingViews = views.map((x) => mssqlViewConfig(x)).filter((x) => x.isExisting).map<Table>((x) => ({
		type: 'table',
		schema: x.schema ?? 'public',
		name: x.name,
	}));

	return [...existingSchemas, ...existingViews];
};

export const extractMysqlExisting = (
	views: MySqlView[],
): Table[] => {
	const existingViews = views.map((x) => mysqlViewConfig(x)).filter((x) => x.isExisting).map<Table>((x) => ({
		type: 'table',
		schema: x.schema ?? 'public',
		name: x.name,
	}));

	return [...existingViews];
};

export const extractSqliteExisting = (
	views: SQLiteView[],
): Table[] => {
	const existingViews = views.map((x) => sqliteViewConfig(x)).filter((x) => x.isExisting).map<Table>((x) => ({
		type: 'table',
		schema: x.schema ?? 'public',
		name: x.name,
	}));

	return [...existingViews];
};

/*
	Collects views referenced by a view query by walking the SQL object tree (not the sql string):
	from/subqueries/CTEs/`${view}` interpolations are found,
	names written as plain text inside raw sql (sql`select * from "v1"`, sql.raw) are not
	`viewKey` returns a key for a view of the current dialect, null for anything else
	What it finds (see `view-dependencies` tests in each dialect tests folder):

	| view query                                           | pg / cockroach | mssql | mysql | sqlite |
	| ---------------------------------------------------- | -------------- | ----- | ----- | ------ |
	| .from(v1)                                            | ✅             | ✅    | ✅    | ✅     |
	| subquery in where (inArray(…, qb.select().from(v2))) | ✅             | ✅    | ✅    | ✅     |
	| exists(qb.select().from(v1))                         | ✅             | ✅    | ✅    | ✅     |
	| subquery in from                                     | ✅             | ✅    | ✅    | ✅     |
	| subquery in select fields                            | ✅             | ✅    | ✅    | ✅     |
	| joined subquery (.leftJoin(qb…from(v1).as('sq'), …)) | ✅             | ✅    | ✅    | ✅     |
	| lateral join / cross apply with subquery             | ✅             | ✅    | ✅    | -      |
	| CTE ($with(...).as(qb.select().from(v2)))            | ✅             | ✅    | ✅    | ✅     |
	| set operators (union, intersect, except, ...)        | ✅             | ✅    | ✅    | ✅     |
	| query builder instead of callback (.as(qb…from(v1))) | ✅             | ✅    | ✅    | ✅     |
	| sql`select * from ${v1}` interpolation               | ✅             | ✅    | ✅    | ✅     |
	| materialized view                                    | ✅             | -     | -     | -      |
	| view in another schema                               | ✅             | ✅    | -     | -      |
	| .existing() dependency (kept, skipped by the sort)   | ✅             | ✅    | ✅    | ✅     |
	| .existing() view itself (no entry)                   | ✅             | ✅    | ✅    | ✅     |
	| joined view, any join type (.leftJoin(v1, …), ...)   | ❌             | ❌    | ❌    | ✅     |
	| .from(alias(v1, 'x'))                                | ❌             | ❌    | ❌    | ❌     |
	| sql`select * from "v1"` (plain text), sql.raw        | ❌             | ❌    | ❌    | ❌     |
	| sql.identifier('v1')                                 | ❌             | ❌    | ❌    | ❌     |

	Joined views are missed in pg/cockroach/mssql/mysql, and aliased views in from are missed in all dialects:
	the dialect writes them as plain quoted names (e.g. pg-core/dialect.ts:423–432, :457–462), so the view object never appears in the SQL tree
	sqlite keeps the joined view object in the SQL tree, so joins are found there
*/
export const findViewDependencies = (query: SQL, viewKey: (chunk: unknown) => EntityKey | null): EntityKey[] => {
	const dependencies = new Set<EntityKey>();
	const visited = new Set<unknown>();

	const walk = (chunk: unknown): void => {
		if (typeof chunk !== 'object' || chunk === null || visited.has(chunk)) return;
		visited.add(chunk);

		const key = viewKey(chunk);
		if (key !== null) {
			dependencies.add(key);
			return;
		}
		if (is(chunk, DrizzleTable)) return;
		if (is(chunk, SQL)) return chunk.queryChunks.forEach(walk);
		if (is(chunk, SQL.Aliased)) return walk(chunk.sql);
		if (is(chunk, Subquery)) return walk(chunk._.sql);
		if (is(chunk, Param)) return walk(chunk.value);
		if (Array.isArray(chunk)) return chunk.forEach(walk);
		if (isSQLWrapper(chunk)) return walk(chunk.getSQL());
	};

	walk(query);

	return [...dependencies];
};

export const sqlToStr = (sql: SQL) => {
	return sql.toQuery({
		escapeName: () => {
			throw new Error("we don't support params for `sql` default values");
		},
		escapeParam: () => {
			throw new Error("we don't support params for `sql` default values");
		},
		escapeString: () => {
			throw new Error("we don't support params for `sql` default values");
		},
	}).sql;
};
