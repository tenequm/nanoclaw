import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

const { components } = parse(readFileSync(new URL('./openapi.yaml', import.meta.url), 'utf8'));
const validator = new Ajv2020({ strict: false, validateFormats: false });
validator.addSchema({ components: { schemas: components.schemas } }, 'peer');
function check(name: string, data: unknown) {
  const valid = validator.validate('peer#/components/schemas/' + name, data);
  expect(valid, validator.errorsText()).toBe(true);
}

interface Example {
  'x-amesh-schema': string;
  dataValue?: unknown;
  serializedValue?: string;
}
for (const [name, example] of Object.entries<Example>(components.examples)) {
  it('validates ' + name, () => {
    if (example.serializedValue === undefined) return check(example['x-amesh-schema'], example.dataValue);
    for (const block of example.serializedValue.trim().split(/\n\n+/)) {
      const fields = Object.fromEntries(
        block
          .split('\n')
          .filter((line) => !line.startsWith(':'))
          .map((line) => {
            const i = line.indexOf(':');
            return [line.slice(0, i), line.slice(i + 1).trimStart()];
          }),
      );
      if (!Object.keys(fields).length) continue;
      check(example['x-amesh-schema'], fields);
      const event = JSON.parse(fields.data);
      check('PeerEvent', event);
      expect(event.kind).toBe(fields.event);
      if (fields.id) expect(String(event.seq)).toBe(fields.id);
    }
  });
}
