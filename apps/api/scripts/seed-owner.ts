import { parseEnv } from '@fancyfolio/contracts';
import { createAuth } from '../src/auth.ts';
import { seedOwnerEnv } from '../src/env.ts';
import { errorCode } from '../src/shell.ts';

const { SEED_EMAIL, SEED_NAME, SEED_PASSWORD } = parseEnv(seedOwnerEnv, process.env);
const auth = createAuth([SEED_EMAIL]);

async function seed(): Promise<boolean> {
  const { user } = await auth.api.signUpEmail({
    body: { email: SEED_EMAIL, name: SEED_NAME, password: SEED_PASSWORD },
  });
  const { internalAdapter } = await auth.$context;
  const stored = await internalAdapter.findUserByEmail(SEED_EMAIL);
  return stored?.user.id === user.id;
}

const seeded = await seed().catch((error: unknown) => {
  const code = errorCode(error);
  const name = error instanceof Error ? error.name : typeof error;
  console.error(`Seed failed: ${name}${code === undefined ? '' : ` (${code})`}.`);
  process.exit(1);
});

if (seeded) {
  console.log(`Seeded ${SEED_EMAIL}.`);
  process.exit(0);
}
console.error('Refused: a user with that email already exists.');
process.exit(1);
