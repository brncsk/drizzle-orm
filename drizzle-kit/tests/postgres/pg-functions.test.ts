import { sql } from 'drizzle-orm';
import {
	index,
	integer,
	pgExtension,
	pgFunction,
	pgSchema,
	pgTable,
	pgTrigger,
	pgView,
	text,
} from 'drizzle-orm/pg-core';
import { ddlDiffDry } from 'src/dialects/postgres/diff';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { diff, diffIntrospect, drizzleToDDL, prepareTestDatabase, TestDatabase } from './mocks';

/*
	Functions, triggers and extensions as schema entities: what the diff
	writes for a declaration, in which order against the tables, the
	indexes and the views that call a function, whether Postgres accepts
	the result (every statement list is applied to PGlite as it is), and
	what a pull reads back: the same objects, in a file that pushes and
	generates nothing.
*/

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

const apply = async (statements: string[]) => {
	for (const st of statements) await db.query(st);
};

const users = pgTable('users', { id: integer('id').primaryKey(), name: text('name') });

const total = pgFunction('total', {
	args: { a: 'integer', b: 'integer' },
	returns: 'integer',
	language: 'sql',
	attributes: 'IMMUTABLE STRICT',
	body: 'SELECT $1 + $2',
	comment: 'The sum of two integers.',
});

test('a function is created with its comment, replaced in place when its body changes, and commented alone when only the comment changes', async () => {
	const { sqlStatements: created } = await diff({}, { total }, []);
	expect(created).toStrictEqual([
		'CREATE FUNCTION "public"."total"(a integer, b integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $fn$\nSELECT $1 + $2\n$fn$;',
		`COMMENT ON FUNCTION "public"."total"(integer, integer) IS 'The sum of two integers.';`,
	]);
	await apply(created);

	const doubled = pgFunction('total', { ...config(total), body: 'SELECT ($1 + $2) * 2' });
	const { sqlStatements: replaced } = await diff({ total }, { total: doubled }, []);
	expect(replaced).toStrictEqual([
		'CREATE OR REPLACE FUNCTION "public"."total"(a integer, b integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $fn$\nSELECT ($1 + $2) * 2\n$fn$;',
	]);
	await apply(replaced);

	const commented = pgFunction('total', { ...config(doubled), comment: 'Twice the sum.' });
	const { sqlStatements: recommented } = await diff({ total: doubled }, { total: commented }, []);
	expect(recommented).toStrictEqual([
		`COMMENT ON FUNCTION "public"."total"(integer, integer) IS 'Twice the sum.';`,
	]);
	await apply(recommented);

	const uncommented = pgFunction('total', { ...config(commented), comment: undefined });
	const { sqlStatements: cleared } = await diff({ total: commented }, { total: uncommented }, []);
	expect(cleared).toStrictEqual([
		'COMMENT ON FUNCTION "public"."total"(integer, integer) IS NULL;',
	]);
	await apply(cleared);

	const { sqlStatements: dropped } = await diff({ total: uncommented }, {}, []);
	expect(dropped).toStrictEqual(['DROP FUNCTION "public"."total"(integer, integer);']);
	await apply(dropped);
});

test('a signature change drops and creates the function, and the views and indexes that call it around it', async () => {
	const summary = pgView('summary', { n: integer('n') }).as(sql`select total(id, id) as n from users`);
	const byTotal = pgTable('users', { id: integer('id').primaryKey(), name: text('name') }, (t) => [
		index('users_by_total').on(sql`total(${t.id}, 1)`),
	]);
	const schema1 = { users: byTotal, total, summary };

	const { sqlStatements: created } = await diff({}, schema1, []);
	expect(created).toStrictEqual([
		'CREATE TABLE "users" (\n\t"id" integer PRIMARY KEY,\n\t"name" text\n);\n',
		'CREATE FUNCTION "public"."total"(a integer, b integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $fn$\nSELECT $1 + $2\n$fn$;',
		`COMMENT ON FUNCTION "public"."total"(integer, integer) IS 'The sum of two integers.';`,
		'CREATE INDEX "users_by_total" ON "users" (total("id", 1));',
		'CREATE VIEW "summary" AS (select total(id, id) as n from users);',
	]);
	await apply(created);

	const widened = pgFunction('total', { ...config(total), returns: 'bigint', body: 'SELECT ($1 + $2)::bigint' });
	const { sqlStatements: recreated } = await diff(schema1, { ...schema1, total: widened }, []);
	expect(recreated).toStrictEqual([
		'DROP VIEW "summary";',
		'DROP INDEX "users_by_total";',
		'DROP FUNCTION "public"."total"(integer, integer);',
		'CREATE FUNCTION "public"."total"(a integer, b integer) RETURNS bigint LANGUAGE sql IMMUTABLE STRICT AS $fn$\nSELECT ($1 + $2)::bigint\n$fn$;',
		`COMMENT ON FUNCTION "public"."total"(integer, integer) IS 'The sum of two integers.';`,
		'CREATE INDEX "users_by_total" ON "users" (total("id", 1));',
		'CREATE VIEW "summary" AS (select total(id, id) as n from users);',
	]);
	await apply(recreated);
});

test('a function in a schema is created after the schema, in declaration order, with a body drizzle renders', async () => {
	const acl = pgSchema('acl');
	const count = acl.function('count_users', {
		returns: 'bigint',
		language: 'sql',
		attributes: 'STABLE',
		body: sql`SELECT count(*) FROM ${users}`,
	});
	const twice = acl.function('twice_users', {
		returns: 'bigint',
		language: 'sql',
		body: sql`SELECT ${count}() * 2`,
	});

	const { sqlStatements: created } = await diff({}, { users, acl, twice, count }, []);
	expect(created).toStrictEqual([
		'CREATE SCHEMA "acl";\n',
		'CREATE TABLE "users" (\n\t"id" integer PRIMARY KEY,\n\t"name" text\n);\n',
		'CREATE FUNCTION "acl"."twice_users"() RETURNS bigint LANGUAGE sql AS $fn$\nSELECT "acl"."count_users"() * 2\n$fn$;',
		'CREATE FUNCTION "acl"."count_users"() RETURNS bigint LANGUAGE sql STABLE AS $fn$\nSELECT count(*) FROM "users"\n$fn$;',
	]);
	// the schema declares the caller first, and Postgres checks a SQL body at creation
	await expect(apply(created)).rejects.toThrow();
	await _.clear();

	const { sqlStatements: ordered } = await diff({}, { users, acl, count, twice }, []);
	await apply(ordered);
	expect(ordered.map((it) => it.split(' ').slice(0, 3).join(' '))).toStrictEqual([
		'CREATE SCHEMA "acl";\n',
		'CREATE TABLE "users"',
		'CREATE FUNCTION "acl"."count_users"()',
		'CREATE FUNCTION "acl"."twice_users"()',
	]);

	const { sqlStatements: dropped } = await diff({ users, acl, count, twice }, { users }, []);
	expect(dropped).toStrictEqual([
		'DROP FUNCTION "acl"."twice_users"();',
		'DROP FUNCTION "acl"."count_users"();',
		'DROP SCHEMA "acl";\n',
	]);
	await apply(dropped);
});

test('a dollar-quote tag the body contains is lengthened', async () => {
	const fn = pgFunction('tagged', { returns: 'text', language: 'sql', body: `SELECT '$fn$'` });
	const { sqlStatements } = await diff({}, { fn }, []);
	expect(sqlStatements).toStrictEqual([
		`CREATE FUNCTION "public"."tagged"() RETURNS text LANGUAGE sql AS $fn_$\nSELECT '$fn$'\n$fn_$;`,
	]);
	await apply(sqlStatements);
});

test('a trigger is created after its table and its function, replaced in place, dropped before its function, and recreated with it', async () => {
	const audit = pgFunction('audit', {
		returns: 'trigger',
		language: 'plpgsql',
		body: 'BEGIN NEW.name := upper(NEW.name); RETURN NEW; END',
	});
	const trigger = pgTrigger('users_audit', {
		on: users,
		when: 'BEFORE INSERT',
		function: audit,
		comment: 'Upper-cases the name.',
	});
	const schema1 = { users, audit, trigger };

	const { sqlStatements: created } = await diff({}, schema1, []);
	expect(created).toStrictEqual([
		'CREATE TABLE "users" (\n\t"id" integer PRIMARY KEY,\n\t"name" text\n);\n',
		'CREATE FUNCTION "public"."audit"() RETURNS trigger LANGUAGE plpgsql AS $fn$\nBEGIN NEW.name := upper(NEW.name); RETURN NEW; END\n$fn$;',
		'CREATE OR REPLACE TRIGGER "users_audit" BEFORE INSERT ON "users" FOR EACH ROW EXECUTE FUNCTION "public"."audit"();',
		`COMMENT ON TRIGGER "users_audit" ON "users" IS 'Upper-cases the name.';`,
	]);
	await apply(created);

	const onUpdateToo = pgTrigger('users_audit', {
		on: users,
		when: 'BEFORE INSERT OR UPDATE',
		function: audit,
		comment: 'Upper-cases the name.',
	});
	const { sqlStatements: replaced } = await diff(schema1, { ...schema1, trigger: onUpdateToo }, []);
	expect(replaced).toStrictEqual([
		'CREATE OR REPLACE TRIGGER "users_audit" BEFORE INSERT OR UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION "public"."audit"();',
	]);
	await apply(replaced);

	// a renamed function is a new function: the trigger that called the old one goes before it and comes back on the new one, with its comment
	const renamed = pgFunction('audit_row', config(audit));
	const repointed = pgTrigger('users_audit', { ...onUpdateToo, function: renamed });
	const { sqlStatements: recreated } = await diff({ ...schema1, trigger: onUpdateToo }, {
		users,
		audit: renamed,
		trigger: repointed,
	}, []);
	expect(recreated).toStrictEqual([
		'DROP TRIGGER "users_audit" ON "users";',
		'DROP FUNCTION "public"."audit"();',
		'CREATE FUNCTION "public"."audit_row"() RETURNS trigger LANGUAGE plpgsql AS $fn$\nBEGIN NEW.name := upper(NEW.name); RETURN NEW; END\n$fn$;',
		'CREATE OR REPLACE TRIGGER "users_audit" BEFORE INSERT OR UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION "public"."audit_row"();',
		`COMMENT ON TRIGGER "users_audit" ON "users" IS 'Upper-cases the name.';`,
	]);
	await apply(recreated);
	await _.clear();
	await apply(created);
	await apply(replaced);

	const { sqlStatements: dropped } = await diff({ ...schema1, trigger: onUpdateToo }, { users, audit }, []);
	expect(dropped).toStrictEqual(['DROP TRIGGER "users_audit" ON "users";']);
	await apply(dropped);

	// a trigger on a dropped table goes with the table
	const { sqlStatements: tableGone } = await diff({ ...schema1, trigger: onUpdateToo }, { audit }, []);
	expect(tableGone).toStrictEqual(['DROP TABLE "users";']);
});

test('a trigger condition is written as `WHEN`, replaced in place, and on a push only its presence is compared', async () => {
	const audit = pgFunction('audit', {
		returns: 'trigger',
		language: 'plpgsql',
		body: 'BEGIN RETURN NEW; END',
	});
	const trigger = (condition?: string) =>
		pgTrigger('users_audit', { on: users, when: 'AFTER UPDATE', condition, function: audit });
	const schema1 = { users, audit, trigger: trigger('OLD.name IS DISTINCT FROM NEW.name') };

	const { sqlStatements: created } = await diff({}, schema1, []);
	expect(created.at(-1)).toBe(
		'CREATE OR REPLACE TRIGGER "users_audit" AFTER UPDATE ON "users" FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name) EXECUTE FUNCTION "public"."audit"();',
	);
	await apply(created);

	const schema2 = { ...schema1, trigger: trigger('OLD.id <> NEW.id OR OLD.name <> NEW.name') };
	const { sqlStatements: replaced } = await diff(schema1, schema2, []);
	expect(replaced).toStrictEqual([
		'CREATE OR REPLACE TRIGGER "users_audit" AFTER UPDATE ON "users" FOR EACH ROW WHEN (OLD.id <> NEW.id OR OLD.name <> NEW.name) EXECUTE FUNCTION "public"."audit"();',
	]);
	await apply(replaced);

	const { sqlStatements: unconditional } = await diff(schema2, { ...schema1, trigger: trigger() }, []);
	expect(unconditional).toStrictEqual([
		'CREATE OR REPLACE TRIGGER "users_audit" AFTER UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION "public"."audit"();',
	]);
	await apply(unconditional);

	// Postgres prints the condition in its own spelling: a push takes it as the declared one, and sees one added or removed
	const { ddl: declared } = drizzleToDDL(schema1);
	const { ddl: printed } = drizzleToDDL({ ...schema1, trigger: trigger('(old.name IS DISTINCT FROM new.name)') });
	const { ddl: none } = drizzleToDDL({ ...schema1, trigger: trigger() });
	expect((await ddlDiffDry(printed, declared, 'push')).sqlStatements).toStrictEqual([]);
	expect((await ddlDiffDry(printed, declared, 'default')).sqlStatements).toHaveLength(1);
	expect((await ddlDiffDry(none, declared, 'push')).sqlStatements).toStrictEqual([created.at(-1)]);
	expect((await ddlDiffDry(printed, none, 'push')).sqlStatements).toStrictEqual(unconditional);
});

test('an extension is created first and dropped last', async () => {
	const plpgsql = pgExtension('plpgsql');
	const acl = pgSchema('acl');
	const { sqlStatements: created } = await diff({}, { acl, plpgsql, users }, []);
	expect(created).toStrictEqual([
		'CREATE SCHEMA "acl";\n',
		'CREATE EXTENSION IF NOT EXISTS "plpgsql";',
		'CREATE TABLE "users" (\n\t"id" integer PRIMARY KEY,\n\t"name" text\n);\n',
	]);
	await apply(created);

	const { sqlStatements: dropped } = await diff({ acl, plpgsql, users }, {}, []);
	expect(dropped).toStrictEqual([
		'DROP TABLE "users";',
		'DROP EXTENSION "plpgsql";',
		'DROP SCHEMA "acl";\n',
	]);

	const { sqlStatements: options } = await diff({}, {
		search: pgExtension('pg_search', { cascade: true }),
		postgis: pgExtension('postgis', { schema: 'gis', version: '3.4.0' }),
	}, []);
	expect(options).toStrictEqual([
		'CREATE EXTENSION IF NOT EXISTS "pg_search" CASCADE;',
		`CREATE EXTENSION IF NOT EXISTS "postgis" SCHEMA "gis" VERSION '3.4.0';`,
	]);
});

test('a pull reads the functions, the triggers and the extensions back, and the pulled file changes nothing', async () => {
	const acl = pgSchema('acl');
	const audit = pgFunction('audit_users', {
		returns: 'trigger',
		language: 'plpgsql',
		body: 'BEGIN RETURN NEW; END',
		comment: 'Leaves the row as it is.',
	});
	const schema = {
		acl,
		users,
		total,
		// spelled the way a declaration is: the pull normalizes the type, the attributes and the events
		count: acl.function('count_users', {
			args: { lowest: 'int' },
			returns: 'TABLE (n bigint, lowest integer)',
			language: 'sql',
			attributes: 'STABLE SECURITY DEFINER SET search_path = pg_catalog, public',
			body: 'SELECT count(*), $1 FROM users',
		}),
		audit,
		trigger: pgTrigger('users_audit', {
			on: users,
			when: 'AFTER INSERT OR UPDATE OR DELETE',
			function: audit,
			comment: 'Audits every write.',
		}),
		renamed: pgTrigger('users_renamed', {
			on: users,
			when: 'AFTER UPDATE',
			condition: 'OLD.name IS DISTINCT FROM NEW.name',
			function: audit,
		}),
		citext: pgExtension('citext'),
	};
	const { pushSqlStatements, generateSqlStatements, ddlAfterPull } = await diffIntrospect(
		db,
		schema,
		'functions-pull',
		['public', 'acl'],
	);
	expect(pushSqlStatements).toStrictEqual([]);
	expect(generateSqlStatements).toStrictEqual([]);
	// the extensions' own functions are not read: only the schema's, in creation order
	expect(ddlAfterPull.functions.list().map((it) => `${it.schema}.${it.name}`)).toStrictEqual([
		'public.total',
		'acl.count_users',
		'public.audit_users',
	]);
	const count = ddlAfterPull.functions.one({ schema: 'acl', name: 'count_users' })!;
	expect(count.args).toStrictEqual([{ name: 'lowest', type: 'integer' }]);
	expect(count.returns).toBe('TABLE(n bigint, lowest integer)');
	expect(count.attributes).toBe('STABLE SECURITY DEFINER SET search_path = pg_catalog, public');
	expect(ddlAfterPull.functions.one({ schema: 'public', name: 'total' })).toMatchObject({
		attributes: 'IMMUTABLE STRICT',
		body: 'SELECT $1 + $2',
		comment: 'The sum of two integers.',
	});
	expect(ddlAfterPull.triggers.list()).toStrictEqual([{
		entityType: 'triggers',
		schema: 'public',
		table: 'users',
		name: 'users_audit',
		when: 'AFTER INSERT OR UPDATE OR DELETE',
		level: 'ROW',
		condition: null,
		function: 'public.audit_users',
		comment: 'Audits every write.',
	}, {
		entityType: 'triggers',
		schema: 'public',
		table: 'users',
		name: 'users_renamed',
		when: 'AFTER UPDATE',
		level: 'ROW',
		// as Postgres prints it
		condition: '(old.name IS DISTINCT FROM new.name)',
		function: 'public.audit_users',
		comment: null,
	}]);
	// the extensions the database holds, the two the test database comes with among them, without a pinned version in the file
	expect(ddlAfterPull.extensions.list().map((it) => it.name)).toStrictEqual(['citext', 'pg_trgm', 'vector']);
});

test('a push leaves an extension the schema does not declare; a declared version is what is compared', async () => {
	const { ddl: withVector } = drizzleToDDL({ vector: pgExtension('vector', { version: '0.8.0' }) });
	const { ddl: without } = drizzleToDDL({});
	const { ddl: unpinned } = drizzleToDDL({ vector: pgExtension('vector') });
	const { ddl: other } = drizzleToDDL({ vector: pgExtension('vector', { version: '0.7.0' }) });
	expect((await ddlDiffDry(withVector, without, 'push')).sqlStatements).toStrictEqual([]);
	expect((await ddlDiffDry(withVector, without, 'default')).sqlStatements).toStrictEqual(['DROP EXTENSION "vector";']);
	expect((await ddlDiffDry(withVector, unpinned, 'push')).sqlStatements).toStrictEqual([]);
	expect((await ddlDiffDry(withVector, other, 'push')).sqlStatements).toStrictEqual([
		`ALTER EXTENSION "vector" UPDATE TO '0.7.0';`,
	]);
	// the schema is compared the same way: stated, it is set; left out, the installed one stands
	const { ddl: installed } = drizzleToDDL({ vector: pgExtension('vector', { schema: 'public', version: '0.8.0' }) });
	const { ddl: moved } = drizzleToDDL({ vector: pgExtension('vector', { schema: 'ext' }) });
	expect((await ddlDiffDry(installed, unpinned, 'push')).sqlStatements).toStrictEqual([]);
	expect((await ddlDiffDry(installed, moved, 'push')).sqlStatements).toStrictEqual([
		'ALTER EXTENSION "vector" SET SCHEMA "ext";',
	]);
});

test('a second declaration of a function name is a duplicate', async () => {
	await expect(diff({}, { a: total, b: pgFunction('total', config(total)) }, [])).rejects.toThrow();
});

/** A function's config, to declare it again with a change. */
const config = (fn: ReturnType<typeof pgFunction>) => ({
	args: Object.fromEntries(fn.args.map((a) => [a.name, a.type])),
	returns: fn.returns,
	language: fn.language,
	body: fn.body,
	attributes: fn.attributes,
	comment: fn.comment,
});
