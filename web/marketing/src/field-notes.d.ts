declare module 'virtual:meet-field-notes' {
  export type FieldNote = {
    title: string;
    description: string;
    slug: string;
    status: 'published';
    locale: 'en';
    published: string;
    updated: string;
    author: string;
    related: string[];
    body: string;
  };
  export const fieldNotes: FieldNote[];
}
