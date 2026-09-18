import type * as GJ from 'geojson';
import type { Equal } from 'type-tests/utils.ts';
import { Expect } from 'type-tests/utils.ts';
import type {
	BBox,
	Geometry,
	GeometryCollection,
	GeometryType,
	LineString,
	MultiLineString,
	MultiPoint,
	MultiPolygon,
	Point,
	Polygon,
	Position,
} from '~/pg-core/index.ts';

// The vendored GeoJSON types must stay interchangeable with `@types/geojson`
// in both directions, so users can pass values between drizzle and any
// GeoJSON library without casts.

Expect<Equal<BBox, GJ.BBox>>;
Expect<Equal<Position, GJ.Position>>;
Expect<Equal<GeometryType, GJ.GeoJsonGeometryTypes>>;

{
	const point: Point = {} as GJ.Point;
	const gjPoint: GJ.Point = {} as Point;
	const multiPoint: MultiPoint = {} as GJ.MultiPoint;
	const gjMultiPoint: GJ.MultiPoint = {} as MultiPoint;
	const lineString: LineString = {} as GJ.LineString;
	const gjLineString: GJ.LineString = {} as LineString;
	const multiLineString: MultiLineString = {} as GJ.MultiLineString;
	const gjMultiLineString: GJ.MultiLineString = {} as MultiLineString;
	const polygon: Polygon = {} as GJ.Polygon;
	const gjPolygon: GJ.Polygon = {} as Polygon;
	const multiPolygon: MultiPolygon = {} as GJ.MultiPolygon;
	const gjMultiPolygon: GJ.MultiPolygon = {} as MultiPolygon;
	const collection: GeometryCollection = {} as GJ.GeometryCollection;
	const gjCollection: GJ.GeometryCollection = {} as GeometryCollection;
	const geometry: Geometry = {} as GJ.Geometry;
	const gjGeometry: GJ.Geometry = {} as Geometry;

	void [
		point,
		gjPoint,
		multiPoint,
		gjMultiPoint,
		lineString,
		gjLineString,
		multiLineString,
		gjMultiLineString,
		polygon,
		gjPolygon,
		multiPolygon,
		gjMultiPolygon,
		collection,
		gjCollection,
		geometry,
		gjGeometry,
	];
}

{
	// A `Feature` from `@types/geojson` can carry a drizzle geometry, and
	// a drizzle geometry can be narrowed on `type` like any GeoJSON value.
	const feature: GJ.Feature<Geometry> = {
		type: 'Feature',
		geometry: { type: 'Point', coordinates: [1, 2] },
		properties: null,
	};
	const narrowed = feature.geometry;
	if (narrowed.type === 'Polygon') {
		Expect<Equal<typeof narrowed, Polygon>>;
	}
}

{
	// Literal-typed `type` members. Assigning the wrong name is an error.
	// @ts-expect-error
	const wrong: Point = { type: 'Polygon', coordinates: [1, 2] };
	void wrong;
}
