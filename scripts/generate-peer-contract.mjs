import { readFile, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';
import { parse } from 'yaml';

const dir = new URL('../src/channels/peer/', import.meta.url);
const { components } = parse(await readFile(new URL('openapi.yaml', dir), 'utf8'));
const definitions = JSON.parse(
  JSON.stringify(components.schemas).replaceAll('#/components/schemas/', '#/definitions/'),
  (_key, schema) =>
    schema?.type === 'object' && !schema.properties && schema.additionalProperties === undefined
      ? { ...schema, additionalProperties: true }
      : schema,
);
const properties = Object.fromEntries(
  Object.keys(definitions).map((name) => [name, { $ref: '#/definitions/' + name }]),
);
const types = await compile(
  { type: 'object', properties, required: Object.keys(properties), definitions },
  'PeerSchemas',
  {
    additionalProperties: false,
    maxItems: -1,
    bannerComment: '',
    style: { singleQuote: true, printWidth: 120, trailingComma: 'all' },
  },
);
await writeFile(new URL('types.ts', dir), types);
