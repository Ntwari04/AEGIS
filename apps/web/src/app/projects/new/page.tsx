import { redirect } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { ProjectDto } from '@aegisops/shared-types';

async function createProject(formData: FormData) {
  'use server';
  const githubRepo = String(formData.get('githubRepo') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  let id: string;
  try {
    const p = await api<ProjectDto>('/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: String(formData.get('name') ?? '').trim(),
        slug: String(formData.get('slug') ?? '').trim(),
        ...(description ? { description } : {}),
        ...(githubRepo ? { githubRepo } : {}),
      }),
    });
    id = p.id;
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : 'Could not create project';
    redirect(`/projects/new?error=${encodeURIComponent(msg)}`);
  }
  redirect(`/projects/${id}`);
}

export default async function NewProject({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <>
      <h1>New project</h1>
      <form action={createProject} className="card">
        {error && <p className="error" data-testid="form-error">{error}</p>}
        <label htmlFor="name">Name</label>
        <input id="name" name="name" required minLength={2} maxLength={80} />
        <label htmlFor="slug">Slug (lowercase letters, digits, hyphens)</label>
        <input id="slug" name="slug" required pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?" maxLength={40} />
        <label htmlFor="githubRepo">GitHub repository (owner/repo, optional)</label>
        <input id="githubRepo" name="githubRepo" placeholder="inclusivity/example" />
        <label htmlFor="description">Description (optional)</label>
        <textarea id="description" name="description" rows={3} maxLength={500} />
        <button data-testid="create-project">Create project</button>
      </form>
    </>
  );
}
