// Loaded by the BlueMap webapp via webapp.conf `scripts`.
// Required by the Minecraft Usage Guidelines on every page using game assets.
(() => {
  const note = document.createElement("div");
  note.textContent = "NOT AN OFFICIAL MINECRAFT WEBSITE. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.";
  note.setAttribute("role", "note");
  Object.assign(note.style, {
    position: "fixed",
    left: "50%",
    bottom: "4px",
    transform: "translateX(-50%)",
    zIndex: "10001",
    maxWidth: "calc(100% - 16px)",
    padding: "2px 8px",
    font: "11px/1.4 system-ui, sans-serif",
    textAlign: "center",
    color: "#ffffff",
    background: "rgba(0, 0, 0, .55)",
    borderRadius: "3px",
    pointerEvents: "none",
  });
  document.body.append(note);
})();
