import { withOwner } from './owner.ts';
import { setRolePasswords } from './roles.ts';

await withOwner(async (sql) => {
  await setRolePasswords(sql, process.env);
  console.log('Login enabled with new passwords for ff_app and ff_auth.');
});
