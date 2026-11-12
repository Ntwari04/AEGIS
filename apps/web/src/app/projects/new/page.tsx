import { redirect } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { ProjectDto } from '@aegisops/shared-types';
import { NameAndSlug } from './name-and-slug';

async function createProject(formData: FormData) {
  'use server';
  const text = (k: string) => String(formData.get(k) ?? '').trim();
  const githubRepo = text('githubRepo');
  const description = text('description');
  let id: string;
  try {
    const p = await api<ProjectDto>('/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: text('name'),
        slug: text('slug'),
        ...(description ? { description } : {}),
        ...(githubRepo ? { githubRepo } : {}),
      }),
    }, { redirectOn401: false });
    id = p.id;
  } catch (e) {
    // Only API errors are reported; Next's redirect exceptions must propagate.
    if (!(e instanceof ApiError)) throw e;
    // Bring back what was typed (none of it is secret), so a refused slug or repository does not mean typing everything again.
    const back = new URLSearchParams({ error: e.message, name: text('name'), slug: text('slug'), githubRepo, description: description.slice(0, 500) });
    redirect(`/projects/new?${back}`);
  }
  redirect(`/projects/${id}`);
}

export default async function NewProject({ searchParams }: { searchParams: Promise<{ error?: string; name?: string; slug?: string; githubRepo?: string; description?: string }> }) {
  const { error, name = '', slug = '', githubRepo = '', description = '' } = await searchParams;
  return (
    <>
      <h1>New project</h1>
      <p className="note">A project is one GitHub repository and the places it runs (staging, production). You add environments, databases and people on the next page.</p>
      <form action={createProject} className="card">
        {error && <p className="error" data-testid="form-error">{error}</p>}
        <NameAndSlug defaultName={name} defaultSlug={slug} />
        <label htmlFor="githubRepo">GitHub repository (owner/repo, optional)</label>
        <input id="githubRepo" name="githubRepo" placeholder="example-org/example" defaultValue={githubRepo} />
        <label htmlFor="description">Description (optional)</label>
        <textarea id="description" name="description" rows={3} maxLength={500} defaultValue={description} />
        <button data-testid="create-project">Create project</button>
      </form>
    </>
  );
}
