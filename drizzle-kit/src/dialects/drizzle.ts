import type { SQL } from 'drizzle-orm';
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
	type PgRole,
	type PgSchema,
	type PgView,
} from 'drizzle-orm/pg-core';
import { getViewConfig as sqliteViewConfig, type SQLiteView } from 'drizzle-orm/sqlite-core';
import type { Schema, Table } from './pull-utils';

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
