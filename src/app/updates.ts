export interface ReloadWhenUpdatedDeps {
  serviceWorker: Pick<ServiceWorkerContainer, 'controller' | 'addEventListener'>;
  /** True while the user is in the middle of something a reload would throw away, like an open sheet. */
  isEditing: () => boolean;
  /** Calls back once, when isEditing turns false. */
  onEditingDone: (callback: () => void) => void;
  reload: () => void;
}

/**
 * sw.js skips waiting and claims open pages, so a new build takes over in the background, but
 * the page on screen keeps running the old code until it reloads. On an iOS home-screen app
 * that meant two cold launches per deploy. This reloads as soon as the new worker takes over.
 * A first install has no previous controller and isn't an update, so it doesn't reload. Every
 * tap is persisted synchronously, so the reload itself loses nothing.
 */
export function reloadWhenUpdated(deps: ReloadWhenUpdatedDeps): void {
  if (!deps.serviceWorker.controller) return;
  let isReloading = false;
  const reloadOnce = () => {
    if (isReloading) return;
    isReloading = true;
    deps.reload();
  };
  deps.serviceWorker.addEventListener('controllerchange', () => (deps.isEditing() ? deps.onEditingDone(reloadOnce) : reloadOnce()));
}
