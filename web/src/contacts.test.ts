import { describe, expect, it } from 'vitest';
import { contactDisplayName, contactLookupEmails, contactsByAddress, draftEmails } from './contacts';

describe('contact drafts (meet#947)', () => {
  it('reads one address per line or comma, the primary first, empty lines left out', () => {
    expect(draftEmails('ada@acme.example\n\n ada@home.example , a@b.example;')).toEqual(['ada@acme.example', 'ada@home.example', 'a@b.example']);
    expect(draftEmails('')).toEqual([]);
  });

  it('names a contact by name, else by address', () => {
    expect(contactDisplayName({ name: ' Ada ', email: 'ada@acme.example' })).toBe('Ada');
    expect(contactDisplayName({ name: null, email: 'ada@acme.example' })).toBe('ada@acme.example');
  });
});

describe('contacts by attendee address', () => {
  const contact = (id: string, email: string | null, emails: string[]) => ({
    id, name: id, title: null, organization_id: null, organization_name: null, email, emails,
  });

  it('sends each address once, trimmed and lower-cased, at most 25', () => {
    expect(contactLookupEmails([' Ada@Acme.example ', 'ada@acme.example', 'not an address', 'bo@b.example'])).toEqual(['ada@acme.example', 'bo@b.example']);
    expect(contactLookupEmails(Array.from({ length: 30 }, (_, index) => `p${index}@x.example`))).toHaveLength(25);
  });

  it('maps every address a contact holds to it, the first contact keeping a shared one', () => {
    const byAddress = contactsByAddress([
      contact('ada', 'Ada@acme.example', ['ada@acme.example', 'ada@home.example']),
      contact('bo', null, ['ada@home.example', 'bo@b.example']),
    ]);
    expect(byAddress.get('ada@acme.example')?.id).toBe('ada');
    expect(byAddress.get('ada@home.example')?.id).toBe('ada');
    expect(byAddress.get('bo@b.example')?.id).toBe('bo');
  });
});
