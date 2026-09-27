const target = db.getSiblingDB('kamogis');
for (const [name, type] of [['facilities', null], ['bus_stops', 0], ['bike_stations', 1]]) {
  const properties = {
    facility_type: { bsonType: 'int', enum: type === null ? [0, 1] : [type] },
    source_id: { bsonType: 'string', minLength: 1 },
    name: { bsonType: 'string', minLength: 1 },
    location: {
      bsonType: 'object', required: ['type', 'coordinates'],
      properties: {
        type: { enum: ['Point'] },
        coordinates: { bsonType: 'array', minItems: 2, maxItems: 2, items: { bsonType: 'double' } }
      }
    },
    attributes: { bsonType: 'object' }
  };
  const validator = { $jsonSchema: {
    bsonType: 'object', required: ['facility_type', 'source_id', 'name', 'location', 'attributes'], properties
  } };
  if (!target.getCollectionNames().includes(name)) target.createCollection(name, { validator });
  else target.runCommand({ collMod: name, validator });
  target.getCollection(name).createIndex(type === null ? { facility_type: 1, source_id: 1 } : { source_id: 1 }, { unique: true });
  target.getCollection(name).createIndex({ location: '2dsphere' });
}
