/**
 * Profile persistence. Kept deliberately thin: electron-store only moves bytes,
 * `sanitizePersistedProfiles` decides what is usable, and the controller owns
 * every mutation.
 */

import Store from "electron-store";

import { defaultPersistedProfiles, sanitizePersistedProfiles, type PersistedProfiles } from "@shared/profiles";

import type { ProfileStoreLike } from "./controller";

interface StoreShape {
  gateway: PersistedProfiles;
}

export class ElectronProfileStore implements ProfileStoreLike {
  private readonly store: Store<StoreShape>;

  constructor(store?: Store<StoreShape>) {
    this.store = store ?? new Store<StoreShape>({
      name: "gateway-profiles",
      defaults: { gateway: defaultPersistedProfiles() },
    });
  }

  async load(): Promise<PersistedProfiles> {
    return sanitizePersistedProfiles(this.store.get("gateway"), defaultPersistedProfiles());
  }

  async save(value: PersistedProfiles): Promise<void> {
    this.store.set("gateway", value);
  }
}