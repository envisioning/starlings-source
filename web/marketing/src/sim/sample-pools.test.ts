import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CALL_GUESTS, DEFAULT_PICK, SAMPLE_AGENT_NAMES, SAMPLE_CALLS, SAMPLE_PEOPLE, SAMPLE_WORKSPACES, composeMeeting, nextPick } from './sample-meeting';
import { SAMPLE_DAYS } from './sample-workspace';

const facesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../faces');

describe('sample meeting pools', () => {
  it('keeps each pool at its documented size with unique names and ids', () => {
    expect(SAMPLE_PEOPLE).toHaveLength(12);
    expect(new Set(SAMPLE_PEOPLE.map((person) => person.id)).size).toBe(12);
    expect(new Set(SAMPLE_PEOPLE.map((person) => person.name)).size).toBe(12);
    expect(SAMPLE_WORKSPACES).toHaveLength(12);
    expect(new Set(SAMPLE_WORKSPACES.map((workspace) => workspace.slug)).size).toBe(12);
    expect(new Set(SAMPLE_WORKSPACES.map((workspace) => workspace.name)).size).toBe(12);
    expect(SAMPLE_AGENT_NAMES).toHaveLength(10);
    expect(new Set(SAMPLE_AGENT_NAMES).size).toBe(10);
    expect(SAMPLE_CALLS).toHaveLength(6);
    expect(SAMPLE_DAYS).toHaveLength(SAMPLE_CALLS.length);
  });

  it('keeps both generated face frames for every person in the marketing assets', () => {
    for (const person of SAMPLE_PEOPLE) {
      expect(person.photo).toBe(`/faces/${person.id}.webp`);
      expect(person.selfie).toBe(`/faces/${person.id}-phone.webp`);
      expect(existsSync(resolve(facesDirectory, `${person.id}.webp`))).toBe(true);
      expect(existsSync(resolve(facesDirectory, `${person.id}-phone.webp`))).toBe(true);
    }
  });

  it('draws three different people and one agent for every call', () => {
    expect(DEFAULT_PICK.guests).toHaveLength(CALL_GUESTS);
    let pick = DEFAULT_PICK;
    for (let run = 0; run < 200; run += 1) {
      pick = nextPick(pick);
      expect(pick.guests).toHaveLength(CALL_GUESTS);
      expect(new Set([pick.host, ...pick.guests]).size).toBe(3);
      const meeting = composeMeeting(pick);
      expect(meeting.guests).toHaveLength(2);
      expect(typeof meeting.agent).toBe('string');
    }
  });
});
