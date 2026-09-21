import { sql } from 'drizzle-orm';
import { integer, pgMaterializedView, pgSchema, pgTable, pgView } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { diff, diffIntrospect, prepareTestDatabase, push, TestDatabase } from './mocks';

// @vitest-environment-options {"max-concurrency":1}
let _: TestDatabase;
let db: TestDatabase['db'];

beforeAll(async () => {
	_ = await prepareTestDatabase();
	db = _.db;
});

afterAll(async () => {
	await _.close();
});

beforeEach(async () => {
	await _.clear();
});

const users = pgTable('users', { id: integer('id').primaryKey() });

test('create view with comment', async () => {
	const schema1 = { users };
	const schema2 = {
		users,
		view: pgView('v', { id: integer('id') }).comment("Every user's id").as(sql`select id from users`),
	};

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	await push({ db, to: schema1 });
	const { sqlStatements: pst } = await push({ db, to: schema2 });

	const st0 = [
		'CREATE VIEW "v" AS (select id from users);',
		`COMMENT ON VIEW "v" IS 'Every user''s id';`,
	];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);

	// and the database reports it back
	const { sqlStatements: again } = await push({ db, to: schema2 });
	expect(again).toStrictEqual([]);
});

test('create materialized view with comment', async () => {
	const schema1 = { users };
	const schema2 = {
		users,
		view: pgMaterializedView('v', { id: integer('id') }).comment('ids').as(sql`select id from users`),
	};

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	await push({ db, to: schema1 });
	const { sqlStatements: pst } = await push({ db, to: schema2 });

	const st0 = [
		'CREATE MATERIALIZED VIEW "v" AS (select id from users);',
		`COMMENT ON MATERIALIZED VIEW "v" IS 'ids';`,
	];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);
});

test('create view with comment in a schema', async () => {
	const acl = pgSchema('acl');
	const schema1 = { acl, users };
	const schema2 = {
		acl,
		users,
		view: acl.view('v', { id: integer('id') }).comment('ids').as(sql`select id from users`),
	};

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	expect(st).toStrictEqual([
		'CREATE VIEW "acl"."v" AS (select id from users);',
		`COMMENT ON VIEW "acl"."v" IS 'ids';`,
	]);
});

test('a changed comment alone changes nothing else', async () => {
	const schema1 = {
		users,
		view: pgView('v', { id: integer('id') }).comment('ids').as(sql`select id from users`),
	};
	const schema2 = {
		users,
		view: pgView('v', { id: integer('id') }).comment('the ids').as(sql`select id from users`),
	};

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	await push({ db, to: schema1 });
	const { sqlStatements: pst } = await push({ db, to: schema2 });

	const st0 = [`COMMENT ON VIEW "v" IS 'the ids';`];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);
});

test('a removed comment is set to null', async () => {
	const schema1 = {
		users,
		view: pgView('v', { id: integer('id') }).comment('ids').as(sql`select id from users`),
	};
	const schema2 = {
		users,
		view: pgView('v', { id: integer('id') }).as(sql`select id from users`),
	};

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	await push({ db, to: schema1 });
	const { sqlStatements: pst } = await push({ db, to: schema2 });

	const st0 = [`COMMENT ON VIEW "v" IS NULL;`];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);
});

test('a replaced view writes its comment only when it changed', async () => {
	const same1 = { users, view: pgView('v', { id: integer('id') }).comment('ids').as(sql`select id from users`) };
	const same2 = {
		users,
		view: pgView('v', { id: integer('id') }).comment('ids').as(sql`select id from users where id > 0`),
	};
	const { sqlStatements: st1 } = await diff(same1, same2, []);
	expect(st1).toStrictEqual(['CREATE OR REPLACE VIEW "v" AS (select id from users where id > 0);']);

	const changed = {
		users,
		view: pgView('v', { id: integer('id') }).comment('some ids').as(sql`select id from users where id > 0`),
	};
	const { sqlStatements: st2 } = await diff(same1, changed, []);
	expect(st2).toStrictEqual([
		'CREATE OR REPLACE VIEW "v" AS (select id from users where id > 0);',
		`COMMENT ON VIEW "v" IS 'some ids';`,
	]);
});

test('a recreated view writes its comment again', async () => {
	const schema1 = { users, view: pgView('v', { id: integer('id') }).comment('ids').as(sql`select id from users`) };
	const schema2 = {
		users,
		view: pgView('v', { key: integer('key') }).comment('ids').as(sql`select id as key from users`),
	};

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	expect(st).toStrictEqual([
		'DROP VIEW "v";',
		'CREATE VIEW "v" AS (select id as key from users);',
		`COMMENT ON VIEW "v" IS 'ids';`,
	]);
});

test('pull renders the comment', async () => {
	const schema = {
		users,
		view: pgView('v', { id: integer('id') }).comment("Every user's id").as(sql`select id from users`),
	};

	const { pushSqlStatements, generateSqlStatements, ddlAfterPull } = await diffIntrospect(db, schema, 'view-comment');

	expect(ddlAfterPull.views.one({ name: 'v' })?.comment).toBe("Every user's id");
	expect(pushSqlStatements).toStrictEqual([]);
	expect(generateSqlStatements).toStrictEqual([]);
});
