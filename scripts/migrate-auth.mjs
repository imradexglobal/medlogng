import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OLD_SA_PATH = resolve(__dirname, '../old-project-service-account.json');
const NEW_SA_PATH = resolve(__dirname, '../new-project-service-account.json');

if (!existsSync(OLD_SA_PATH)) {
  console.error(`Missing old service account: ${OLD_SA_PATH}`);
  process.exit(1);
}
if (!existsSync(NEW_SA_PATH)) {
  console.error(`Missing new service account: ${NEW_SA_PATH}`);
  process.exit(1);
}

const oldApp = initializeApp(
  { credential: cert(JSON.parse(readFileSync(OLD_SA_PATH, 'utf8'))) },
  'old'
);

const newApp = initializeApp(
  { credential: cert(JSON.parse(readFileSync(NEW_SA_PATH, 'utf8'))) },
  'new'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function migrateAuthUsers() {
  const oldAuth = getAuth(oldApp);
  const newAuth = getAuth(newApp);

  // IMPORTANT: Replace these placeholders with the REAL hash params from your
  // OLD Firebase project: Firebase Console > Authentication > Users > ⋮ > Password hash parameters
  // Or pass via env: SCRYPT_KEY (base64), SCRYPT_SALT_SEPARATOR (base64), SCRYPT_ROUNDS, SCRYPT_MEMORY_COST
  const hashConfig = {
    algorithm: 'SCRYPT',
    key: Buffer.from(
      process.env.SCRYPT_KEY || 's2VyLXNlY3JldC1rZXk=',
      'base64'
    ),
    saltSeparator: Buffer.from(process.env.SCRYPT_SALT_SEPARATOR || 'Qw==', 'base64'),
    rounds: Number(process.env.SCRYPT_ROUNDS || 8),
    memoryCost: Number(process.env.SCRYPT_MEMORY_COST || 14),
  };

  if (!process.env.SCRYPT_KEY) {
    console.warn(
      '⚠️  Using placeholder SCRYPT_KEY. Passwords will NOT work unless you set the real signer key from the OLD project.\n' +
        '   Set env SCRYPT_KEY, SCRYPT_SALT_SEPARATOR, SCRYPT_ROUNDS, SCRYPT_MEMORY_COST and re-run.'
    );
  }

  let pageToken;
  let totalMigrated = 0;
  let totalFailed = 0;

  do {
    const listResult = await oldAuth.listUsers(1000, pageToken);

    if (listResult.users.length === 0) break;

    // Convert UserRecord -> UserImportRecord (preserve password hashes)
    const usersToImport = listResult.users.map((u) => {
      const j = u.toJSON();
      const rec = { uid: u.uid };
      if (u.email) rec.email = u.email;
      if (u.emailVerified) rec.emailVerified = true;
      if (u.displayName) rec.displayName = u.displayName;
      if (u.photoURL) rec.photoURL = u.photoURL;
      if (u.disabled) rec.disabled = true;
      if (j.emailVerified !== undefined) rec.emailVerified = j.emailVerified;
      if (j.metadata) rec.metadata = j.metadata;
      if (j.providerData) rec.providerData = j.providerData;
      if (j.passwordHash) rec.passwordHash = Buffer.from(j.passwordHash, 'base64');
      if (j.passwordSalt) rec.passwordSalt = Buffer.from(j.passwordSalt, 'base64');
      // Remove undefined keys (importUsers is strict)
      Object.keys(rec).forEach((k) => rec[k] === undefined && delete rec[k]);
      return rec;
    });

    const importResult = await newAuth.importUsers(usersToImport, {
      hash: hashConfig,
    });

    totalMigrated += importResult.successCount;
    totalFailed += importResult.failureCount;

    if (importResult.errors.length > 0) {
      for (const err of importResult.errors) {
        console.error(`  Failed: uid=${listResult.users[err.index].uid} — ${err.error.message}`);
      }
    }

    console.log(`  Batch: +${importResult.successCount} migrated, ${importResult.failureCount} failed (total: ${totalMigrated})`);

    pageToken = listResult.pageToken;
    if (pageToken) await sleep(500);
  } while (pageToken);

  console.log(`\nMigration complete: ${totalMigrated} migrated, ${totalFailed} failed`);
}

try {
  await migrateAuthUsers();
  process.exit(0);
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
}
