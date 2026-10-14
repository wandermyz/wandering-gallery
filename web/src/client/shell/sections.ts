// The app's top-level sections. Each one owns every URL under its path.

export type SectionId = 'gallery' | 'generate' | 'dashboard';

export interface Section {
  id: SectionId;
  label: string;
  icon: string;
  path: string;
}

export const SECTIONS: Section[] = [
  { id: 'gallery', label: 'Gallery', icon: 'image', path: '/gallery' },
  { id: 'generate', label: 'Generate', icon: 'sparkle', path: '/generate' },
  { id: 'dashboard', label: 'Dashboard', icon: 'gauge', path: '/dashboard' },
];

export const DEFAULT_SECTION: SectionId = 'gallery';
