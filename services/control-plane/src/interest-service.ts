// The interest requests, for the operator's console. An RPC
// entrypoint with no URL, like OpsService, but apart from it on purpose:
// OpsService returns metadata and never a name or an address
// (docs/OPS_CONSOLE.md §Metadata, never content). This one returns the people
// who asked for Starlings, so the console binds it on hq alone, where the
// product site files the form, as HQ_INTERESTS; the production check refuses
// any other binding of it.
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { SignupInterest } from '@starlings/contracts/signup';
import { interestByID, listInterests } from './interest';

const INTEREST_ID = /^int_[A-Za-z0-9_-]{8,64}$/u;

export class InterestService extends WorkerEntrypoint<Env> {
  /** The newest interest requests, newest first. */
  async interests(): Promise<SignupInterest[]> {
    return listInterests(this.env);
  }

  /** One interest request, which the console reads the address and prefill from before it mints a link. */
  async interest(id: string): Promise<SignupInterest | null> {
    return typeof id === 'string' && INTEREST_ID.test(id) ? interestByID(this.env, id) : null;
  }
}
