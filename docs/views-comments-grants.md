# Views replaced in place, view comments and grants

Three things a PostgreSQL schema needs that a schema file could not say: a view
whose definition changes without the views that select from it, and its
privileges, going down with it; the comment a view carries; and what a role may
do with a table, a view or a schema. All three are declared in the schema file
and kept in step by `generate`, `push` and `pull`.

```ts
import { integer, pgGrant, pgRole, pgSchema, pgTable, pgView, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const acl = pgSchema('acl');
export const app = pgRole('app');

export const users = pgTable('users', { id: integer().primaryKey(), name: text() });

export const visibleUsers = pgView('visible_users', { id: integer(), name: text() })
	.comment('Every user the caller may see.')
	.as(sql`select id, name from users where acl.visible(id)`);

export const appReadsUsers = pgGrant({ on: visibleUsers, to: app, privileges: ['select'] });
export const appUsesAcl = pgGrant({ on: acl, to: app, privileges: ['usage'] });
```

## A changed view definition

PostgreSQL replaces a view in place (`CREATE OR REPLACE VIEW`) when the new
query keeps every existing column in its place, with its name and type, and
adds columns at the end only. drizzle-kit records, per view, the columns the
declaration produces, and applies a changed definition in place when the old
column list is a prefix of the new one. The views that select from the view,
and the privileges on it, stay as they are.

The columns are known for a view declared with a column list
(`pgView(name, columns).as(sql`...`)`) and for a query that selects columns
only. A selection with an expression in it, or a snapshot written before the
columns were recorded, gives no columns, and a view whose columns are not
known is never replaced in place.

Otherwise the view is dropped and created again, and so is every view that
selects from it: dependents are dropped first, in the reverse of the order they
are created in. A materialized view has no replace form and is always
recreated. A recreated view is granted its privileges again, since
`DROP VIEW` took them with it.

`push` compares no definitions, so it compares no columns either.

## Comments

`pgView(...).comment('...')` and `pgMaterializedView(...).comment('...')`
declare the comment a view carries. It is written after the view is created,
on its own when only the text changed (`COMMENT ON VIEW ... IS '...'`), and
again after a recreate; a removed comment is set to null. `existing()` views
carry no comment, since drizzle-kit never creates or alters them. `pull`
reads the comment back from `obj_description`.

## Grants

`pgGrant({ on, to, privileges, withGrantOption? })` declares what a role may do
with an object. `on` is a table, a view, a materialized view or a schema; the
privilege list is typed after it, so a schema takes `usage` and `create` and
everything else takes the table privileges (`select`, `insert`, `update`,
`delete`, `truncate`, `references`, `trigger`, `all`). `to` is a `pgRole` or
the name of a role; `public`, in any spelling, is the `PUBLIC` pseudo-role.

Each privilege is one `GRANT`, which is the grain PostgreSQL reports them back
in, and a privilege the schema no longer declares is revoked. Grants are
issued after the tables and views they are on exist.

### What `push` manages

`push` compares the declared privileges with the ones the database holds for
the roles the schema manages: the roles the `entities.roles` filter accepts,
and the roles the schema names, whether declared with `pgRole` (also with
`.existing()`) or granted to with `pgGrant`. A privilege held by any other
role is left alone, so `push` never revokes what it did not grant. The owner's
privileges on its own objects are not privileges at all and are never
reported.

A privilege the owner granted has no grantor of its own, which is what a
declared one becomes when the migration runs, so the two compare equal.
`GRANTED BY` is emitted only for a privilege that someone other than the owner
granted, as `pull` finds it.

### What `pull` renders

One `pgGrant` per object, grantee and grant option, listing the privileges.
A grant on the `public` schema has no declaration to refer to and is left out.

## Snapshot version 9

The view entity gained `columns` and `comment`, and a privilege on a schema
has no `table`, so the postgres snapshot is version 9. `drizzle-kit up` brings
a version 8 snapshot up: its views get no columns, which the diff reads as
not known, and no comment; its privileges are already in shape.
