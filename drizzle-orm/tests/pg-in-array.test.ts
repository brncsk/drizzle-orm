import { describe, expect, test } from 'vitest';
import { drizzle as sqliteDrizzle } from '~/better-sqlite3';
import { customType, integer, pgTable, text } from '~/pg-core';
import { drizzle } from '~/pglite';
import { inArray, notInArray, sql } from '~/sql';
import { fillPlaceholders } from '~/sql/sql.ts';
import { sqliteTable, text as sqliteText } from '~/sqlite-core';

/**
 * `inArray` and `notInArray` on a Postgres column of a scalar type bind a
 * list as one array parameter (`= any($1)`, `<> all($1)`): the text is the
 * same for a list of any length, and the list is bound as an array
 * literal. A subquery, an `SQL` chunk and a list on
 * another dialect keep `in (...)`.
 */

const db = drizzle.mock();

/** A column whose encoder is not the identity: a value goes in as `<value>`. */
const tagged = customType<{ data: string; driverData: string }>({
	dataType: () => 'text',
	toDriver: (value) => `<${value}>`,
});

const things = pgTable('things', {
	id: integer().primaryKey(),
	name: text(),
	tag: tagged(),
	labels: text().array(),
});

const where = (condition: ReturnType<typeof inArray>) =>
	db.select({ id: things.id }).from(things).where(condition).toSQL();

describe('inArray on a Postgres column', () => {
	test('a list is one array parameter, whatever its length', () => {
		expect(where(inArray(things.id, [1, 2, 3]))).toStrictEqual({
			sql: 'select "id" from "things" where "things"."id" = any($1)',
			params: ['{1,2,3}'],
		});
		expect(where(inArray(things.id, [1])).sql).toBe(where(inArray(things.id, [1, 2, 3])).sql);
	});

	test('an empty list is the same text, and matches no row', () => {
		expect(where(inArray(things.id, []))).toStrictEqual({
			sql: 'select "id" from "things" where "things"."id" = any($1)',
			params: ['{}'],
		});
	});

	test('notInArray is <> all, an empty list included', () => {
		expect(where(notInArray(things.id, [1, 2]))).toStrictEqual({
			sql: 'select "id" from "things" where "things"."id" <> all($1)',
			params: ['{1,2}'],
		});
		expect(where(notInArray(things.id, [])).params).toStrictEqual(['{}']);
	});

	test("each element goes through the column's encoder", () => {
		expect(where(inArray(things.tag, ['a', 'b'])).params).toStrictEqual(['{"<a>","<b>"}']);
		expect(where(inArray(things.tag, ['a', null as unknown as string])).params).toStrictEqual(['{"<a>",null}']);
	});

	test('a placeholder is one array parameter, its elements encoded when it is filled', () => {
		const query = where(inArray(things.tag, sql.placeholder('tags')));
		expect(query.sql).toBe('select "id" from "things" where "things"."tag" = any($1)');
		expect(fillPlaceholders(query.params, { tags: ['a', 'b'] })).toStrictEqual(['{"<a>","<b>"}']);
	});

	test('an array parameter is one array parameter, its elements encoded', () => {
		expect(where(inArray(things.tag, sql.param(['a']) as never))).toStrictEqual({
			sql: 'select "id" from "things" where "things"."tag" = any($1)',
			params: ['{"<a>"}'],
		});
	});

	test('a subquery and an SQL chunk keep in (...)', () => {
		expect(where(inArray(things.id, db.select({ id: things.id }).from(things))).sql).toBe(
			'select "id" from "things" where "things"."id" in (select "id" from "things")',
		);
		expect(where(inArray(things.id, sql`(select 1)`)).sql).toBe(
			'select "id" from "things" where "things"."id" in (select 1)',
		);
	});

	test('an array column keeps the in list', () => {
		expect(where(inArray(things.labels, [['a'], ['b']]))).toStrictEqual({
			sql: 'select "id" from "things" where "things"."labels" in ($1, $2)',
			params: [['a'], ['b']],
		});
	});

	test('an expression that is not a column keeps the in list', () => {
		expect(where(inArray(sql`lower(${things.name})`, ['a', 'b'])).sql).toBe(
			'select "id" from "things" where lower("things"."name") in ($1, $2)',
		);
	});
});

describe('inArray on another dialect', () => {
	test('a list on a SQLite column keeps the in list', () => {
		const sqlite = sqliteDrizzle.mock();
		const users = sqliteTable('users', { name: sqliteText() });
		expect(sqlite.select().from(users).where(inArray(users.name, ['a', 'b'])).toSQL()).toStrictEqual({
			sql: 'select "name" from "users" where "users"."name" in (?, ?)',
			params: ['a', 'b'],
		});
	});
});
