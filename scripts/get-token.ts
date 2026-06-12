/**
 * Prints a JWT for an existing active Clerk session.
 *
 * Usage:
 *   tsx scripts/get-token.ts <userId>
 *
 * Get userId from Clerk dashboard → Users → click a user → copy the "User ID"
 * The user must have at least one active session (i.e. be signed in on a device).
 */

import 'dotenv/config';
import { createClerkClient } from '@clerk/backend';

const userId = process.argv[2];
if (!userId) {
  console.error('Usage: tsx scripts/get-token.ts <userId>');
  process.exit(1);
}

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

async function main() {
  const { data: sessions } = await clerk.sessions.getSessionList({
    userId,
    status: 'active',
  });

  if (sessions.length === 0) {
    console.error(
      'No active sessions found for this user.\n' +
        'Sign in on the iOS app or create a session via the Clerk dashboard first.'
    );
    process.exit(1);
  }

  const { jwt } = await clerk.sessions.getToken(sessions[0].id, 'default');
  console.log(jwt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
