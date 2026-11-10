import { createClerkClient } from '@clerk/backend';

let cached: ReturnType<typeof createClerkClient> | null = null;

/**
 * Admin-scoped Clerk client, built once.
 *
 * Deliberately lazy: `CLERK_SECRET_KEY` is read at first use rather than at import, so the module
 * can be imported in contexts that never call it (the spec generator, tests) without demanding the
 * secret be present.
 */
function clerk(): ReturnType<typeof createClerkClient> {
  if (!cached) {
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) throw new Error('CLERK_SECRET_KEY is not set');
    cached = createClerkClient({ secretKey });
  }
  return cached;
}

/**
 * Writes the rider's chosen display name to Clerk.
 *
 * Clerk models first + last name; riders type one name. The first word goes in `firstName` and
 * the rest in `lastName`, so every client's `[firstName, lastName].join(' ')` reads back exactly
 * what was typed. A one-word name clears `lastName`.
 */
export async function setClerkName(userId: string, name: string): Promise<void> {
  const space = name.indexOf(' ');
  const firstName = space < 0 ? name : name.slice(0, space);
  const lastName = space < 0 ? '' : name.slice(space + 1);
  await clerk().users.updateUser(userId, { firstName, lastName });
}

/** Uploads a new profile photo to Clerk and returns the hosted URL Clerk now serves for it. */
export async function setClerkProfileImage(userId: string, image: Buffer, contentType: string): Promise<string> {
  // Blob, not File: Blob is global from Node 18, File only from Node 20, and render.yaml doesn't
  // pin a Node version. Clerk reads the type from the Blob; the filename is not needed.
  const file = new Blob([new Uint8Array(image)], { type: contentType });
  const user = await clerk().users.updateUserProfileImage(userId, { file });
  return user.imageUrl;
}

/**
 * Revokes the Clerk identity behind a deleted account.
 *
 * Called AFTER the database delete, never before, and the order is the whole design. Deleting the
 * identity first would invalidate the caller's token mid-request, so any failure downstream would
 * strand their rows with no authenticated way back in to finish the job — a half-deleted account
 * that no one can finish deleting is precisely what the policy forbids.
 *
 * In this order a failure is recoverable rather than terminal. The identity still works, so the
 * next request re-creates the (now empty) user row via `clerkAuth` and calling the endpoint again
 * completes the deletion. That is why the route surfaces a failure here as an error the rider can
 * retry, instead of swallowing it and reporting success.
 *
 * An identity Clerk no longer has is success, not failure: the goal is that it is gone, and a
 * retry after a partial failure must not trip over its own progress.
 */
export async function deleteClerkUser(userId: string): Promise<void> {
  try {
    await clerk().users.deleteUser(userId);
  } catch (err) {
    if ((err as { status?: number })?.status === 404) return;
    throw err;
  }
}
