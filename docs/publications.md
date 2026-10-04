# Publications and replica identities

Logical replication sends the changes of the tables a publication names, and
an update or a delete carries as much of the old row as the table's replica
identity says. A schema that a replication slot or a subscriber reads needs
both. They are declared in the schema file and kept in step by `generate`,
`push` and `pull`.

```ts
import { integer, pgPublication, pgSchema, pgTable, replicaIdentity, text, uniqueIndex } from 'drizzle-orm/pg-core';

export const registry = pgSchema('registry');

export const objects = pgTable('objects', {
	id: integer().notNull(),
	type: text().notNull(),
	body: text(),
}, (t) => [
	uniqueIndex('objects_id_type').on(t.id, t.type),
	replicaIdentity({ index: 'objects_id_type' }),
]);

export const grants = pgTable('grants', { id: integer().primaryKey(), role: text() }, () => [
	replicaIdentity('full'),
]);

export const changes = pgPublication('changes', {
	tables: [{ table: objects, columns: [objects.id, objects.type] }, grants],
	publish: ['insert', 'update', 'delete', 'truncate'],
});
```

## Publications

`pgPublication(name, config)` declares one publication. Export it from a
schema file. The config takes:

- `tables`: the tables the publication sends (`FOR TABLE`). A bare table
  sends every column. `{ table, columns }` sends only the columns listed, in
  the new row and in the old row. A column must belong to its table.
- `schemas`: the schemas whose every table it sends, also the tables created
  later (`FOR TABLES IN SCHEMA`). A declared `pgSchema`, or a name
  (`'public'`). Postgres refuses a column list in a publication that names a
  schema, so the declaration refuses it too.
- `allTables`: every table of the database (`FOR ALL TABLES`). It takes no
  `tables` and no `schemas`.
- `publish`: the changes it sends. All four (`insert`, `update`, `delete`,
  `truncate`) when not given.
- `publishViaPartitionRoot`: send a change to a partition as a change to its
  partitioned table.

Row filters (`WHERE (...)` per table) are not supported. `pull` does not read
them, and a publication that has one compares as one without.

### What `generate` writes

- A new publication: `CREATE PUBLICATION`, with its tables and schemas, after
  the tables and the columns it names exist. An option is written only when
  it is not the default.
- A table or a schema added to an existing publication:
  `ALTER PUBLICATION ... ADD TABLE` or `ADD TABLES IN SCHEMA`. One removed:
  `DROP TABLE` or `DROP TABLES IN SCHEMA`.
- A changed column list: the table is dropped from the publication and added
  again. Postgres cannot change the column list of one table alone.
- A changed `publish` or `publishViaPartitionRoot`:
  `ALTER PUBLICATION ... SET (...)`.
- A change between `allTables` and a list: the publication is dropped and
  created again, since `ALTER PUBLICATION` cannot make that change.
- A renamed publication is a drop and a create. drizzle-kit does not ask
  whether a publication was renamed.

Postgres refuses to drop a column that a column list names. The publication
lets go of the table before the column is dropped, and takes it back with the
new list after. A table or a schema that is dropped leaves its publications by
itself, so no `ALTER PUBLICATION` is written for it. A renamed table or column
stays in its publications.

### `push` and `pull`

`push` manages only the publications the schema declares. It never drops or
changes a publication the schema does not name, because a database can have
publications that belong to someone else (a hosted Postgres often has its
own). A publication that the schema stops declaring is dropped by `generate`,
but `push` leaves it in the database.

`pull` reads every publication and renders it as a `pgPublication`. A table
that the generated file does not declare cannot go into `tables`. It is left
out, and a comment above the declaration names it.

Column lists and schemas in a publication came with Postgres 15. On an older
server, `pull` and `push` read every publication as one that sends every
column, and with no schemas.

## Replica identities

`replicaIdentity(...)` in a table's extra config declares what an update or a
delete on the table carries of the old row:

- `'default'`, which is what a table has when it declares nothing: the
  primary key.
- `'full'`: the whole old row.
- `'nothing'`: no old row. Postgres then refuses an update or a delete on the
  table while a publication sends them.
- `{ index: name }`: the columns of a unique index of the table. Name the
  index as the same extra config names it, or name a unique constraint. Its
  columns must be `NOT NULL`, and the index must not be partial or
  deferrable. An index that the table does not have is a schema error.

`generate` writes `ALTER TABLE ... REPLICA IDENTITY ...` when the identity
changes, and for a new table that declares one, after the index it names is
created. Postgres lets an index that is a replica identity be dropped, and
the table then has no identity, so the identity is set again when its index
is dropped and created in the same migration. A renamed index stays the
identity.

`pull` reads the identity from `pg_class.relreplident` and renders
`replicaIdentity(...)` for a table that does not use the default. An index
identity whose index was dropped behaves as `'nothing'` and is read as
`'nothing'`.

### Why a column list needs an identity

Postgres refuses an update or a delete on a published table whose column list
does not contain the replica identity's columns. In the example, `objects` is
published with `(id, type)` and its identity is the unique index on
`(id, type)`, so a delete sends the key and the type of the deleted row and
nothing else.

## Snapshots

A table with the default identity has no entry in the snapshot. A snapshot
written before replica identities and publications were known reads as one in
which every table uses the default and there are no publications. The
snapshot version does not change, and no `drizzle-kit up` is needed.
