// A chat tool: a name, a description, a zod input schema and a run function.
import { z } from 'zod';

export function tool({ name, description, input, run }) {
  const schema = input || z.object({});
  return {
    name,
    description,
    input_schema: z.toJSONSchema(schema, { reused: 'ref' }),
    parse: (args) => schema.parse(args ?? {}),
    run,
  };
}

export { z };
