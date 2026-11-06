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
only. A selection with an expression in it, or a view that `drizzle-kit up`
converted from snapshot format 8, gives no columns, and a view whose columns
are not known is never replaced in place.

A replaced view is ordered together with the created views, so it comes after
a new view that it now selects from. The schema metadata gives that order.
Without it (`push` from a database state, and `up`), the view names in the
definition text give it.

Otherwise the view is dropped and created again, and so is every view that
selects from it: dependents are dropped first, in the reverse of the order they
are created in. A materialized view has no replace form and is always
recreated. A recreated view is granted its privileges again, since
`DROP VIEW` took them with it.

`push` compares a definition by what it means. Postgres keeps the parsed
query, not its text, and prints it in its own spelling, so the declared text
and the text that introspection reads differ for the same query. Before the
diff, `push` creates each declared view whose text differs from the
database's under a probe name, reads its definition back with
`pg_get_viewdef` and rolls back. When Postgres prints the two queries the
same, the view is unchanged; otherwise the rules above apply. A view that is
renamed or moved is compared with the views in the database that the schema
does not declare. A trigger's `WHEN` condition is compared the same way.

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

A privilege has no name. It is known by who holds what on which object: its
schema, its table (none for a privilege on a schema), its grantor, its grantee
and its type. So nothing about a privilege is renamed. It follows its object:
a renamed or moved table or view and a renamed schema keep their privileges,
and the migration writes no `REVOKE` and no `GRANT` for them. A dropped object
takes its privileges with it.

`drizzle-kit check` sees a conflict between a grant on one branch and a rename
or a drop of its table, its view or its schema on another branch.

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

## Snapshots

The view `columns` and `comment`, and a privilege on a schema (with no
`table`), are fields of the rows that snapshot format 9 stores in its base
snapshot and in its deltas. `drizzle-kit up` converts a format 8 snapshot:
its views get an empty column list, which the diff reads as not known, and no
comment. Its privileges are already in shape.
