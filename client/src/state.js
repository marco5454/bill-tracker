// Lightweight in-memory cache + pub/sub. Modules subscribe and re-render on change.

import { api } from './api.js';

const listeners = new Set();

const state = {
  loaded: false,
  bills: [],
  credits: [],
  settings: { currency: '\u20b1' }
};

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn(state); } catch (err) { console.error(err); }
  }
}

export async function loadAll() {
  const [bills, credits, settings] = await Promise.all([
    api.listBills(),
    api.listCredits(),
    api.getSettings()
  ]);
  state.bills    = bills;
  state.credits  = credits;
  state.settings = settings;
  state.loaded   = true;
  emit();
}

export async function refreshBills() {
  state.bills = await api.listBills();
  emit();
}

export async function refreshCredits() {
  state.credits = await api.listCredits();
  emit();
}

export async function refreshSettings() {
  state.settings = await api.getSettings();
  emit();
}
