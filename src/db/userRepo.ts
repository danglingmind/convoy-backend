import { pool } from './pool';

export async function upsertUser(
  id: string,
  name: string,
  avatarUrl: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, name, avatar_url, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO NOTHING`,
    [id, name, avatarUrl]
  );
}

export async function getUserById(
  id: string
): Promise<{ id: string; name: string; avatar_url: string | null } | null> {
  const { rows } = await pool.query(
    'SELECT id, name, avatar_url FROM users WHERE id = $1',
    [id]
  );
  return rows[0] ?? null;
}
