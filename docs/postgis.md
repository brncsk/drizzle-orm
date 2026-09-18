# PostGIS `geometry` and `geography` columns

Drizzle reads and writes PostGIS `geometry` and `geography` columns as GeoJSON
(RFC 7946). Every PostGIS subtype and SRID can be declared, values are typed
after the declared subtype, and no `ST_AsGeoJSON` or `ST_GeomFromGeoJSON` call
is needed in queries.

```ts
import { geography, geometry, pgTable } from 'drizzle-orm/pg-core';
import type { MultiPolygon, Point } from 'drizzle-orm/pg-core';

const places = pgTable('places', {
	id: serial().primaryKey(),
	center: geometry({ type: 'Point', srid: 4326 }).notNull(),
	footprint: geometry({ type: 'MultiPolygon', srid: 4326 }),
	location: geography({ type: 'Point' }),
});

await db.insert(places).values({
	center: { type: 'Point', coordinates: [19.0402, 47.4979] },
	footprint: { type: 'MultiPolygon', coordinates: [[[[19.04, 47.49], [19.05, 47.49], [19.05, 47.5], [19.04, 47.49]]]] },
});

const rows = await db.select().from(places);
// rows[0].center:    Point
// rows[0].footprint: MultiPolygon | null
```

## Declaring columns

`geometry()` and `geography()` take an optional name and an options object.

| Option | Meaning |
| --- | --- |
| `type` | PostGIS subtype for the typmod: `'Point'`, `'MultiPolygon'`, `'LineStringZ'`, `'PointZM'`, ... in PostGIS or lowercase casing. Omit it for a column that accepts every subtype. |
| `srid` | Spatial reference identifier for the typmod and for every written value. |
| `mode` | `geometry` only. `'geojson'` (default) for every subtype; `'tuple'` (`[x, y]`) or `'xy'` (`{ x, y }`) for `type: 'Point'`. |

The TypeScript type of a column's values follows `type`:

| `type` | Value type |
| --- | --- |
| omitted, `'Geometry'`, an unknown string | `Geometry` (the union of the seven types below) |
| `'Point'`, `'PointZ'`, `'PointM'`, `'PointZM'` | `Point` |
| `'MultiPoint'` (with any suffix) | `MultiPoint` |
| `'LineString'` | `LineString` |
| `'MultiLineString'` | `MultiLineString` |
| `'Polygon'` | `Polygon` |
| `'MultiPolygon'` | `MultiPolygon` |
| `'GeometryCollection'` | `GeometryCollection` |
| `'CircularString'`, `'CompoundCurve'`, `'CurvePolygon'`, `'MultiCurve'`, `'MultiSurface'`, `'PolyhedralSurface'`, `'TIN'`, `'Triangle'` | `unknown` (see [Limits](#limits)) |

The GeoJSON types (`Geometry`, `Point`, `Position`, `BBox`, ...) are exported
from `drizzle-orm/pg-core`. They have the same members as the types in
`@types/geojson`, so values can be passed to and from any GeoJSON library
without casts. `drizzle-orm` does not depend on `@types/geojson`.

### The SQL type

| Declaration | SQL type |
| --- | --- |
| `geometry()` | `geometry` |
| `geometry({ srid: 4326 })` | `geometry(geometry,4326)` |
| `geometry({ type: 'MultiPolygon' })` | `geometry(multipolygon)` |
| `geometry({ type: 'MultiPolygon', srid: 4326 })` | `geometry(multipolygon,4326)` |
| `geometry({ type: 'PointZM', srid: 3857 })` | `geometry(pointzm,3857)` |
| `geography()` | `geography` |
| `geography({ type: 'Point' })` | `geography(point)` (PostGIS applies SRID 4326) |
| `geography({ type: 'Point', srid: 4269 })` | `geography(point,4269)` |
| `geometry({ type: 'Polygon' }).array()` | `geometry(polygon)[]` |

The typmod is written in lowercase. PostGIS accepts any casing and reports the
subtype in its own casing (`geometry(MultiPolygon,4326)`); drizzle-kit compares
the two case-insensitively.

### The legacy point shapes

Before GeoJSON support, `geometry()` was a point column that returned `[x, y]`
by default and `{ x, y }` with `mode: 'xy'`. Both shapes are still available
for point columns:

```ts
const t = pgTable('t', {
	tuple: geometry({ type: 'Point', mode: 'tuple' }), // [number, number]
	xy: geometry({ type: 'Point', mode: 'xy' }),       // { x: number; y: number }
});
```

`type: 'Point'` is required with these modes; the type checker rejects
`mode: 'tuple'` on any other subtype, and a bare `geometry()` now means "any
geometry", not a point.

## Values

### Reading

PostGIS sends geometries as hex-encoded EWKB. Drizzle parses it on the client
into plain GeoJSON objects. The parser handles both byte orders, PostGIS's
flag bits and ISO WKB type codes, SRIDs, Z and M ordinates, empty geometries
and nested collections.

- A position is `[x, y]`, or `[x, y, z]` for a Z geometry.
- An M-only geometry (`PointM`, `LineStringM`, ...) gives `[x, y, m]`; a ZM
  geometry gives `[x, y, z, m]`. RFC 7946 has no M, so this is an extension;
  `ST_AsGeoJSON` drops M instead.
- `POINT EMPTY` reads as `coordinates: []`; other empty geometries read as an
  empty coordinate or `geometries` array, like `ST_AsGeoJSON`.
- The SRID stored in the value is not part of the result: GeoJSON has no
  `crs` member. `parseEWKB` from `drizzle-orm/pg-core` returns it for code
  that needs it.

The same parser runs in every Postgres driver, in relational queries (root and
nested `with`), and through `sql\`...\`.mapWith(column)`:

```ts
const buffered = await db.select({
	area: sql`ST_Buffer(${places.footprint}, 0.01)`.mapWith(places.footprint), // MultiPolygon
}).from(places);
```

### Writing

Values are written as EWKT with the column's SRID:
`SRID=4326;MULTIPOLYGON(((19.04 47.49,...)))`. PostGIS accepts this text as a
bound parameter, as an inlined literal and as a column default, so no cast is
needed and the value reads well in query logs.

- A position with three numbers is written as Z, or as M when the column's
  `type` is M-only (`POINTM(x y m)`); four numbers are written as ZM.
- An empty coordinate array is written as `<TYPE> EMPTY`.
- A `string` value is passed through unchanged, so WKT, EWKT and hex EWKB text
  work as values.
- `sql` values are accepted wherever a column value is:
  `center: sql\`ST_SetSRID(ST_MakePoint(${x}, ${y}), 4326)\``.
- Nothing is checked against the column typmod on the client. PostGIS rejects
  a mismatch (a Polygon into a `geometry(point)` column, or an SRID that
  differs from the typmod) with a message that names it.

`geoJSONToEWKT`, `parseEWKT` and `ewkbToGeoJSON` are exported from
`drizzle-orm/pg-core` for code that needs the conversions outside a column.

### Arrays

`.array()` works as for every other column: `geometry({ type: 'Polygon' }).array()`
reads and writes `Polygon[]`, and `.array('[][]')` gives `Polygon[][]`.

## Limits

- Curve and surface subtypes (`CircularString`, `CompoundCurve`,
  `CurvePolygon`, `MultiCurve`, `MultiSurface`, `PolyhedralSurface`, `TIN`,
  `Triangle`) can be declared and migrated, but GeoJSON cannot represent
  them. Their values type as `unknown`, and reading one throws
  `Unsupported PostGIS geometry type <name>`. Select such columns through
  `sql` (for example `ST_AsText`), or declare them with `customType`.
- `bbox` members are not produced on read and are ignored on write.
- Foreign members other than `type`, `coordinates`, `geometries` and `bbox`
  are ignored on write.
