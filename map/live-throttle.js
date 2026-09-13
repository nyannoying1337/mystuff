// Loaded by the BlueMap webapp via webapp.conf `scripts`.
//
// BlueMap polls live player positions every second, which suits a server
// plugin but not a Worker on the free tier — and the agent only pushes every
// 20 seconds anyway. This slows the polling down and stops it entirely while
// the tab is hidden. It reaches into BlueMap's marker managers, which are not
// a public API: checked against BlueMap 5.24, the version render.py pins.
(() => {
  const PLAYER_POLL_MS = 15000;
  const MARKER_POLL_MS = 120000;

  function managers() {
    const app = window.bluemap;
    if (!app) return [];
    return [
      [app.playerMarkerManager, PLAYER_POLL_MS],
      [app.markerFileManager, MARKER_POLL_MS],
    ].filter(([manager]) => manager && !manager.disposed);
  }

  // Managers are recreated whenever the viewer switches maps, so keep checking.
  setInterval(() => {
    if (document.hidden) return;
    for (const [manager, ms] of managers()) {
      if (manager._updateIntervalMillis !== ms) manager.setAutoUpdateInterval(ms);
    }
  }, 2000);

  document.addEventListener("visibilitychange", () => {
    for (const [manager] of managers()) {
      if (document.hidden) manager.pauseAutoUpdates();
      else manager.resumeAutoUpdates();
    }
  });
})();
