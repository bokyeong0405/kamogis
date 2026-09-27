CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS unified;
CREATE SCHEMA IF NOT EXISTS separated;

CREATE TABLE IF NOT EXISTS unified.facilities (
    facility_type smallint NOT NULL CHECK (facility_type IN (0,1)),
    source_id text NOT NULL CHECK (length(source_id) > 0),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    geom geometry(Point,4326) NOT NULL,
    attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
    PRIMARY KEY (facility_type, source_id),
    CHECK (NOT ST_IsEmpty(geom) AND ST_X(geom) BETWEEN -180 AND 180 AND ST_Y(geom) BETWEEN -90 AND 90)
);
CREATE TABLE IF NOT EXISTS separated.bus_stops (
    source_id text PRIMARY KEY CHECK (length(source_id) > 0),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    geom geometry(Point,4326) NOT NULL,
    attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
    CHECK (NOT ST_IsEmpty(geom) AND ST_X(geom) BETWEEN -180 AND 180 AND ST_Y(geom) BETWEEN -90 AND 90)
);
CREATE TABLE IF NOT EXISTS separated.bike_stations (LIKE separated.bus_stops INCLUDING ALL);
CREATE INDEX IF NOT EXISTS facilities_geom ON unified.facilities USING gist(geom);
CREATE INDEX IF NOT EXISTS bus_stops_geom ON separated.bus_stops USING gist(geom);
CREATE INDEX IF NOT EXISTS bike_stations_geom ON separated.bike_stations USING gist(geom);
