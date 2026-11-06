import { escapeSingleQuotes } from '../../utils';
import type { DB } from '../../utils';
import { createTriggerStatement, createViewStatement, triggerTable, viewKey } from './convertor';
import type { PostgresDDL, Trigger, View } from './ddl';
import { parseTriggerDefinition, parseViewDefinition } from './grammar';

/*
	Postgres does not keep the text of a trigger's `WHEN` condition or of a
	view's query. It keeps the parsed expression and prints it back in its own
	spelling (`old.x` for `OLD.x`, extra parentheses, explicit casts). So on a
	push, the declared text and the text that introspection reads differ even
	when the two mean the same thing. A text comparison would replace every
	such trigger and view on every push, and no comparison at all (what push
	did before) misses every change of them.

	A probe asks Postgres for its spelling of the declared text: it creates the
	trigger or the view under a probe name, reads the definition back as
	introspection does, and rolls back. When that spelling is the one that
	stands in the database, the two texts mean the same, and the introspected
	object takes the declared text, so the diff sees no change, and SQL that
	creates the object again (a view that becomes a materialized view) keeps
	the declared text. When the spelling differs, or the probe fails (the
	condition names a column that the push adds, the function of the trigger
	does not exist yet), both texts stay as they are, and the diff replaces
	the object.
*/

/**
 * The name of the trigger or view that a probe creates. The probe drops it
 * and rolls back its scope, so the name is never seen outside the probe.
 */
const PROBE_NAME = '__drizzle_kit_spelling_probe';

/** The savepoint of a probe that runs inside a transaction of the caller. */
const PROBE_SAVEPOINT = 'drizzle_kit_spelling_probe';

/**
 * Opens the scope that a probe rolls back, and returns the statements that
 * roll it back. Inside a transaction of the caller (a push through the API
 * in the caller's transaction), the scope is a savepoint, so the rollback
 * keeps the caller's transaction. Outside one, Postgres refuses `SAVEPOINT`
 * and the scope is a transaction of its own.
 */
const openProbeScope = async (db: DB) => {
	try {
		await db.query(`SAVEPOINT ${PROBE_SAVEPOINT}`);
		return [`ROLLBACK TO SAVEPOINT ${PROBE_SAVEPOINT}`, `RELEASE SAVEPOINT ${PROBE_SAVEPOINT}`];
	} catch {
		await db.query('BEGIN');
		return ['ROLLBACK'];
	}
};

/**
 * Runs `create`, reads the definition back with `read`, and leaves the
 * database as it was. It returns null when Postgres refuses `create`.
 *
 * Everything runs in one scope that the probe rolls back (see
 * {@link openProbeScope}). The probe also drops what it created before the
 * rollback: a connection that does not keep a transaction across queries
 * (a pool, an HTTP driver) commits each query on its own, and the drop
 * removes the probe object there too.
 */
const probe = async (db: DB, create: string, read: string, drop: string): Promise<string | null> => {
	const rollback = await openProbeScope(db);
	try {
		await db.query(create);
		const rows = await db.query<{ definition: string | null }>(read);
		await db.query(drop);
		return rows[0]?.definition ?? null;
	} catch {
		return null;
	} finally {
		for (const statement of rollback) await db.query(statement);
	}
};

/**
 * The condition of `declared` as Postgres prints it, or null when the probe
 * fails. The probe is a plain trigger with the declared timing, events,
 * level and condition, on the table of the trigger that stands (`live`).
 * It calls the function of `live`, which exists, while the declared
 * function may be one that the push creates.
 */
const readPrintedCondition = async (db: DB, declared: Trigger, live: Trigger) => {
	const trigger: Trigger = {
		...declared,
		name: PROBE_NAME,
		constraint: null,
		functionSchema: live.functionSchema,
		functionName: live.functionName,
	};
	const table = escapeSingleQuotes(triggerTable(trigger));
	const definition = await probe(
		db,
		createTriggerStatement(trigger),
		`SELECT pg_catalog.pg_get_triggerdef(oid) AS "definition" FROM pg_catalog.pg_trigger
			WHERE tgrelid OPERATOR(pg_catalog.=) '${table}'::pg_catalog.regclass AND tgname OPERATOR(pg_catalog.=) '${PROBE_NAME}'`,
		`DROP TRIGGER "${PROBE_NAME}" ON ${triggerTable(trigger)}`,
	);
	return definition === null ? null : parseTriggerDefinition(definition)?.condition ?? null;
};

/**
 * The query of `declared` as Postgres prints it, or null when the probe
 * fails. The probe is a plain view in `schema`, also for a materialized
 * view: Postgres prints the query of both the same way, and a plain view
 * does not run it. The schema of the probe does not change the spelling,
 * since Postgres resolves and prints the names of a query by the search
 * path. So the caller passes a schema that exists: a view can move to a
 * schema that the push creates.
 */
const readPrintedDefinition = async (db: DB, declared: View, schema: string) => {
	const view: View = {
		...declared,
		schema,
		name: PROBE_NAME,
		materialized: false,
		with: null,
		withNoData: null,
		using: null,
		tablespace: null,
	};
	const definition = await probe(
		db,
		createViewStatement(view, false),
		`SELECT pg_catalog.pg_get_viewdef('${
			escapeSingleQuotes(viewKey(view))
		}'::pg_catalog.regclass, true) AS "definition"`,
		`DROP VIEW ${viewKey(view)}`,
	);
	return parseViewDefinition(definition);
};

/**
 * The views in the database that a declared view can be: the one with its
 * schema and name, or, when there is none, the ones that the schema does
 * not declare. A view that is renamed or moved to another schema is one of
 * these until `ddlDiff` resolves the rename, and its query keeps its
 * meaning across the rename. Only views with a query are listed.
 */
const listStandingViews = (live: PostgresDDL, declared: PostgresDDL, view: View) => {
	const standing = live.views.one({ schema: view.schema, name: view.name });
	const candidates = standing
		? [standing]
		: live.views.list().filter((it) => !declared.views.one({ schema: it.schema, name: it.name }));
	return candidates.filter((it) => it.definition !== null);
};

/**
 * Gives the introspected schema (`live`) the declared text of each trigger
 * condition and view query of `declared` that means what stands, so that a
 * push diffs these expressions by meaning and not by text. Call it on a
 * push, after introspection and before `ddlDiff`; it changes `live` in
 * place.
 *
 * Only an expression whose text differs from every text it can mean is
 * probed, one rolled-back scope each: a trigger's condition against the
 * condition of the trigger with its table and name, and a view's query
 * against the queries of {@link listStandingViews}. A schema pushed to an
 * empty database probes nothing. A trigger has no rename to follow:
 * `ddlDiff` drops a renamed trigger and creates it again.
 *
 * The probes create a trigger on a table of the database (a short `SHARE
 * ROW EXCLUSIVE` lock) and a view in a schema of the database, and need
 * the privileges for both, as the push itself does.
 */
export const adoptDeclaredSpelling = async (db: DB, live: PostgresDDL, declared: PostgresDDL) => {
	for (const trigger of declared.triggers.list()) {
		const { schema, table, name, condition } = trigger;
		const standing = live.triggers.one({ schema, table, name });
		if (!standing || standing.condition === null || condition === null) continue;
		if (standing.condition === condition) continue;

		const printed = await readPrintedCondition(db, trigger, standing);
		if (printed === standing.condition) {
			live.triggers.update({ set: { condition }, where: { schema, table, name } });
		}
	}

	for (const view of declared.views.list()) {
		const { definition } = view;
		const standing = listStandingViews(live, declared, view);
		if (definition === null || standing.length === 0) continue;
		if (standing.some((it) => it.definition === definition)) continue;

		const printed = await readPrintedDefinition(db, view, standing[0]!.schema);
		if (printed === null) continue;

		for (const it of standing.filter((it) => it.definition === printed)) {
			live.views.update({ set: { definition }, where: { schema: it.schema, name: it.name } });
		}
	}
};
