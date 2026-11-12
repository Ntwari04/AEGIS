'use client';
import { useState } from 'react';

/** "My Billing App!" -> "my-billing-app": what the slug rule (lowercase letters, digits, hyphens) allows. */
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');

/**
 * The project's name and slug. The slug follows the name until the person edits it themselves, so the common case needs no second
 * typing, and the slug stays something a person chose, not something that silently changes under them.
 */
export function NameAndSlug({ defaultName = '', defaultSlug = '' }: { defaultName?: string; defaultSlug?: string }) {
  const [name, setName] = useState(defaultName);
  const [slug, setSlug] = useState(defaultSlug);
  const [touched, setTouched] = useState(defaultSlug !== '');
  return (
    <>
      <label htmlFor="name">Name</label>
      <input id="name" name="name" required minLength={2} maxLength={80} value={name}
        onChange={(e) => { setName(e.target.value); if (!touched) setSlug(slugify(e.target.value)); }} />
      <label htmlFor="slug">Slug (lowercase letters, digits, hyphens; used in addresses, so it is hard to change later)</label>
      <input id="slug" name="slug" required pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?" maxLength={40} value={slug}
        onChange={(e) => { setSlug(e.target.value); setTouched(true); }} />
    </>
  );
}
