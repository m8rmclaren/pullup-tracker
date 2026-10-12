import { describe, expect, it } from 'vitest';
import { reloadWhenUpdated } from '../src/app/updates';

function setup({ hasController = true, isEditing = false } = {}) {
  const serviceWorker = Object.assign(new EventTarget(), { controller: hasController ? ({} as ServiceWorker) : null });
  const state = { isEditing, reloads: 0, editingDone: [] as (() => void)[] };
  reloadWhenUpdated({
    serviceWorker,
    isEditing: () => state.isEditing,
    onEditingDone: (callback) => state.editingDone.push(callback),
    reload: () => state.reloads++,
  });
  const takeOver = () => serviceWorker.dispatchEvent(new Event('controllerchange'));
  const finishEditing = () => {
    state.isEditing = false;
    for (const callback of state.editingDone.splice(0)) callback();
  };
  return { state, takeOver, finishEditing };
}

describe('reloadWhenUpdated', () => {
  it('reloads once when a new build takes over from the one on screen', () => {
    const { state, takeOver } = setup();
    takeOver();
    takeOver();
    expect(state.reloads).toBe(1);
  });

  it('doesn’t reload on a first install, when there was no build to replace', () => {
    const { state, takeOver } = setup({ hasController: false });
    takeOver();
    expect(state.reloads).toBe(0);
  });

  it('waits for an open sheet to close before reloading', () => {
    const { state, takeOver, finishEditing } = setup({ isEditing: true });
    takeOver();
    expect(state.reloads).toBe(0);
    finishEditing();
    expect(state.reloads).toBe(1);
  });
});
