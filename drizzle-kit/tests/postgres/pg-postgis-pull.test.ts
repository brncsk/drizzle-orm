import { sql } from 'drizzle-orm';
import { geography, geometry, integer, pgTable } from 'drizzle-orm/pg-core';
import { interimToDDL } from 'src/dialects/postgres/ddl';
import { fromDatabaseForDrizzle } from 'src/dialects/postgres/introspect';
import { ddlToTypeScript } from 'src/dialects/postgres/typescript';
import { prepareEntityFilter } from 'src/dialects/pull-utils';
import { describe, expect, test } from 'vitest';
import { preparePostgisTestDatabase, push } from './mocks';

// Needs a PostGIS database: `bash compose/dockers.sh up postgres-postgis` and POSTGIS_URL in drizzle-kit/.env.
describe.skipIf(!process.env['POSTGIS_URL'])('pull PostGIS columns', () => {
	test('every subtype, SRID and default form', async () => {
		const postgisDb = await preparePostgisTestDatabase();

		try {
			const schema = {
				places: pgTable('places', {
					id: integer('id').primaryKey(),
					any: geometry('any'),
					anyWithSrid: geometry('any_with_srid', { srid: 4326 }),
					point: geometry('point', { type: 'Point', srid: 4326 }).default({
						type: 'Point',
						coordinates: [19.0402, 47.4979],
					}),
					footprint: geometry('footprint', { type: 'MultiPolygon', srid: 4326 }).notNull(),
					axis: geometry('axis', { type: 'LineStringZM', srid: 3857 }),
					legacy: geometry('legacy', { type: 'Point', mode: 'tuple' }).default([1, 2]),
					parts: geometry('parts', { type: 'Polygon' }).array().default([
						{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
					]),
					curve: geometry('curve', { type: 'CircularString' }),
					foreignSrid: geometry('foreign_srid').default(sql`'SRID=3857;POINT(7 8)'`),
					place: geography('place', { type: 'Point' }).default({ type: 'Point', coordinates: [1, 2] }),
					region: geography('region', { type: 'MultiPolygon', srid: 4269 }),
					anyGeography: geography('any_geography'),
					anyGeographyWithSrid: geography('any_geography_with_srid', { srid: 4326 }),
				}),
			};

			await push({ db: postgisDb.db, to: schema, tables: ['places'], schemas: ['public'] });

			const filter = prepareEntityFilter('postgresql', {
				tables: ['places'],
				schemas: [],
				entities: undefined,
				extensions: [],
			}, []);
			const introspected = await fromDatabaseForDrizzle(postgisDb.db, filter, () => true, {
				schema: 'drizzle',
				table: '__drizzle_migrations',
			});
			const { ddl } = interimToDDL(introspected);
			const { file } = ddlToTypeScript(ddl, introspected.viewColumns, 'camel');

			expect(file).toMatch(/^import \{ pgTable, .*\bgeometry\b.*\bgeography\b.* \} from "drizzle-orm\/pg-core"$/m);
			const lines = file.split('\n').map((line) => line.trim());
			expect(lines).toEqual(expect.arrayContaining([
				`any: geometry(),`,
				`anyWithSrid: geometry("any_with_srid", { srid: 4326 }),`,
				`point: geometry({ type: 'Point', srid: 4326 }).default({ type: 'Point', coordinates: [19.0402, 47.4979] }),`,
				`footprint: geometry({ type: 'MultiPolygon', srid: 4326 }).notNull(),`,
				`axis: geometry({ type: 'LineStringZM', srid: 3857 }),`,
				`legacy: geometry({ type: 'Point' }).default({ type: 'Point', coordinates: [1, 2] }),`,
				`parts: geometry({ type: 'Polygon' }).array().default([{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }]),`,
				`curve: geometry({ type: 'CircularString' }),`,
				`foreignSrid: geometry("foreign_srid").default(sql\`'SRID=3857;POINT(7 8)'\`),`,
				`place: geography({ type: 'Point' }).default({ type: 'Point', coordinates: [1, 2] }),`,
				`region: geography({ type: 'MultiPolygon', srid: 4269 }),`,
				`anyGeography: geography("any_geography"),`,
				`anyGeographyWithSrid: geography("any_geography_with_srid", { srid: 4326 }),`,
			]));
		} finally {
			await postgisDb.clear();
			await postgisDb.close();
		}
	});
});
