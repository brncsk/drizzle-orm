import {
	integer,
	pgPublication,
	pgSchema,
	pgTable,
	replicaIdentity,
	text,
	unique,
	uniqueIndex,
} from 'drizzle-orm/pg-core';
import { generateLatestSnapshot } from 'src/dialects/postgres/serializer';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { diff, diffIntrospect, drizzleToDDL, PostgresSchema, prepareTestDatabase, push, TestDatabase } from './mocks';

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

const users = pgTable('users', { id: integer().primaryKey(), name: text(), email: text() });
const posts = pgTable('posts', { id: integer().primaryKey(), authorId: integer('author_id'), body: text() });

test('a publication with tables, a column list and options', async () => {
	const schema1 = { users, posts };
	const schema2 = {
		users,
		posts,
		changes: pgPublication('changes', {
			tables: [users, { table: posts, columns: [posts.id, posts.authorId] }],
			publish: ['insert', 'update', 'delete'],
		}),
	};

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	await push({ db, to: schema1 });
	const { sqlStatements: pst } = await push({ db, to: schema2 });

	const st0 = [
		`CREATE PUBLICATION "changes" FOR TABLE "users", "posts" ("id", "author_id") WITH (publish = 'insert, update, delete');`,
	];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);

	const { sqlStatements: again } = await push({ db, to: schema2 });
	expect(again).toStrictEqual([]);
});

test('a column list is compared in the order of the table, as Postgres stores it', async () => {
	const schema = {
		posts,
		changes: pgPublication('changes', { tables: [{ table: posts, columns: [posts.body, posts.id] }] }),
	};

	await push({ db, to: { posts } });
	const { sqlStatements: st } = await push({ db, to: schema });
	expect(st).toStrictEqual(['CREATE PUBLICATION "changes" FOR TABLE "posts" ("id", "body");']);

	const { sqlStatements: again } = await push({ db, to: schema });
	expect(again).toStrictEqual([]);
});

test('a table is added and dropped, and a changed column list is dropped and added again', async () => {
	const schema1 = {
		users,
		posts,
		changes: pgPublication('changes', { tables: [users, { table: posts, columns: [posts.id] }] }),
	};
	const schema2 = {
		users,
		posts,
		changes: pgPublication('changes', { tables: [{ table: posts, columns: [posts.id, posts.authorId] }] }),
	};

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	await push({ db, to: schema1 });
	const { sqlStatements: pst } = await push({ db, to: schema2 });

	const st0 = [
		'ALTER PUBLICATION "changes" DROP TABLE "users";',
		'ALTER PUBLICATION "changes" DROP TABLE "posts";',
		'ALTER PUBLICATION "changes" ADD TABLE "posts" ("id", "author_id");',
	];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);

	const { sqlStatements: again } = await push({ db, to: schema2 });
	expect(again).toStrictEqual([]);
});

test('a publication lets go of a column before the column is dropped', async () => {
	const posts1 = pgTable('posts', { id: integer().primaryKey(), authorId: integer('author_id'), body: text() });
	const posts2 = pgTable('posts', { id: integer().primaryKey(), body: text() });
	const schema1 = {
		posts: posts1,
		changes: pgPublication('changes', { tables: [{ table: posts1, columns: [posts1.id, posts1.authorId] }] }),
	};
	const schema2 = {
		posts: posts2,
		changes: pgPublication('changes', { tables: [{ table: posts2, columns: [posts2.id] }] }),
	};

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	await push({ db, to: schema1 });
	const { sqlStatements: pst } = await push({ db, to: schema2 });

	const st0 = [
		'ALTER PUBLICATION "changes" DROP TABLE "posts";',
		'ALTER TABLE "posts" DROP COLUMN "author_id";',
		'ALTER PUBLICATION "changes" ADD TABLE "posts" ("id");',
	];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);
});

test('a renamed column stays in the column list', async () => {
	const posts1 = pgTable('posts', { id: integer().primaryKey(), authorId: integer('author_id') });
	const posts2 = pgTable('posts', { id: integer().primaryKey(), writerId: integer('writer_id') });
	const schema1 = {
		posts: posts1,
		changes: pgPublication('changes', { tables: [{ table: posts1, columns: [posts1.id, posts1.authorId] }] }),
	};
	const schema2 = {
		posts: posts2,
		changes: pgPublication('changes', { tables: [{ table: posts2, columns: [posts2.id, posts2.writerId] }] }),
	};

	const renames = ['public.posts.author_id->public.posts.writer_id'];
	const { sqlStatements: st } = await diff(schema1, schema2, renames);
	await push({ db, to: schema1 });
	const { sqlStatements: pst } = await push({ db, to: schema2, renames });

	const st0 = ['ALTER TABLE "posts" RENAME COLUMN "author_id" TO "writer_id";'];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);
});

test('a renamed table stays in its publications and keeps its replica identity', async () => {
	const users1 = pgTable('users', { id: integer().primaryKey() }, () => [replicaIdentity('full')]);
	const users2 = pgTable('members', { id: integer().primaryKey() }, () => [replicaIdentity('full')]);
	const schema1 = { users: users1, changes: pgPublication('changes', { tables: [users1] }) };
	const schema2 = { users: users2, changes: pgPublication('changes', { tables: [users2] }) };

	const renames = ['public.users->public.members'];
	const { sqlStatements: st } = await diff(schema1, schema2, renames);
	await push({ db, to: schema1 });
	const { sqlStatements: pst } = await push({ db, to: schema2, renames });

	const st0 = ['ALTER TABLE "users" RENAME TO "members";'];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);
});

test('options change in place; a change between all tables and a list recreates the publication', async () => {
	const schema1 = { users, changes: pgPublication('changes', { tables: [users] }) };
	const schema2 = {
		users,
		changes: pgPublication('changes', { tables: [users], publish: ['insert'], publishViaPartitionRoot: true }),
	};
	const schema3 = { users, changes: pgPublication('changes', { allTables: true, publish: ['insert'] }) };

	const { sqlStatements: st1 } = await diff(schema1, schema2, []);
	expect(st1).toStrictEqual([
		`ALTER PUBLICATION "changes" SET (publish = 'insert', publish_via_partition_root = true);`,
	]);

	const { sqlStatements: st2 } = await diff(schema2, schema3, []);
	expect(st2).toStrictEqual([
		'DROP PUBLICATION "changes";',
		`CREATE PUBLICATION "changes" FOR ALL TABLES WITH (publish = 'insert');`,
	]);

	await push({ db, to: schema1 });
	const { sqlStatements: pst1 } = await push({ db, to: schema2 });
	expect(pst1).toStrictEqual(st1);
	const { sqlStatements: again } = await push({ db, to: schema2 });
	expect(again).toStrictEqual([]);
});

test('a publication of a schema', async () => {
	const audit = pgSchema('audit');
	const log = audit.table('log', { id: integer().primaryKey() });
	const schema1 = { audit, log, users, changes: pgPublication('changes', { tables: [users] }) };
	const schema2 = { audit, log, users, changes: pgPublication('changes', { tables: [users], schemas: [audit] }) };

	const { sqlStatements: st } = await diff(schema1, schema2, []);
	await push({ db, to: schema1 });
	const { sqlStatements: pst } = await push({ db, to: schema2 });

	const st0 = ['ALTER PUBLICATION "changes" ADD TABLES IN SCHEMA "audit";'];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);

	const { sqlStatements: create } = await diff({ audit, log, users }, schema2, []);
	expect(create).toStrictEqual(['CREATE PUBLICATION "changes" FOR TABLE "users", TABLES IN SCHEMA "audit";']);
});

test('a dropped table leaves its publications, and a dropped publication takes its tables', async () => {
	const schema1 = { users, posts, changes: pgPublication('changes', { tables: [users, posts] }) };
	const schema2 = { users, changes: pgPublication('changes', { tables: [users] }) };
	const schema3 = { users };

	const { sqlStatements: st1 } = await diff(schema1, schema2, []);
	expect(st1).toStrictEqual(['DROP TABLE "posts";']);

	const { sqlStatements: st2 } = await diff(schema2, schema3, []);
	expect(st2).toStrictEqual(['DROP PUBLICATION "changes";']);
});

test('push leaves a publication the schema does not declare alone', async () => {
	await push({ db, to: { users } });
	await db.query('CREATE PUBLICATION "theirs" FOR TABLE "users";');

	const { sqlStatements: st } = await push({ db, to: { users } });
	expect(st).toStrictEqual([]);
});

test('a replica identity: full, a unique index, and back to the default', async () => {
	const t1 = pgTable('objects', { id: integer().notNull(), type: text().notNull() });
	const t2 = pgTable('objects', { id: integer().notNull(), type: text().notNull() }, (t) => [
		uniqueIndex('objects_id_type').on(t.id, t.type),
		replicaIdentity({ index: 'objects_id_type' }),
	]);
	const t3 = pgTable('objects', { id: integer().notNull(), type: text().notNull() }, () => [
		replicaIdentity('full'),
	]);

	await push({ db, to: { t1 } });

	const { sqlStatements: st2 } = await diff({ t1 }, { t2 }, []);
	const { sqlStatements: pst2 } = await push({ db, to: { t2 } });
	const st20 = [
		'CREATE UNIQUE INDEX "objects_id_type" ON "objects" ("id","type");',
		'ALTER TABLE "objects" REPLICA IDENTITY USING INDEX "objects_id_type";',
	];
	expect(st2).toStrictEqual(st20);
	expect(pst2).toStrictEqual(st20);
	expect(await push({ db, to: { t2 } }).then((it) => it.sqlStatements)).toStrictEqual([]);

	const { sqlStatements: st3 } = await diff({ t2 }, { t3 }, []);
	const { sqlStatements: pst3 } = await push({ db, to: { t3 } });
	const st30 = ['DROP INDEX "objects_id_type";', 'ALTER TABLE "objects" REPLICA IDENTITY FULL;'];
	expect(st3).toStrictEqual(st30);
	expect(pst3).toStrictEqual(st30);

	const { sqlStatements: st4 } = await diff({ t3 }, { t1 }, []);
	const { sqlStatements: pst4 } = await push({ db, to: { t1 } });
	const st40 = ['ALTER TABLE "objects" REPLICA IDENTITY DEFAULT;'];
	expect(st4).toStrictEqual(st40);
	expect(pst4).toStrictEqual(st40);
});

test('a new table sets its replica identity after its index exists', async () => {
	const t = pgTable('objects', { id: integer().notNull(), type: text().notNull() }, (t) => [
		unique('objects_id_type').on(t.id, t.type),
		replicaIdentity({ index: 'objects_id_type' }),
	]);

	const { sqlStatements: st } = await diff({}, { t }, []);
	const { sqlStatements: pst } = await push({ db, to: { t } });

	const st0 = [
		'CREATE TABLE "objects" (\n\t"id" integer NOT NULL,\n\t"type" text NOT NULL,\n\tCONSTRAINT "objects_id_type" UNIQUE("id","type")\n);\n',
		'ALTER TABLE "objects" REPLICA IDENTITY USING INDEX "objects_id_type";',
	];
	expect(st).toStrictEqual(st0);
	expect(pst).toStrictEqual(st0);
	expect(await push({ db, to: { t } }).then((it) => it.sqlStatements)).toStrictEqual([]);
});

test('a recreated identity index is the replica identity again', async () => {
	const t1 = pgTable('objects', { id: integer().notNull(), type: text().notNull() }, (t) => [
		uniqueIndex('objects_key').on(t.id),
		replicaIdentity({ index: 'objects_key' }),
	]);
	const t2 = pgTable('objects', { id: integer().notNull(), type: text().notNull() }, (t) => [
		uniqueIndex('objects_key').on(t.id, t.type),
		replicaIdentity({ index: 'objects_key' }),
	]);

	const { sqlStatements: st } = await diff({ t1 }, { t2 }, []);
	expect(st).toStrictEqual([
		'DROP INDEX "objects_key";',
		'CREATE UNIQUE INDEX "objects_key" ON "objects" ("id","type");',
		'ALTER TABLE "objects" REPLICA IDENTITY USING INDEX "objects_key";',
	]);
});

test('a replica identity must name a unique index of its table', async () => {
	const t = pgTable('objects', { id: integer().notNull() }, () => [replicaIdentity({ index: 'nope' })]);

	await expect(diff({}, { t }, [])).rejects.toThrowError();
});

test('pull renders the publications and the replica identities', async () => {
	const audit = pgSchema('audit');
	const log = audit.table('log', { id: integer().primaryKey() }, () => [replicaIdentity('full')]);
	const objects = pgTable('objects', { id: integer().notNull(), type: text().notNull() }, (t) => [
		uniqueIndex('objects_id_type').on(t.id, t.type),
		replicaIdentity({ index: 'objects_id_type' }),
	]);
	const schema = {
		audit,
		log,
		users,
		objects,
		changes: pgPublication('changes', {
			tables: [users, { table: objects, columns: [objects.id, objects.type] }],
			publish: ['insert', 'update', 'delete'],
		}),
		everything: pgPublication('everything', { schemas: [audit] }),
	};

	const { pushSqlStatements, generateSqlStatements, ddlAfterPull } = await diffIntrospect(
		db,
		schema,
		'publications',
		['public', 'audit'],
	);

	expect(ddlAfterPull.publications.list().map((it) => it.name)).toStrictEqual(['changes', 'everything']);
	expect(ddlAfterPull.publicationTables.list().map((it) => `${it.name}:${it.table}:${it.columns.join(',')}`))
		.toStrictEqual(['changes:objects:id,type', 'changes:users:']);
	expect(ddlAfterPull.replicaIdentities.list().map((it) => `${it.name}:${it.identity}:${it.index}`).sort())
		.toStrictEqual(['log:full:null', 'objects:index:objects_id_type']);
	expect(pushSqlStatements).toStrictEqual([]);
	expect(generateSqlStatements).toStrictEqual([]);
});

/** The snapshot `from` becomes when the statements of the diff to `to` are replayed on it, against the snapshot of `to`. */
const replay = async (from: PostgresSchema, to: PostgresSchema, renames: string[] = []) => {
	const { statements } = await diff(from, to, renames);
	const base = {
		version: '9' as const,
		dialect: 'postgres' as const,
		id: 'snapshot-id',
		prevIds: [],
		ddl: drizzleToDDL(from).ddl.entities.list(),
		renames: [],
	};
	const entries = (ddl: object[]) => ddl.map((it) => JSON.stringify(it, Object.keys(it).sort())).sort();
	return {
		replayed: entries(generateLatestSnapshot(base, statements).ddl),
		expected: entries(drizzleToDDL(to).ddl.entities.list()),
	};
};

test('the snapshot replay follows publications and replica identities', async () => {
	const objects1 = pgTable('objects', { id: integer().notNull(), type: text().notNull(), body: text() });
	const objects2 = pgTable('things', { id: integer().notNull(), type: text().notNull() }, (t) => [
		uniqueIndex('things_id_type').on(t.id, t.type),
		replicaIdentity({ index: 'things_id_type' }),
	]);
	const audit = pgSchema('audit');
	const schema1 = {
		audit,
		users,
		objects: objects1,
		changes: pgPublication('changes', { tables: [users, { table: objects1, columns: [objects1.id, objects1.body] }] }),
		gone: pgPublication('gone', { allTables: true }),
	};
	const schema2 = {
		audit,
		users,
		objects: objects2,
		changes: pgPublication('changes', {
			tables: [{ table: objects2, columns: [objects2.id, objects2.type] }],
			publish: ['insert'],
		}),
		audited: pgPublication('audited', { tables: [users], schemas: [audit] }),
	};

	const { replayed, expected } = await replay(schema1, schema2, ['public.objects->public.things']);
	expect(replayed).toStrictEqual(expected);

	const back = await replay(schema2, schema1, ['public.things->public.objects']);
	expect(back.replayed).toStrictEqual(back.expected);
});
