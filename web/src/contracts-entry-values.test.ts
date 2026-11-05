import { describe, expect, it } from 'vitest';
import roomEntryFixture from '../../fixtures/room-entry.json';
import searchRowsFixture from '../../fixtures/search-rows.json';
import { publicRoomResponseSchema, emailSchema } from '@starlings/contracts';
import { meetMintedBookingProjectionSchema } from '@starlings/contracts/calendar';
import { isValidEmailAddress } from '@starlings/contracts/email-values';
import { isMeetMintedBookingProjection, isPublicRoomResponse } from '@starlings/contracts/room-entry-values';
import { isSearchRow } from '@starlings/contracts/search-values';
import { searchRowSchema } from '@starlings/contracts/search';

describe('zod-free browser entry guards', () => {
  it('matches the room-entry schemas on their shared fixtures', () => {
    for (const example of roomEntryFixture.public_rooms) {
      const schemaAccepts = publicRoomResponseSchema.safeParse(example.value).success;
      expect(isPublicRoomResponse(example.value), example.name).toBe(schemaAccepts);
      expect(schemaAccepts, example.name).toBe(example.valid);
    }
    for (const example of roomEntryFixture.booking_projections) {
      const schemaAccepts = meetMintedBookingProjectionSchema.safeParse(example.value).success;
      expect(isMeetMintedBookingProjection(example.value), example.name).toBe(schemaAccepts);
      expect(schemaAccepts, example.name).toBe(example.valid);
    }
  });

  it('matches the search-row schema on the shared search fixture', () => {
    for (const row of searchRowsFixture.rows) {
      expect(isSearchRow(row)).toBe(searchRowSchema.safeParse(row).success);
    }
    for (const row of [null, [], { kind: 'room', id: 'mz', title: 'MZ', subtitle: '', door: 'room:mz' }]) {
      expect(isSearchRow(row)).toBe(searchRowSchema.safeParse(row).success);
    }
  });

  it('matches the shared email schema for guest identity input', () => {
    const values = [
      ' rosa@example.com ',
      'ana@example.co',
      'first.last+tag@sub.example.com',
      '',
      '.lead@example.net',
      'double..dot@example.net',
      'person@localhost',
      'person@example.c',
    ];
    for (const value of values) {
      expect(isValidEmailAddress(value), value).toBe(emailSchema.safeParse(value).success);
    }
  });
});
