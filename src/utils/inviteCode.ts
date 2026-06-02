import { randomBytes } from 'crypto';

const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateInviteCode(): string {
  const bytes = randomBytes(4);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CHARSET[bytes[i % 4] % 32];
  }
  return code;
}
