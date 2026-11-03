import { createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time check of GitHub's `X-Hub-Signature-256` header over the RAW request body. */
export function verifyGithubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(header.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Registry repository for an environment: explicit `imageRepo`, else ghcr.io/<owner/repo> lowercased (GHCR requires lowercase). */
export function imageRepoFor(env: { imageRepo?: string | null; project?: { githubRepo?: string | null } | null }): string | null {
  if (env.imageRepo) return env.imageRepo.toLowerCase();
  const repo = env.project?.githubRepo;
  return repo ? `ghcr.io/${repo.toLowerCase()}` : null;
}
