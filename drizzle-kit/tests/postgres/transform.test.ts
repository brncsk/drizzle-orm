import { getTableName } from 'drizzle-orm';
import { integer, pgFunction, PgTable, pgTable } from 'drizzle-orm/pg-core';
import { resolve } from 'path';
import { expect, test } from 'vitest';
import { prepareFromSchemaFiles } from '../../src/dialects/postgres/drizzle';
import { generateDrizzleJsonFromFiles, generateMigration } from '../../src/ext/api-postgres';

/*
	A config's `transform` sees each loaded schema file's exports and its
	path, and what it returns joins the exports before the schema objects
	are collected. This is how a schema is derived at load time from
	something drizzle-kit does not know how to read itself.
*/

const file = resolve(__dirname, 'schemas/transformed.ts');

test('a transform adds schema objects to a loaded file and replaces an export of the same name', async () => {
	const seen: string[] = [];
	const prepared = await prepareFromSchemaFiles([file], [
		async (exports, path) => {
			seen.push(path);
			const derived = exports.derived as { name: string };
			return {
				[derived.name]: pgTable(derived.name, { id: integer('id').primaryKey() }),
				users: pgTable('users_v2', { id: integer('id').primaryKey() }),
			};
		},
		async (exports) => {
			// a later transform sees what an earlier one added
			expect(exports.audit).toBeInstanceOf(PgTable);
			return {
				fn: pgFunction('count_audit', { returns: 'bigint', language: 'sql', body: 'SELECT count(*) FROM audit' }),
			};
		},
	]);
	expect(seen).toStrictEqual([file]);
	// what a transform returns follows the file's exports, in the transform's order, a replaced export among them
	expect(prepared.tables.map((it) => getTableName(it))).toStrictEqual(['audit', 'users_v2']);
	expect(prepared.functions.map((it) => it.name)).toStrictEqual(['count_audit']);
});

test('a transform orders what it returns: a function that replaces an export stands where the transform puts it', async () => {
	// `derived` is the file's second export; the function replacing it must come after the one its body calls
	const prepared = await prepareFromSchemaFiles([file], [
		async () => ({
			count_users: pgFunction('count_users', {
				returns: 'bigint',
				language: 'sql',
				body: 'SELECT count(*) FROM users',
			}),
			derived: pgFunction('total', { returns: 'bigint', language: 'sql', body: 'SELECT count_users() + 0' }),
		}),
	]);
	expect(prepared.functions.map((it) => it.name)).toStrictEqual(['count_users', 'total']);
});

test('a snapshot from files carries what the transforms derived, and compares against a previous one', async () => {
	const transform = async () => ({
		audit: pgTable('audit', { id: integer('id').primaryKey() }),
	});
	const plain = await generateDrizzleJsonFromFiles([file]);
	const transformed = await generateDrizzleJsonFromFiles([file], { transforms: [transform], prevId: plain.id });
	expect(plain.ddl.filter((it) => it.entityType === 'tables').map((it) => it.name)).toStrictEqual(['users']);
	expect(transformed.ddl.filter((it) => it.entityType === 'tables').map((it) => it.name)).toStrictEqual([
		'users',
		'audit',
	]);
	const statements = await generateMigration(plain, transformed);
	expect(statements).toStrictEqual(['CREATE TABLE "audit" (\n\t"id" integer PRIMARY KEY\n);\n']);
	expect(await generateMigration(transformed, transformed)).toStrictEqual([]);
});
