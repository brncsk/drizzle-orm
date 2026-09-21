import { sql } from 'drizzle-orm';
import { integer, pgGrant, pgMaterializedView, pgRole, pgSchema, pgTable, pgView } from 'drizzle-orm/pg-core';
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
const app = pgRole('app');
const roles = { roles: { include: ['app'] } };

test('grant on a table', async () => {
	const schema1 = { users, app };
	const schema2 = { users, app, grant: pgGrant({ on: users, to: app, privileges: ['select', 'insert'] }) };

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	await push({ db, to: schema1, entities: roles });
	const { sqlStatements: pst } = await push({ db, to: schema2, entities: roles });

	const st0 = [
		'GRANT SELECT ON "users" TO "app";',
		'GRANT INSERT ON "users" TO "app";',
	];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);

	// the database reports the grants back as declared: no grantor, since the owner granted them
	const { sqlStatements: again } = await push({ db, to: schema2, entities: roles });
	expect(again).toStrictEqual([]);
});

test('grant on a view and on a schema', async () => {
	const acl = pgSchema('acl');
	const view = pgView('v', { id: integer('id') }).as(sql`select id from users`);
	const schema1 = { users, acl, app, view };
	const schema2 = {
		users,
		acl,
		app,
		view,
		reads: pgGrant({ on: view, to: app, privileges: ['select'] }),
		uses: pgGrant({ on: acl, to: app, privileges: ['usage'] }),
	};

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	await push({ db, to: schema1, entities: roles });
	const { sqlStatements: pst } = await push({ db, to: schema2, entities: roles });

	const st0 = [
		'GRANT SELECT ON "v" TO "app";',
		'GRANT USAGE ON SCHEMA "acl" TO "app";',
	];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);

	const { sqlStatements: again } = await push({ db, to: schema2, entities: roles });
	expect(again).toStrictEqual([]);
});

test('a grant is issued after what it is granted on exists', async () => {
	const acl = pgSchema('acl');
	const view = acl.view('v', { id: integer('id') }).as(sql`select id from users`);
	const schema1 = { app };
	const schema2 = {
		app,
		acl,
		users,
		view,
		reads: pgGrant({ on: view, to: app, privileges: ['select'] }),
		uses: pgGrant({ on: acl, to: app, privileges: ['usage'] }),
		writes: pgGrant({ on: users, to: app, privileges: ['insert'] }),
	};

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	expect(st).toStrictEqual([
		'CREATE SCHEMA "acl";\n',
		'CREATE TABLE "users" (\n\t"id" integer PRIMARY KEY\n);\n',
		'CREATE VIEW "acl"."v" AS (select id from users);',
		'GRANT SELECT ON "acl"."v" TO "app";',
		'GRANT USAGE ON SCHEMA "acl" TO "app";',
		'GRANT INSERT ON "users" TO "app";',
	]);

	// and Postgres takes them in that order
	await push({ db, to: schema1, entities: roles });
	for (const s of st) await db.query(s);
});

test('a privilege the schema no longer declares is revoked', async () => {
	const schema1 = { users, app, grant: pgGrant({ on: users, to: app, privileges: ['select', 'insert'] }) };
	const schema2 = { users, app, grant: pgGrant({ on: users, to: app, privileges: ['select'] }) };

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	await push({ db, to: schema1, entities: roles });
	const { sqlStatements: pst } = await push({ db, to: schema2, entities: roles });

	const st0 = ['REVOKE INSERT ON "users" FROM "app";'];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);
});

test('with grant option', async () => {
	const schema1 = { users, app, grant: pgGrant({ on: users, to: app, privileges: ['select'] }) };
	const schema2 = { users, app, grant: pgGrant({ on: users, to: app, privileges: ['select'], withGrantOption: true }) };

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	await push({ db, to: schema1, entities: roles });
	const { sqlStatements: pst } = await push({ db, to: schema2, entities: roles });

	const st0 = [
		'REVOKE SELECT ON "users" FROM "app";',
		'GRANT SELECT ON "users" TO "app" WITH GRANT OPTION;',
	];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);
});

test('a grant to a role named as text, and to PUBLIC', async () => {
	const schema1 = { users };
	const schema2 = {
		users,
		everyone: pgGrant({ on: users, to: 'public', privileges: ['select'] }),
		named: pgGrant({ on: users, to: 'reporting', privileges: ['select'] }),
	};

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	expect(st).toStrictEqual([
		'GRANT SELECT ON "users" TO PUBLIC;',
		'GRANT SELECT ON "users" TO "reporting";',
	]);
});

test('push leaves the privileges of roles the schema does not manage alone', async () => {
	await db.query('CREATE ROLE "other"');
	const schema = { users, app, grant: pgGrant({ on: users, to: app, privileges: ['select'] }) };
	await push({ db, to: schema, entities: roles });
	await db.query('GRANT INSERT ON "users" TO "other"');

	const { sqlStatements: pst } = await push({ db, to: schema, entities: roles });
	expect(pst).toStrictEqual([]);
});

test('push manages the privileges of a role the schema names, whatever the roles filter says', async () => {
	// the role is not drizzle's, the grants to it are
	await db.query('CREATE ROLE "app"');
	const existing = pgRole('app').existing();
	const schema = { users, grant: pgGrant({ on: users, to: existing, privileges: ['select'] }) };

	const { sqlStatements: pst } = await push({ db, to: schema });
	expect(pst).toStrictEqual([
		'CREATE TABLE "users" (\n\t"id" integer PRIMARY KEY\n);\n',
		'GRANT SELECT ON "users" TO "app";',
	]);

	await db.query('GRANT INSERT ON "users" TO "app"');
	const { sqlStatements: revoked } = await push({ db, to: schema });
	expect(revoked).toStrictEqual(['REVOKE INSERT ON "users" FROM "app";']);
});

test('a recreated view is granted again', async () => {
	const schema1 = {
		users,
		app,
		view: pgView('v', { id: integer('id') }).as(sql`select id from users`),
		grant: pgGrant({
			on: pgView('v', { id: integer('id') }).as(sql`select id from users`),
			to: app,
			privileges: ['select'],
		}),
	};
	const view2 = pgView('v', { key: integer('key') }).as(sql`select id as key from users`);
	const schema2 = { users, app, view: view2, grant: pgGrant({ on: view2, to: app, privileges: ['select'] }) };

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	expect(st).toStrictEqual([
		'DROP VIEW "v";',
		'CREATE VIEW "v" AS (select id as key from users);',
		'GRANT SELECT ON "v" TO "app";',
	]);

	await push({ db, to: schema1, entities: roles });
	for (const s of st) await db.query(s);
	const { sqlStatements: pst } = await push({ db, to: schema2, entities: roles });
	expect(pst).toStrictEqual([]);
});

test('a replaced view keeps its grants', async () => {
	const view1 = pgView('v', { id: integer('id') }).as(sql`select id from users`);
	const view2 = pgView('v', { id: integer('id') }).as(sql`select id from users where id > 0`);
	const schema1 = { users, app, view: view1, grant: pgGrant({ on: view1, to: app, privileges: ['select'] }) };
	const schema2 = { users, app, view: view2, grant: pgGrant({ on: view2, to: app, privileges: ['select'] }) };

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	expect(st).toStrictEqual(['CREATE OR REPLACE VIEW "v" AS (select id from users where id > 0);']);

	await push({ db, to: schema1, entities: roles });
	for (const s of st) await db.query(s);
	const { sqlStatements: pst } = await push({ db, to: schema2, entities: roles });
	expect(pst).toStrictEqual([]);
});

test('a dropped table takes its grants with it', async () => {
	const schema1 = { users, app, grant: pgGrant({ on: users, to: app, privileges: ['select'] }) };
	const schema2 = { app };

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	expect(st).toStrictEqual(['DROP TABLE "users";']);
});

test('pull renders the grants', async () => {
	const acl = pgSchema('acl');
	const view = pgMaterializedView('v', { id: integer('id') }).as(sql`select id from users`);
	const schema = {
		users,
		acl,
		app,
		view,
		reads: pgGrant({ on: users, to: app, privileges: ['select', 'update'] }),
		views: pgGrant({ on: view, to: app, privileges: ['select'], withGrantOption: true }),
		uses: pgGrant({ on: acl, to: app, privileges: ['usage', 'create'] }),
	};

	const { pushSqlStatements, generateSqlStatements, ddlAfterPull } = await diffIntrospect(
		db,
		schema,
		'grants',
		['public', 'acl'],
		roles,
	);

	expect(ddlAfterPull.privileges.list().map((it) => it.name).sort()).toStrictEqual([
		'app:acl:CREATE',
		'app:acl:USAGE',
		'app:public.users:SELECT',
		'app:public.users:UPDATE',
		'app:public.v:SELECT',
	]);
	expect(pushSqlStatements).toStrictEqual([]);
	expect(generateSqlStatements).toStrictEqual([]);
});
